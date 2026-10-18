/// <reference lib="webworker" />
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';

/**
 * Simplified index buffers of the hill mesh, one per allowed error (model units), for the far rows of hills. Off the
 * main thread: each takes ~100+ ms. Seams in the baked texture are weighed in (the uv metric), and the mesh isn't
 * welded (every tree is its own little part), so it needs Permissive to merge anything at all.
 */
export type HillsLodRequest = { index: Uint32Array; position: Float32Array; uv: Float32Array; errors: number[] };
export type HillsLodReply = { indices: (Uint32Array | null)[] };

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e: MessageEvent<HillsLodRequest>) => {
  const { index, position, uv, errors } = e.data;
  const indices: (Uint32Array | null)[] = [];
  try {
    await MeshoptSimplifier.ready;
    for (const error of errors) {
      const [lod] = MeshoptSimplifier.simplifyWithAttributes(index, position, 3, uv, 2, [1, 1], null, 0, error, ['Permissive', 'ErrorAbsolute']);
      // Not worth a second index buffer for less than a 10% cut.
      indices.push(lod.length < index.length * 0.9 ? lod : null);
    }
  } catch {
    // Keep whatever was done; the rest stay at full detail.
  }
  const reply: HillsLodReply = { indices };
  scope.postMessage(reply, indices.flatMap((i) => (i ? [i.buffer] : [])));
};
