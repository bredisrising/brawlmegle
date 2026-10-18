/// <reference lib="webworker" />
import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import {
  WASM_ROOT, landmarkerOptions, selectCenteredPose, toLandmark,
  type PoseDelegate, type PoseVariant, type PoseWorkerReply, type PoseWorkerRequest,
} from './poseModel';

/**
 * MediaPipe pose detection off the main thread. detectForVideo is synchronous (with the GPU delegate it waits on
 * the GPU), so on the main thread every camera frame froze the game for the whole detection: 25 ms on a fast
 * laptop, 100+ ms on an integrated GPU busy drawing the fight. Here it only blocks this worker.
 *
 * One-pose mode (asked for by the quality governor as its last step, when even the lightest render leaves the
 * tracker short of the camera's rate): a second landmarker with numPoses 1, which follows the player from frame to
 * frame instead of re-running the person detector on every frame (31 instead of ~23 poses/s on a Radeon 780M). It
 * brings MediaPipe's own smoothing with it, which two-pose mode avoids on purpose, hence last. It also can't see who
 * else is in frame, so it keeps to the player the two-pose mode picked (the person nearest the center): a pose that
 * isn't where the player was, or is much smaller (someone walking past behind), is dropped, and a few of those in a
 * row, or a second without the player, hand back to two-pose mode until the player has been followed again.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
let landmarker: PoseLandmarker | null = null;
let files: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let delegate: PoseDelegate = 'GPU';
let variant: PoseVariant = 'full';
let numPoses = 2;
/** Model files handed over by the page (it preloads them at the title screen), so they aren't downloaded twice. */
const models = new Map<PoseVariant, Uint8Array>();

let single: PoseLandmarker | null = null;
let singleWanted = false;
let singleLoading = false;
/** Where the player is: hip center x and torso length (image units), from the poses accepted as theirs. */
const anchor = { x: 0.5, torso: 0, seenAt: -Infinity };
/** One-pose mode: poses in a row that weren't the player; frames of two-pose mode left before trying one-pose again. */
let rejected = 0;
let reacquire = 0;
const REJECTS_TO_REACQUIRE = 8;
const REACQUIRE_FRAMES = 45;
const LOST_MS = 1000;

const reply = (msg: PoseWorkerReply) => scope.postMessage(msg);

/**
 * A landmarker. MediaPipe clears self.ModuleFactory after each one it makes and reloads its loader for the next, but a
 * module import runs once, so the second (the switch to lite, the CPU fallback, one-pose mode) found nothing. Put the
 * cached loader's factory back first.
 */
async function create(v: PoseVariant, poses: number) {
  const g = scope as unknown as { ModuleFactory?: unknown };
  if (!g.ModuleFactory && files) {
    const loader = (await import(/* @vite-ignore */ files.wasmLoaderPath)) as { default?: unknown };
    g.ModuleFactory = loader.default;
  }
  return PoseLandmarker.createFromOptions(files!, landmarkerOptions(v, delegate, poses, models.get(v)));
}

/** Make the one-pose landmarker if it's wanted and missing (in the background: two-pose mode runs meanwhile). */
async function ensureSingle() {
  if (!singleWanted || single || singleLoading || !files) return;
  singleLoading = true;
  const forVariant = variant;
  try {
    const made = await create(forVariant, 1);
    if (!singleWanted || forVariant !== variant) made.close();
    else single = made;
  } catch (err) {
    console.warn('[pose] one-pose mode unavailable', err);
    singleWanted = false;
  } finally {
    singleLoading = false;
  }
  void ensureSingle(); // the variant changed meanwhile
}

const hipX = (p: NormalizedLandmark[]) => (p[23].x + p[24].x) / 2;
const torso = (p: NormalizedLandmark[]) =>
  Math.hypot((p[11].x + p[12].x - p[23].x - p[24].x) / 2, (p[11].y + p[12].y - p[23].y - p[24].y) / 2);

