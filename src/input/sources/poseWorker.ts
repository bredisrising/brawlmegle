/// <reference lib="webworker" />
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import {
  WASM_ROOT, landmarkerOptions, selectCenteredPose, toLandmark,
  type PoseDelegate, type PoseVariant, type PoseWorkerReply, type PoseWorkerRequest,
} from './poseModel';

/**
 * MediaPipe pose detection off the main thread. detectForVideo is synchronous (with the GPU delegate it waits on
 * the GPU), so on the main thread every camera frame froze the game for the whole detection: 25 ms on a fast
 * laptop, 100+ ms on an integrated GPU busy drawing the fight. Here it only blocks this worker.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
let landmarker: PoseLandmarker | null = null;
let files: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let delegate: PoseDelegate = 'GPU';
let numPoses = 2;

const reply = (msg: PoseWorkerReply) => scope.postMessage(msg);

/**
 * A landmarker for `variant`. MediaPipe clears self.ModuleFactory after each one it makes and reloads its loader for
 * the next, but a module import runs once, so the second (the switch to lite, or the CPU fallback) found nothing.
 * Put the cached loader's factory back first.
 */
async function create(variant: PoseVariant) {
  const g = scope as unknown as { ModuleFactory?: unknown };
  if (!g.ModuleFactory && files) {
    const loader = (await import(/* @vite-ignore */ files.wasmLoaderPath)) as { default?: unknown };
    g.ModuleFactory = loader.default;
  }
  return PoseLandmarker.createFromOptions(files!, landmarkerOptions(variant, delegate, numPoses));
}

scope.onmessage = async (e: MessageEvent<PoseWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'frame') {
    const started = performance.now();
    try {
      if (!landmarker) throw new Error('pose model not loaded');
      const result = landmarker.detectForVideo(msg.image, msg.t);
      const selected = selectCenteredPose(result.landmarks);
      const image = selected < 0 ? null : result.landmarks[selected]?.map(toLandmark) ?? null;
      const world = selected < 0 ? null : result.worldLandmarks[selected]?.map(toLandmark) ?? null;
      reply({ type: 'result', id: msg.id, t: msg.t, ms: performance.now() - started, image, world });
    } catch (err) {
      reply({ type: 'error', id: msg.id, error: String(err) });
    } finally {
      msg.image.close();
    }
  } else if (msg.type === 'init') {
    numPoses = msg.numPoses;
    delegate = msg.delegate;
    try {
      // The ES-module build of the wasm loader: a module worker can't importScripts the classic one.
      files = await FilesetResolver.forVisionTasks(WASM_ROOT, true);
      try {
        landmarker = await create(msg.variant);
      } catch (err) {
        if (delegate === 'CPU') throw err;
        // No WebGL in this worker (or MediaPipe's GPU delegate won't start): the CPU delegate still works.
        delegate = 'CPU';
        landmarker = await create(msg.variant);
      }
      reply({ type: 'ready', delegate });
    } catch (err) {
      reply({ type: 'failed', error: String(err) });
    }
  } else if (msg.type === 'variant') {
    try {
      if (!files) throw new Error('not initialized');
      const next = await create(msg.variant);
      landmarker?.close();
      landmarker = next;
      reply({ type: 'variant', variant: msg.variant, ok: true });
    } catch (err) {
      reply({ type: 'variant', variant: msg.variant, ok: false, error: String(err) });
    }
  } else if (msg.type === 'close') {
    landmarker?.close();
    landmarker = null;
    scope.close();
  }
};
