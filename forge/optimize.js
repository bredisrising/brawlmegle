// Shrinks what the browser downloads for a fighter: the GLB's textures are resized and re-encoded as WebP, its
// geometry is meshopt-compressed, and the card and sheet get WebP copies. The Mixamo skeleton, the skin weights and
// every node name (mixamorig*) stay as they are, so the game drives the rig exactly as before.
// Why these settings, with before/after renders in the game's own scene: research/perf-assets.md.
//
//   optimizeFighter(dir, fighter)  the forge pipeline (and optimize-all.js) on one fighter's folder; never throws
//   optimizeGlb(bytes, profile)    any GLB (vite.config.ts runs it on the arena at build time)
//
// Its packages (gltf-transform, meshoptimizer, sharp) load on first use, so the forge still starts without them
// (`cd forge && npm ci` installs them); fighters then just keep their original files.
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{size: number, quality?: number, lossless?: boolean}} TextureSetting
 * @typedef {{
 *   textures?: Record<string, TextureSetting>,
 *   geometry?: "meshopt" | "quantize" | "none",
 *   quantizePosition?: boolean,
 *   texcoordBits?: number,
 * }} GlbProfile
 */

/**
 * Forged fighters. Textures by slot: longest side and WebP quality. A fighter is ~40-90% of the screen height
 * (fight camera to K.O. replay close-up), where 2048 base color is indistinguishable from Tripo's 4096.
 * Positions stay float: quantizing them rescales the mesh's local units (folded into the skin), and the game's ink
 * outline is pushed out along the normals in those units, so it would come out thinner.
 * @type {GlbProfile}
 */
export const FIGHTER = {
  textures: {
    baseColorTexture: { size: 2048, quality: 88 },
    normalTexture: { size: 1024, quality: 90 },
    default: { size: 1024, quality: 85 },
  },
  geometry: "meshopt",
  quantizePosition: false,
  texcoordBits: 14,
};

/**
 * The arena's baked GLBs (models/*.glb): same texture size (they're sampled with nearest filtering, so resizing would
 * change the pixel look), 16-bit UVs so texel edges don't move, float positions (Hills.ts instances the bare
 * geometry without its node, and Arena.ts reads positions to fix inside-out parts).
 * @type {GlbProfile}
 */
export const ARENA = { textures: { default: { size: 4096, quality: 90 } }, geometry: "meshopt", quantizePosition: false, texcoordBits: 16 };

let depsPromise;
/** The optimizer's packages, loaded once on first use. */
function deps() {
  depsPromise ??= (async () => {
    const [core, extensions, functions, meshopt, sharp] = await Promise.all([
      import("@gltf-transform/core"),
      import("@gltf-transform/extensions"),
      import("@gltf-transform/functions"),
      import("meshoptimizer"),
      import("sharp").then((m) => m.default),
    ]);
    // The forge box is a t4g.micro (400 MB cap on the service): one thread, no libvips cache.
    sharp.concurrency(1);
    sharp.cache(false);
    await Promise.all([meshopt.MeshoptEncoder.ready, meshopt.MeshoptDecoder.ready]);
    const io = new core.NodeIO()
      .registerExtensions(extensions.ALL_EXTENSIONS)
      .registerDependencies({ "meshopt.encoder": meshopt.MeshoptEncoder, "meshopt.decoder": meshopt.MeshoptDecoder });
    return { ...core, ...extensions, ...functions, ...meshopt, sharp, io };
  })();
  depsPromise.catch(() => (depsPromise = undefined));
  return depsPromise;
}

/** Bytes a texture takes on the GPU once uploaded: RGBA8 plus its mip chain. */
const gpuBytes = (w, h) => Math.round(w * h * 4 * (4 / 3));

async function textureStats(doc, d) {
  const out = [];
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    const { width = 0, height = 0 } = await d.sharp(image).metadata().catch(() => ({}));
    out.push({ slots: d.listTextureSlots(texture), mime: texture.getMimeType(), bytes: image.byteLength, width, height, gpu: gpuBytes(width, height) });
  }
  return out;
}

/**
 * Optimizes a GLB. Returns null if it's already compressed (safe to run twice), else the new bytes and what changed.
 * @param {Uint8Array} input
 * @param {GlbProfile} profile
 */
