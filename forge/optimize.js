// Shrinks what the browser downloads for a fighter: the GLB's textures are resized and re-encoded as WebP, its
// geometry is quantized and meshopt-compressed, and the card and sheet get WebP copies. The Mixamo skeleton, the
// skin weights and every node name (mixamorig*) stay as they are, so the game drives the rig exactly as before.
// Why these sizes: research/perf-assets.md (side-by-side renders in the game's own lighting).
import fs from "node:fs";
import path from "node:path";
import { Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP } from "@gltf-transform/extensions";
import { dedup, listTextureSlots, prune, quantize, reorder } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

// The forge box is a t4g.micro with a 400 MB cap on the service: one image at a time, no libvips cache.
sharp.concurrency(1);
sharp.cache(false);

/**
 * Per texture slot: the longest side it's resized down to and the WebP quality. Fighters fill ~40% of the screen
 * (a bit more in the K.O. punch-in), where a 2048 base color is already sampled from its smaller mips.
 */
export const FIGHTER_TEXTURES = {
  baseColorTexture: { size: 2048, quality: 88 },
  normalTexture: { size: 1024, quality: 90 },
  default: { size: 1024, quality: 85 },
};

/**
 * @typedef {{size: number, quality?: number, lossless?: boolean}} TextureSetting
 * @typedef {{
 *   textures?: Record<string, TextureSetting>,
 *   geometry?: "meshopt" | "quantize" | "none",
 *   quantizePosition?: boolean,
 *   texcoordBits?: number,
 * }} GlbProfile
 */

/** @type {GlbProfile} */
/**
 * Positions stay float: quantizing them rescales the mesh's local units (folded into the skin), and the game's ink
 * outline is pushed out along the normals in those units, so it would come out thinner.
 */
export const FIGHTER = { textures: FIGHTER_TEXTURES, geometry: "meshopt", quantizePosition: false, texcoordBits: 14 };

let io;
async function getIO() {
  if (!io) {
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
    io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
  }
  return io;
}

/** Bytes a texture takes on the GPU once uploaded: RGBA8 plus its mip chain. */
const gpuBytes = (w, h) => Math.round(w * h * 4 * (4 / 3));

async function textureStats(doc) {
  const out = [];
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    const { width = 0, height = 0 } = await sharp(image).metadata().catch(() => ({}));
    out.push({ slots: listTextureSlots(texture), mime: texture.getMimeType(), bytes: image.byteLength, width, height, gpu: gpuBytes(width, height) });
  }
  return out;
}

/** True if this GLB already went through optimizeGlb (or was compressed some other way). */
function isOptimized(doc) {
  const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  return used.includes("EXT_meshopt_compression") || used.includes("EXT_texture_webp") || used.includes("KHR_texture_basisu");
}

/**
 * Optimizes a GLB. Returns null if it's already optimized (safe to run twice), else the new bytes and what changed.
 * @param {Uint8Array} input
 * @param {GlbProfile} profile
 */
