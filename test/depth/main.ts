// Depth spike: can a monocular depth model (Depth Anything V2 Small, in a Worker) see a straight punch coming
// at the camera, live, next to MediaPipe? Webcam -> CameraSource (pose) -> every Nth frame a small bitmap goes
// to the depth worker, which samples depth at the landmarks. Plots the scale-free toward-camera signal next to
// MediaPipe's world z. Run `npm run dev` and open /test/depth/ (?res=336&every=2&device=auto&dtype=fp16, ?bench=1 for depth only).
import { CameraSource } from '../../src/input/sources/CameraSource';
import type { PoseFrame } from '../../src/types';
import type { DepthMsg, DeviceChoice, ErrorMsg, FrameMsg, InitMsg, ReadyMsg } from './depthWorker';
import { TowardSignal, samplePoints, type SampleSpec } from './signal';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const RES = Number(params.get('res') ?? 336);
const EVERY = Math.max(1, Number(params.get('every') ?? 2));
const DEVICE = (params.get('device') ?? 'auto') as DeviceChoice;
/** ?bench=1: no camera or MediaPipe, just run the depth model back to back on a synthetic frame. */
const BENCH = params.get('bench') === '1';
const DTYPE = (params.get('dtype') ?? undefined) as InitMsg['dtype'];
/** ?power=low-power to put the depth model on the integrated GPU of a dual-GPU laptop. */
const POWER = (params.get('power') ?? undefined) as InitMsg['power'];
const WINDOW_MS = 8000;
const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [0, 11], [0, 12]];

$<HTMLSelectElement>('res').value = String(RES);
$<HTMLSelectElement>('device').value = DEVICE;
$<HTMLSelectElement>('every').value = String(EVERY);
for (const id of ['res', 'device', 'every']) {
  $<HTMLSelectElement>(id).onchange = (e) => {
    params.set(id, (e.target as HTMLSelectElement).value);
    location.search = params.toString();
  };
}

type Entry = PoseFrame & { depth?: Omit<DepthMsg, 'type' | 'map'> & { toward: { L: number; R: number } } };
type Point = { t: number; v: number };

let camera: CameraSource | null = null;
let worker: Worker | null = null;
let ready: ReadyMsg | null = null;
let busy = false;
let frameN = 0;
let lastFrame: PoseFrame | null = null;
let lastDepth: DepthMsg | null = null;
let lastPoints: Record<string, SampleSpec> | null = null;
const signal = new TowardSignal();
let overlay = params.get('overlay') === '1';
let recording: Entry[] | null = null;
let workerError = '';
const pending = new Map<number, Entry>();
const poseTimes: number[] = [];
const depthTimes: number[] = [];
let depthMs = 0;
let depthTotalMs = 0;
const series = { depthL: [] as Point[], depthR: [] as Point[], mpL: [] as Point[], mpR: [] as Point[] };
let mapCanvas: HTMLCanvasElement | null = null;

// --- camera + depth worker -----------------------------------------------------------------------

$('camera').onclick = () => start();
$('overlay').onclick = () => {
  overlay = !overlay;
  $('overlay').classList.toggle('on', overlay);
};
$('overlay').classList.toggle('on', overlay);
$('record').onclick = toggleRecord;
if (BENCH) startBench();
else start();

async function start() {
  if (camera) return;
  setStatus('starting camera and MediaPipe…');
  // ?depth=off: MediaPipe alone, to see what the depth model costs it.
  if (!worker && params.get('depth') !== 'off') startWorker();
  camera = new CameraSource();
  try {
    await camera.start();
  } catch (err) {
    setStatus(`camera didn't start (${(err as Error).message})`, 'allow camera access, then click Start camera');
    camera = null;
    return;
  }
  $<HTMLVideoElement>('video').srcObject = camera.video.srcObject;
  const view = $<HTMLCanvasElement>('view');
  view.width = camera.video.videoWidth || 640;
  view.height = camera.video.videoHeight || 480;
  $<HTMLButtonElement>('record').disabled = false;
  $('camera').textContent = 'Camera on';
  camera.onFrame(onPose);
  requestAnimationFrame(draw);
  // Logged for automated runs (headless Chrome reads the console).
  setInterval(() => console.info(`live: ${$('status').innerText.replace(/\n/g, ' | ')}`), 5000);
}

