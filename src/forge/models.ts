import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * GLB downloads, shared by everything that shows a model. Forged fighters come meshopt-compressed with WebP
 * textures (forge/optimize.js), so the loader has the meshopt decoder; plain GLBs load the same way.
 *
 * preloadModel() starts a download as soon as a model is known (the fighter on the "Welcome back" card, the CPU's
 * pick, P2's choice), so it's often done by the time loadModel() asks for it; loadModel() never downloads twice.
 */
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const downloads = new Map<string, Promise<ArrayBuffer>>();
/** Preloaded downloads not yet used, kept at most (a few MB each at most; the oldest is dropped). */
const KEEP = 8;

/** Start downloading a model (no-op if it's already downloading or downloaded). Returns its bytes. */
export function preloadModel(url: string | undefined | null, priority: RequestPriority = 'low'): Promise<ArrayBuffer> | undefined {
  if (!url) return undefined;
  let download = downloads.get(url);
  if (!download) {
    download = fetch(url, { priority }).then((res) => {
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.arrayBuffer();
    });
    // A failed download is forgotten, so the next ask tries again.
    download.catch(() => downloads.get(url) === download && downloads.delete(url));
    downloads.set(url, download);
    while (downloads.size > KEEP) downloads.delete(downloads.keys().next().value!);
  }
  return download;
}

/** Download (or reuse the preloaded bytes) and parse a GLB. */
export async function loadModel(url: string): Promise<GLTF> {
  const download = preloadModel(url, 'high')!;
  const data = await download;
  // Parsed: let the bytes go (a later load comes from the browser's cache: forged GLBs are cached as immutable).
  if (downloads.get(url) === download) downloads.delete(url);
  return loader.parseAsync(data, url.slice(0, url.lastIndexOf('/') + 1));
}