export async function optimizeGlb(input, profile = FIGHTER) {
  const start = performance.now();
  const d = await deps();
  const doc = await d.io.readBinary(new Uint8Array(input));
  doc.setLogger(new d.Logger(d.Logger.Verbosity.WARN));
  const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  if (["EXT_meshopt_compression", "EXT_texture_webp", "KHR_texture_basisu", "KHR_draco_mesh_compression"].some((e) => used.includes(e))) return null;
  const before = await textureStats(doc, d);

  // Unused data only. Leaf nodes stay (end bones like mixamorig:Head have no children), and so do all attributes.
  await doc.transform(
    d.dedup({ keepUniqueNames: true }),
    d.prune({ keepLeaves: true, keepAttributes: true, keepIndices: true, keepSolidTextures: true, keepExtras: true }),
  );

  const settings = profile.textures ?? {};
  let webp = false;
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image || !["image/png", "image/jpeg"].includes(texture.getMimeType())) continue;
    const slots = d.listTextureSlots(texture);
    const setting = settings[slots.find((s) => settings[s]) ?? "default"];
    if (!setting) continue;
    const out = await d
      .sharp(image)
      .resize(setting.size, setting.size, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .webp(setting.lossless ? { lossless: true, effort: 4 } : { quality: setting.quality ?? 85, effort: 4, smartSubsample: true })
      .toBuffer();
    texture.setImage(new Uint8Array(out)).setMimeType("image/webp");
    if (texture.getURI()) texture.setURI(texture.getURI().replace(/\.(png|jpe?g)$/i, ".webp"));
    webp = true;
  }
  // three's GLTFLoader reads EXT_texture_webp with no setup.
  if (webp) doc.createExtension(d.EXTTextureWebP).setRequired(true);

  // Geometry: what gltf-transform's meshopt() does (reorder, quantize, EXT_meshopt_compression with filters), with a
  // choice of whether positions are quantized (see FIGHTER). The game's loader has the meshopt decoder (src/forge/models.ts).
  const geometry = profile.geometry ?? "none";
  if (geometry !== "none") {
    const meshoptOn = geometry === "meshopt";
    const semantics = meshoptOn ? ["TEXCOORD", "JOINTS", "WEIGHTS", "COLOR"] : ["NORMAL", "TANGENT", "TEXCOORD", "JOINTS", "WEIGHTS", "COLOR"];
    if (profile.quantizePosition !== false) semantics.unshift("POSITION");
    if (meshoptOn) await doc.transform(d.reorder({ encoder: d.MeshoptEncoder, target: "size" }));
    await doc.transform(
      d.quantize({
        // With meshopt, normals stay float here and its octahedral filter packs them (8 bits).
        pattern: new RegExp(`^(${semantics.join("|")})(_\\d+)?$`),
        patternTargets: new RegExp(`^(${[...semantics, "NORMAL", "TANGENT"].join("|")})(_\\d+)?$`),
        quantizeTexcoord: profile.texcoordBits ?? 12,
      }),
    );
    if (meshoptOn) {
      doc.createExtension(d.EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: d.EXTMeshoptCompression.EncoderMethod.FILTER });
    }
  }

  const glb = Buffer.from(await d.io.writeBinary(doc));
  return { glb, before, after: await textureStats(doc, d), bytesBefore: input.byteLength, bytesAfter: glb.byteLength, ms: Math.round(performance.now() - start) };
}

/**
 * A WebP copy of a card or sheet image, at most `width` x `height` (never enlarged).
 * @param {Uint8Array} input
 */
export async function optimizeImage(input, { width = 1024, height = 1536, quality = 85 } = {}) {
  const { sharp } = await deps();
  return sharp(input).resize(width, height, { fit: "inside", withoutEnlargement: true }).webp({ quality, effort: 4 }).toBuffer();
}

/** Writes through a temp file and a rename, so the server never streams a half-written file. */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * WebP copies browsers get instead of the PNGs (server.js points cardUrl/sheetUrl at them). The card fills the VS
 * screen's half (~92% of the height), so it keeps its 1024x1536; the sheet is only a preview while forging.
 */
export const IMAGE_COPIES = { "card.png": { width: 1024, height: 1536, quality: 85 }, "sheet.png": { width: 1024, height: 1536, quality: 80 } };

/** One optimization at a time in this process: each peaks at ~200 MB and up to 3 forges can finish together. */
let queue = Promise.resolve();

/**
 * Optimizes one fighter's files in place, in its folder: the GLB the game loads (rigged.glb, or model.glb when
 * rigging failed) is replaced by its optimized version, the original kept next to it as <name>.orig.glb, and the
 * card and sheet get .webp copies. A fighter that already has its backup is skipped unless `force` (then it's redone
 * from the original). Never throws: a fighter that can't be optimized keeps its original files.
 * @param {string} dir  the fighter's folder (FORGE_DATA/<id>)
 * @param {{glbUrl?: string}} fighter
 */
export function optimizeFighter(dir, fighter, { force = false, log = console.warn } = {}) {
  const run = queue.then(() => optimizeFighterNow(dir, fighter, { force, log }));
  queue = run.catch(() => {});
  return run;
}

async function optimizeFighterNow(dir, fighter, { force, log }) {
  const report = { glb: null, images: {} };
  try {
    await deps();
  } catch (err) {
    log(`fighter optimizer unavailable (cd forge && npm ci): ${err.message}`);
    return report;
  }
  const glbName = typeof fighter.glbUrl === "string" ? path.basename(fighter.glbUrl) : null;
  if (glbName && /^(rigged|model)\.glb$/.test(glbName)) {
    const file = path.join(dir, glbName);
    const backup = path.join(dir, glbName.replace(/\.glb$/, ".orig.glb"));
    if (force || !fs.existsSync(backup)) {
      try {
        // Always from the original, so a rerun never compresses twice.
        const source = fs.readFileSync(fs.existsSync(backup) ? backup : file);
        const result = await optimizeGlb(source);
        if (result && result.bytesAfter < result.bytesBefore) {
          if (!fs.existsSync(backup)) writeAtomic(backup, source);
          writeAtomic(file, result.glb);
          report.glb = { file: glbName, before: result.bytesBefore, after: result.bytesAfter, ms: result.ms };
        }
      } catch (err) {
        log(`optimize ${glbName} failed, keeping the original: ${err.message}`);
      }
    }
  }
  for (const [name, settings] of Object.entries(IMAGE_COPIES)) {
    const file = path.join(dir, name);
    const copy = file.replace(/\.png$/, ".webp");
    if (!fs.existsSync(file) || (fs.existsSync(copy) && !force)) continue;
    try {
      const source = fs.readFileSync(file);
      const webp = await optimizeImage(source, settings);
      writeAtomic(copy, webp);
      report.images[name] = { before: source.byteLength, after: webp.byteLength };
    } catch (err) {
      log(`optimize ${name} failed: ${err.message}`);
    }
  }
  return report;
}
