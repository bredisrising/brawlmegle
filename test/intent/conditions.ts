// The play conditions the reader has to survive: camera placement, sitting or standing, frame rate,
// body shape, stance and fast combos. Each one is a synthetic clip setup (see synth.ts).
import type { SynthOptions } from './synth';

export type Condition = { name: string; options: SynthOptions };

export const CONDITIONS: Condition[] = [
  { name: 'standing, facing', options: {} },
  { name: 'standing, camera 25° left', options: { cameraYaw: 25 } },
  { name: 'standing, camera 45° left', options: { cameraYaw: 45 } },
  { name: 'standing, camera 30° right', options: { cameraYaw: -30 } },
  { name: 'camera low, looking up', options: { cameraHeight: 0.75, lookAt: 1.35, distance: 2.2 } },
  { name: 'camera high, looking down', options: { cameraHeight: 2.0, lookAt: 1.1, distance: 2.2 } },
  { name: 'standing close, hips at edge', options: { distance: 1.1, cameraHeight: 1.45 } },
  { name: 'sitting at a laptop', options: { sitting: true } },
  { name: 'sitting, laptop low, 20° off', options: { sitting: true, cameraHeight: 0.85, lookAt: 1.05, cameraYaw: 20 } },
  { name: 'sitting, 15 fps', options: { sitting: true, fps: 15 } },
  { name: 'standing, 15 fps', options: { fps: 15 } },
  { name: 'standing, 24 fps', options: { fps: 24 } },
  { name: 'standing, 60 fps', options: { fps: 60 } },
  { name: 'webcam: 20% drops, jitter', options: { dropRate: 0.2, jitterMs: 10 } },
  { name: 'bad lighting (noise x2)', options: { noise: 2 } },
  { name: 'small body, short arms', options: { body: { height: 0.88, arm: 0.9, shoulders: 0.9 } } },
  { name: 'tall, long arms, broad', options: { body: { height: 1.1, arm: 1.08, shoulders: 1.15 } } },
  { name: 'orthodox stance', options: { stance: 'orthodox' } },
  { name: 'southpaw stance', options: { stance: 'southpaw' } },
  { name: 'handheld phone, standing', options: { cameraShake: 1, distance: 2.0 } },
  { name: 'handheld phone, sitting', options: { cameraShake: 1, sitting: true } },
  { name: 'shaky handheld, sitting 24 fps', options: { cameraShake: 2, sitting: true, fps: 24 } },
  { name: 'fast combos, standing', options: { combos: 0.7 } },
  { name: 'fast combos, standing 24 fps', options: { combos: 0.7, fps: 24 } },
  { name: 'fast combos, sitting 15 fps', options: { combos: 0.7, sitting: true, fps: 15 } },
];
