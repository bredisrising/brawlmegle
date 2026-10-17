// Runs in headless Chrome (driven by extract.mjs): the same MediaPipe PoseLandmarker the game uses,
// stepped frame by frame over a video, so clips give exactly the landmarks a camera would.
import { FilesetResolver, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Landmark, PoseFrame } from '../../src/types';

const MODELS: Record<string, string> = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  heavy: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
};

const toLandmark = (p: NormalizedLandmark): Landmark => ({
  x: round(p.x), y: round(p.y), z: round(p.z), visibility: round(p.visibility ?? 0),
});
const round = (v: number) => Math.round(v * 1e5) / 1e5;

/** Same choice as CameraSource: the pose whose hips are nearest the frame center. */
function centered(poses: NormalizedLandmark[][]) {
  let best = -1;
  let bestDistance = Infinity;
  poses.forEach((pose, i) => {
    const x = (pose[23].x + pose[24].x) / 2 - 0.5;
    const y = (pose[23].y + pose[24].y) / 2 - 0.5;
    if (x * x + y * y < bestDistance) [best, bestDistance] = [i, x * x + y * y];
  });
  return best;
}

async function extract(blobUrl: string, model: string, fps: number): Promise<(PoseFrame | { t: number; missing: true })[]> {
  const files = await FilesetResolver.forVisionTasks('/node_modules/@mediapipe/tasks-vision/wasm');
  const landmarker = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODELS[model], delegate: 'CPU' },
    runningMode: 'VIDEO',
    numPoses: 2,
  });
  const video = document.createElement('video');
  video.muted = true;
  video.src = blobUrl;
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('video failed to load'));
  });
  const aspect = video.videoWidth / video.videoHeight;
  const frames: (PoseFrame | { t: number; missing: true })[] = [];
  const count = Math.floor(video.duration * fps);
  for (let i = 0; i < count; i++) {
    const t = Math.round((i * 1000) / fps * 100) / 100;
    video.currentTime = (i + 0.5) / fps;
    await new Promise((resolve) => (video.onseeked = resolve));
    const result = landmarker.detectForVideo(video, t);
    const pick = centered(result.landmarks);
    if (pick < 0) frames.push({ t, missing: true });
    else frames.push({ t, aspect, image: result.landmarks[pick].map(toLandmark), world: result.worldLandmarks[pick].map(toLandmark) });
  }
  landmarker.close();
  return frames;
}

(window as unknown as { extract: typeof extract }).extract = extract;
(window as unknown as { ready: boolean }).ready = true;
