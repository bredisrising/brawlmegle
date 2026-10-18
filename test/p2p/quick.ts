import { config } from '../../src/config';
import { camView } from '../../src/game/CameraShare';
import { Game } from '../../src/game/Game';
import { setCamHidden, useGameStore } from '../../src/game/store';

/**
 * One player's laptop for the matchmaking test (test/p2p.mjs opens two of these, in separate browser profiles): a real
 * Game against the test matchmaker, with the mock forge and a fake camera (an animated canvas) for the video share.
 * The runner drives it through window.__q.
 */
declare global {
  interface Window {
    __q?: { game: Game; store: typeof useGameStore; setCamHidden: typeof setCamHidden; camView: typeof camView; frames: (s: MediaStream) => Promise<number> };
  }
}

const params = new URLSearchParams(location.search);
config.signalUrl = params.get('signal') ?? '';
config.forgeApi = '';

const container = document.createElement('div');
container.style.cssText = 'width: 320px; height: 180px';
document.body.append(container);
const game = new Game(container);
// Two Games share this machine's CPU (software WebGL): draw the scene at the covered-screen rate. Everything else
// (ticks, the network, the camera share) runs as usual.
Object.defineProperty(game.renderer, 'covered', { get: () => true, set: () => {} });

// The fake camera: a moving square, so the video track has frames to send.
const canvas = document.createElement('canvas');
canvas.width = 320;
canvas.height = 240;
const ctx = canvas.getContext('2d')!;
let x = 0;
setInterval(() => {
  ctx.fillStyle = '#123';
  ctx.fillRect(0, 0, 320, 240);
  ctx.fillStyle = params.get('color') ?? '#ff2d95';
  ctx.fillRect((x = (x + 7) % 280), 100, 40, 40);
}, 66);
game.cameraOverride = canvas.captureStream(15);

/** Plays a received stream and resolves with its picture width once frames arrive (0 if none in 8 s). */
async function frames(stream: MediaStream) {
  const v = document.createElement('video');
  v.muted = true;
  v.srcObject = stream;
  await v.play().catch(() => {});
  const start = performance.now();
  while (v.videoWidth === 0 && performance.now() - start < 8000) await new Promise((r) => setTimeout(r, 100));
  const w = v.videoWidth;
  v.srcObject = null;
  return w;
}

window.__q = { game, store: useGameStore, setCamHidden, camView, frames };