function isPlayer(p: NormalizedLandmark[]) {
  if (!p[23] || !p[24] || !p[11] || !p[12]) return false;
  if (!anchor.torso) return true;
  const t = torso(p);
  return Math.abs(hipX(p) - anchor.x) < 0.25 && t > anchor.torso * 0.55 && t < anchor.torso * 1.8;
}

function follow(p: NormalizedLandmark[], t: number) {
  if (!p[23] || !p[24] || !p[11] || !p[12]) return;
  anchor.x += (hipX(p) - anchor.x) * (anchor.torso ? 0.3 : 1);
  anchor.torso = anchor.torso ? anchor.torso + (torso(p) - anchor.torso) * 0.1 : torso(p);
  anchor.seenAt = t;
}

/** One frame: which landmarker runs it, and which pose (if any) is the player's. */
function detect(image: VideoFrame, t: number) {
  const oneMode = !!single && singleWanted && reacquire === 0;
  const result = (oneMode ? single! : landmarker!).detectForVideo(image, t);
  let pose = -1;
  if (oneMode) {
    const p = result.landmarks[0];
    if (p && isPlayer(p)) {
      pose = 0;
      rejected = 0;
    } else if (p && ++rejected >= REJECTS_TO_REACQUIRE) {
      reacquire = REACQUIRE_FRAMES;
      rejected = 0;
      console.info('[pose] one-pose mode lost the player to someone else in frame: finding them again with two');
    }
    if (pose < 0 && t - anchor.seenAt > LOST_MS && reacquire === 0) reacquire = REACQUIRE_FRAMES;
  } else {
    pose = selectCenteredPose(result.landmarks);
    // Back to one-pose mode once the player has been followed for a while.
    if (pose >= 0 && reacquire > 0) reacquire--;
  }
  if (pose >= 0) follow(result.landmarks[pose], t);
  return { result, pose };
}

scope.onmessage = async (e: MessageEvent<PoseWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'frame') {
    const started = performance.now();
    try {
      if (!landmarker) throw new Error('pose model not loaded');
      const { result, pose } = detect(msg.image, msg.t);
      const image = pose < 0 ? null : result.landmarks[pose]?.map(toLandmark) ?? null;
      const world = pose < 0 ? null : result.worldLandmarks[pose]?.map(toLandmark) ?? null;
      reply({ type: 'result', id: msg.id, t: msg.t, ms: performance.now() - started, image, world });
    } catch (err) {
      reply({ type: 'error', id: msg.id, error: String(err) });
    } finally {
      msg.image.close();
    }
  } else if (msg.type === 'init') {
    numPoses = msg.numPoses;
    delegate = msg.delegate;
    variant = msg.variant;
    if (msg.model) models.set(msg.variant, new Uint8Array(msg.model));
    try {
      // The ES-module build of the wasm loader: a module worker can't importScripts the classic one.
      files = await FilesetResolver.forVisionTasks(WASM_ROOT, true);
      try {
        landmarker = await create(variant, numPoses);
      } catch (err) {
        if (delegate === 'CPU') throw err;
        // No WebGL in this worker (or MediaPipe's GPU delegate won't start): the CPU delegate still works.
        delegate = 'CPU';
        landmarker = await create(variant, numPoses);
      }
      reply({ type: 'ready', delegate });
    } catch (err) {
      reply({ type: 'failed', error: String(err) });
    }
  } else if (msg.type === 'variant') {
    try {
      if (!files) throw new Error('not initialized');
      const next = await create(msg.variant, numPoses);
      landmarker?.close();
      landmarker = next;
      variant = msg.variant;
      single?.close();
      single = null;
      void ensureSingle();
      reply({ type: 'variant', variant: msg.variant, ok: true });
    } catch (err) {
      reply({ type: 'variant', variant: msg.variant, ok: false, error: String(err) });
    }
  } else if (msg.type === 'single') {
    singleWanted = msg.on && numPoses > 1;
    reacquire = rejected = 0;
    if (singleWanted) void ensureSingle();
    else {
      single?.close();
      single = null;
    }
  } else if (msg.type === 'close') {
    landmarker?.close();
    single?.close();
    landmarker = single = null;
    scope.close();
  }
};
