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
    __q?: {
      game: Game; store: typeof useGameStore; setCamHidden: typeof setCamHidden; camView: typeof camView; frames: (s: MediaStream) => Promise<number>;
      setHidden: (hidden: boolean) => void; kos: () => number; notices: string[];
    };
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

/** Plays a received stream and resolves with its picture width once frames arrive (0 if none in 20 s). */
async function frames(stream: MediaStream) {
  const v = document.createElement('video');
  v.muted = true;
  v.srcObject = stream;
  void v.play().catch(() => {}); // not awaited: with no frames yet it can stay pending for good
  const start = performance.now();
  while (v.videoWidth === 0 && performance.now() - start < 20_000) await new Promise((r) => setTimeout(r, 100));
  const w = v.videoWidth;
  v.srcObject = null;
  return w;
}

// A fake tab switch: document.visibilityState / hidden as the test says, and the event the browser would fire.
let hidden = false;
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
const setHidden = (h: boolean) => {
  hidden = h;
  document.dispatchEvent(new Event('visibilitychange'));
};

// Every K.O. screen this laptop reached (a result is only posted from one): a called-off match must not reach one.
let kos = 0;
useGameStore.subscribe((s, prev) => {
  if (s.phase === 'ko' && prev.phase !== 'ko') kos++;
});

// Every notice shown here (they hide after a few seconds; a stalled test page can miss one by polling).
const notices: string[] = [];
useGameStore.subscribe((s, prev) => {
  if (s.notice && s.notice !== prev.notice) notices.push(s.notice.text);
});

window.__q = { game, store: useGameStore, setCamHidden, camView, frames, setHidden, kos: () => kos, notices };

// The longest the page's event loop went without a turn (software WebGL compiling shaders can block it for seconds).
let lastTick = performance.now();
let maxGap = 0;
setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - lastTick);
  lastTick = now;
}, 100);
(window as unknown as { __gap: () => number }).__gap = () => Math.round(maxGap);