export async function optimizeGlb(input, profile = FIGHTER) {
  const start = performance.now();
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(input));
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  if (isOptimized(doc)) return null;
  const before = await textureStats(doc);

  // Unused data only. Leaf nodes stay (end bones like mixamorig:Head have no children), and so do all attributes.
  await doc.transform(
    dedup({ keepUniqueNames: true }),
    prune({ keepLeaves: true, keepAttributes: true, keepIndices: true, keepSolidTextures: true, keepExtras: true }),
  );

  const settings = profile.textures ?? {};
  let webp = false;
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage();
    const mime = texture.getMimeType();
    if (!image || !["image/png", "image/jpeg", "image/webp"].includes(mime)) continue;
    const slots = listTextureSlots(texture);
    const setting = settings[slots.find((s) => settings[s]) ?? "default"];
    if (!setting) continue;
    const out = await sharp(image)
      .resize(setting.size, setting.size, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .webp(setting.lossless ? { lossless: true, effort: 4 } : { quality: setting.quality ?? 85, effort: 4, smartSubsample: true })
      .toBuffer();
    texture.setImage(new Uint8Array(out)).setMimeType("image/webp");
    if (texture.getURI()) texture.setURI(texture.getURI().replace(/\.(png|jpe?g)$/i, ".webp"));
    webp = true;
  }
  if (webp) doc.createExtension(EXTTextureWebP).setRequired(true);

  // Geometry: what gltf-transform's meshopt() does (reorder, quantize, EXT_meshopt_compression with filters), with
  // a choice of whether positions are quantized: that moves a dequantize transform onto the mesh's node (or a skin's
  // inverse bind matrices), which code that takes a mesh's geometry without its node would miss.
  const geometry = profile.geometry ?? "none";
  if (geometry !== "none") {
    const meshoptOn = geometry === "meshopt";
    const semantics = meshoptOn ? ["TEXCOORD", "JOINTS", "WEIGHTS", "COLOR"] : ["NORMAL", "TANGENT", "TEXCOORD", "JOINTS", "WEIGHTS", "COLOR"];
    if (profile.quantizePosition !== false) semantics.unshift("POSITION");
    if (meshoptOn) await doc.transform(reorder({ encoder: MeshoptEncoder, target: "size" }));
    await doc.transform(
      quantize({
        // With meshopt, normals stay float here and its octahedral filter packs them (8 bits).
        pattern: new RegExp(`^(${semantics.join("|")})(_\\d+)?$`),
        patternTargets: new RegExp(`^(${[...semantics, "NORMAL", "TANGENT"].join("|")})(_\\d+)?$`),
        quantizeTexcoord: profile.texcoordBits ?? 12,
      }),
    );
    if (meshoptOn) {
      doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    }
  }

  const glb = Buffer.from(await io.writeBinary(doc));
  return { glb, before, after: await textureStats(doc), bytesBefore: input.byteLength, bytesAfter: glb.byteLength, ms: Math.round(performance.now() - start) };
}

/**
 * A WebP copy of a card or sheet image, at most `width` x `height` (never enlarged).
 * @param {Uint8Array} input
 */
export async function optimizeImage(input, { width = 1024, height = 1536, quality = 85 } = {}) {
  return sharp(input).resize(width, height, { fit: "inside", withoutEnlargement: true }).webp({ quality, effort: 4 }).toBuffer();
}

/** Writes through a temp file and a rename, so the server never streams a half-written file. */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Card and sheet WebP copies: what the browser is sent (server.js points cardUrl/sheetUrl at them). */
export const IMAGE_COPIES = { "card.png": { width: 1024, height: 1536 }, "sheet.png": { width: 1024, height: 1536 } };

/**
 * Optimizes one fighter's files in place, in its folder: the GLB the game loads (rigged.glb, or model.glb when
 * rigging failed) is replaced by its optimized version, the original kept next to it as <name>.orig.glb, and the
 * card and sheet get .webp copies. Never throws: a fighter that can't be optimized just keeps its original files.
 * @param {string} dir  the fighter's folder (FORGE_DATA/<id>)
 * @param {{glbUrl?: string}} fighter
 */
export async function optimizeFighter(dir, fighter, { log = console.log } = {}) {
  const report = { glb: null, images: {} };
  const glbName = typeof fighter.glbUrl === "string" ? path.basename(fighter.glbUrl) : null;
  if (glbName && /^(rigged|model)\.glb$/.test(glbName)) {
    const file = path.join(dir, glbName);
    const backup = path.join(dir, glbName.replace(/\.glb$/, ".orig.glb"));
    try {
      // Always optimize from the original, so a rerun never compresses twice.
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
  for (const [name, size] of Object.entries(IMAGE_COPIES)) {
    const file = path.join(dir, name);
    const copy = file.replace(/\.png$/, ".webp");
    if (!fs.existsSync(file) || fs.existsSync(copy)) continue;
    try {
      const source = fs.readFileSync(file);
      const webp = await optimizeImage(source, size);
      writeAtomic(copy, webp);
      report.images[name] = { before: source.byteLength, after: webp.byteLength };
    } catch (err) {
      log(`optimize ${name} failed: ${err.message}`);
    }
  }
  return report;
}