function startWorker() {
  worker = new Worker(new URL('./depthWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<ReadyMsg | DepthMsg | ErrorMsg>) => {
    const msg = event.data;
    if (msg.type === 'ready') {
      ready = msg;
      console.info(`depth model ready on ${msg.device} (${msg.dtype}) in ${Math.round(msg.loadMs)} ms`);
    } else if (msg.type === 'depth') onDepth(msg);
    else {
      workerError = msg.message;
      busy = false;
      console.error('depth worker:', msg.message);
    }
  };
  worker.onerror = (e) => {
    workerError = e.message || 'worker failed';
  };
  worker.postMessage({ type: 'init', device: DEVICE, dtype: DTYPE, power: POWER } satisfies InitMsg);
}

function depthSize(w: number, h: number) {
  // Long side = RES; both sides multiples of 14 (the ViT patch size).
  const long = Math.round(RES / 14) * 14;
  const short = Math.max(14, Math.round((long * Math.min(w, h)) / Math.max(w, h) / 14) * 14);
  return w >= h ? { w: long, h: short } : { w: short, h: long };
}

function onPose(frame: PoseFrame) {
  const now = performance.now();
  lastFrame = frame;
  poseTimes.push(now);
  const entry: Entry = { ...frame };
  recording?.push(entry);
  // MediaPipe's view: wrist ahead of the shoulder in meters (world z is negative toward the camera).
  const w = frame.world;
  push(series.mpL, frame.t, -(w[15].z - w[11].z));
  push(series.mpR, frame.t, -(w[16].z - w[12].z));

  frameN++;
  if (!ready || busy || !worker || !camera || frameN % EVERY !== 0) return;
  const video = camera.video;
  const size = depthSize(video.videoWidth, video.videoHeight);
  const points = samplePoints(frame.image, frame.aspect ?? video.videoWidth / video.videoHeight);
  busy = true;
  pending.set(frame.t, entry);
  createImageBitmap(video, { resizeWidth: size.w, resizeHeight: size.h, resizeQuality: 'medium' })
    .then((bitmap) => {
      const msg: FrameMsg = { type: 'frame', t: frame.t, bitmap, points, wantMap: overlay };
      lastPoints = points;
      worker!.postMessage(msg, [bitmap]);
    })
    .catch((err) => {
      busy = false;
      pending.delete(frame.t);
      console.warn('createImageBitmap failed', err);
    });
}

function onDepth(msg: DepthMsg) {
  busy = false;
  if (BENCH) queueMicrotask(benchFrame);
  lastDepth = msg;
  depthTimes.push(performance.now());
  // Smoothed timings (start from the first value so the readout isn't low at first).
  depthMs = depthMs ? depthMs + 0.1 * (msg.ms - depthMs) : msg.ms;
  depthTotalMs = depthTotalMs ? depthTotalMs + 0.1 * (msg.totalMs - depthTotalMs) : msg.totalMs;
  const toward = signal.update(msg.samples, msg.pct);
  push(series.depthL, msg.t, toward.L);
  push(series.depthR, msg.t, toward.R);
  const entry = pending.get(msg.t);
  pending.delete(msg.t);
  if (entry) {
    const { type: _type, map: _map, ...rest } = msg;
    entry.depth = { ...rest, toward };
  }
  for (const t of pending.keys()) if (t < msg.t) pending.delete(t);
  if (msg.map) paintMap(msg.map, msg.w, msg.h);
}

// --- bench mode ----------------------------------------------------------------------------------

function startBench() {
  startWorker();
  // Logged for automated runs (headless Chrome reads the console).
  setInterval(() => ready && console.info(`bench ${ready.device} ${ready.dtype} ${RES}px: ${depthMs.toFixed(1)} ms model, ${depthTotalMs.toFixed(1)} ms total, ${depthTimes.length} fps`), 5000);
  setStatus('bench: loading depth model…');
  requestAnimationFrame(draw);
  const wait = setInterval(() => {
    if (!ready) return;
    clearInterval(wait);
    benchFrame();
  }, 100);
}

const benchCanvas = document.createElement('canvas');
function benchFrame() {
  if (!worker || busy) return;
  const size = depthSize(640, 480);
  benchCanvas.width = 640;
  benchCanvas.height = 480;
  const c = benchCanvas.getContext('2d')!;
  const g = c.createRadialGradient(320, 200, 20, 320, 240, 400);
  g.addColorStop(0, '#d9a07a');
  g.addColorStop(1, '#203040');
  c.fillStyle = g;
  c.fillRect(0, 0, 640, 480);
  busy = true;
  const points = { nose: { x: 0.5, y: 0.4, r: 0.012, q: 0.5 }, lHand: { x: 0.6, y: 0.6, r: 0.08, q: 0.9 } };
  createImageBitmap(benchCanvas, { resizeWidth: size.w, resizeHeight: size.h }).then((bitmap) => {
    worker!.postMessage({ type: 'frame', t: performance.now(), bitmap, points, wantMap: false } satisfies FrameMsg, [bitmap]);
  });
}

function push(list: Point[], t: number, v: number) {
  list.push({ t, v });
  while (list.length && t - list[0].t > WINDOW_MS) list.shift();
}

// --- recording -----------------------------------------------------------------------------------

function toggleRecord() {
  const button = $<HTMLButtonElement>('record');
  if (!recording) {
    recording = [];
    button.textContent = 'Stop + download';
    button.classList.add('on');
    return;
  }
  const frames = recording;
  recording = null;
  button.textContent = 'Record';
  button.classList.remove('on');
  const header = { clip: 'depth-spike', model: 'onnx-community/depth-anything-v2-small', device: ready?.device, dtype: ready?.dtype, res: RES, every: EVERY, frames: frames.length, ua: navigator.userAgent };
  const round = (x: number) => Math.round(x * 1e5) / 1e5;
  const lines = [JSON.stringify(header), ...frames.map((f) => JSON.stringify(f, (_k, v) => (typeof v === 'number' ? round(v) : v)))];
  const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `depth-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// --- drawing -------------------------------------------------------------------------------------

function paintMap(map: Uint8Array, w: number, h: number) {
  if (!mapCanvas) mapCanvas = document.createElement('canvas');
  mapCanvas.width = w;
  mapCanvas.height = h;
  const ctx = mapCanvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < map.length; i++) {
    const [r, g, b] = turbo(map[i] / 255);
    img.data[4 * i] = r;
    img.data[4 * i + 1] = g;
    img.data[4 * i + 2] = b;
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Cheap turbo-like colormap: far = dark blue, near = red. */
function turbo(x: number): [number, number, number] {
  const r = 34.61 + x * (1172.33 - x * (10793.56 - x * (33300.12 - x * (38394.49 - x * 14825.05))));
  const g = 23.31 + x * (557.33 + x * (1225.33 - x * (3574.96 - x * (1073.77 + x * 707.56))));
  const b = 27.2 + x * (3211.1 - x * (15327.97 - x * (27814 - x * (22569.18 - x * 6838.66))));
  return [r, g, b].map((v) => Math.max(0, Math.min(255, v))) as [number, number, number];
}

function draw() {
  requestAnimationFrame(draw);
  const now = performance.now();
  while (poseTimes.length && now - poseTimes[0] > 1000) poseTimes.shift();
  while (depthTimes.length && now - depthTimes[0] > 1000) depthTimes.shift();

  const view = $<HTMLCanvasElement>('view');
  const ctx = view.getContext('2d')!;
  ctx.clearRect(0, 0, view.width, view.height);
  if (overlay && mapCanvas) {
    ctx.globalAlpha = 0.75;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mapCanvas, 0, 0, view.width, view.height);
    ctx.globalAlpha = 1;
  }
  if (lastFrame) {
    const pts = lastFrame.image;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 3;
    for (const [a, b] of BONES) {
      ctx.beginPath();
      ctx.moveTo(pts[a].x * view.width, pts[a].y * view.height);
      ctx.lineTo(pts[b].x * view.width, pts[b].y * view.height);
      ctx.stroke();
    }
  }
  if (lastPoints) {
    for (const [name, p] of Object.entries(lastPoints)) {
      const r = p.r * view.width;
      ctx.strokeStyle = name.endsWith('Hand') ? '#ffd34d' : name === 'nose' || name.endsWith('Shoulder') ? '#4ade80' : '#94a3b8';
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x * view.width - r, p.y * view.height - r, 2 * r, 2 * r);
    }
  }

  drawPlot('plotL', series.depthL, series.mpL, now);
  drawPlot('plotR', series.depthR, series.mpR, now);
  const last = (list: Point[]) => (list.length ? list[list.length - 1].v : NaN);
  // The person's left hand shows on the image right; the view is mirrored, so it looks like a mirror.
  setArm('armL', last(series.depthL));
  setArm('armR', last(series.depthR));

  const stats = camera?.stats;
  const depthLine = workerError
    ? `depth error: ${workerError}`
    : ready
      ? `depth ${depthTimes.length} fps · ${depthMs.toFixed(0)} ms model (${depthTotalMs.toFixed(0)} ms total) · ${ready.device} ${ready.dtype} · ${lastDepth ? `${lastDepth.w}×${lastDepth.h}` : RES}`
      : 'loading depth model (~50 MB first time)…';
  if (BENCH && ready) setStatus(`bench: depth ${depthTimes.length} fps · ${depthMs.toFixed(0)} ms model (${depthTotalMs.toFixed(0)} ms total)`, depthLine);
  if (camera && stats) {
    setStatus(`pose ${poseTimes.length} fps · depth ${ready ? depthTimes.length : '…'} fps`, `${depthLine}<br>MediaPipe ${stats.detectMs.toFixed(0)} ms · camera ${stats.width}×${stats.height} @ ${stats.fps.toFixed(0)}${recording ? ` · <b style="color:#f87171">REC ${recording.length}</b>` : ''}`);
  }
}

function setArm(id: string, v: number) {
  const el = $(id);
  el.querySelector('b')!.textContent = Number.isFinite(v) ? v.toFixed(2) : '–';
  el.classList.toggle('hot', v > 0.25);
}

function setStatus(main: string, sub = '') {
  $('status').innerHTML = `${main}<span class="sub">${sub}</span>`;
}

function drawPlot(id: string, depth: Point[], mp: Point[], now: number) {
  const canvas = $<HTMLCanvasElement>(id);
  const ctx = canvas.getContext('2d')!;
  const { width: W, height: H } = canvas;
  ctx.clearRect(0, 0, W, H);
  const tEnd = lastFrame?.t ?? now;
  const x = (t: number) => W - ((tEnd - t) / WINDOW_MS) * W;
  ctx.strokeStyle = '#2a2d35';
  ctx.lineWidth = 1;
  for (let s = 1; s < WINDOW_MS / 1000; s++) {
    ctx.beginPath();
    ctx.moveTo(x(tEnd - s * 1000), 0);
    ctx.lineTo(x(tEnd - s * 1000), H);
    ctx.stroke();
  }
  // Each series gets its own scale (with a minimum span so noise isn't blown up), zero at the same height.
  const line = (pts: Point[], color: string, minSpan: number, label: string, row: number) => {
    const vals = pts.map((p) => p.v).filter(Number.isFinite);
    if (!vals.length) return;
    const lo = Math.min(0, ...vals);
    const hi = Math.max(lo + minSpan, ...vals);
    const y = (v: number) => H - 8 - ((v - lo) / (hi - lo)) * (H - 16);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(0, y(0));
    ctx.lineTo(W, y(0));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.beginPath();
    let first = true;
    for (const p of pts) {
      if (!Number.isFinite(p.v)) continue;
      if (first) ctx.moveTo(x(p.t), y(p.v));
      else ctx.lineTo(x(p.t), y(p.v));
      first = false;
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = color;
    ctx.font = '600 20px system-ui';
    ctx.fillText(`${label} ${vals[vals.length - 1].toFixed(2)}  [${lo.toFixed(2)}, ${hi.toFixed(2)}]`, 10, 26 + row * 28);
  };
  line(mp, '#60a5fa', 0.3, 'MP z (m)', 1);
  line(depth, '#ffd34d', 0.5, 'depth', 0);
}
