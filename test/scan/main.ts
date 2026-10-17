// 360° scan test page: webcam -> MediaPipe -> scan buckets (front / left / right, sharpest kept), then
// optionally the real forge. Run `npm run dev` and open /test/scan/, or the hosted build (scripts/build-scan.mjs).
//   ?forge=http://127.0.0.1:8787  forge server (default VITE_FORGE_API)
//   ?timeout=15                   scan timeout in seconds
//   ?autoscan=1                   start scanning as soon as the camera is up
import { CameraSource } from '../../src/input/sources/CameraSource';
import { config } from '../../src/config';
import { captureScan, forgeFighter, type ScanFrames } from '../../src/forge/forge';
import type { ScanUpdate } from '../../src/forge/scan';
import { BUCKETS, classify, estimateFacing, personBox, type Bucket, type Tier } from '../../src/forge/scanBuckets';
import { forgeStatus } from '../../src/forge/status';
import type { PoseFrame } from '../../src/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const TIER_COLOR = ['#3a3e48', '#fbbf24', '#4ade80'] as const;
const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

let camera: CameraSource | null = null;
let scanning = false;
let frames: ScanFrames | null = null;
let lastTiers: Record<Bucket, Tier> = { front: 0, left: 0, right: 0 };

$<HTMLInputElement>('forgeUrl').value = params.get('forge') ?? config.forgeApi;
$<HTMLInputElement>('name').value = params.get('name') ?? '';
$('camera').onclick = () => startCamera();
$('scan').onclick = () => scan();
$('forge').onclick = () => forge();
drawRing(0, lastTiers);
startCamera();

async function startCamera() {
  if (camera) return;
  $('status').textContent = 'starting camera and MediaPipe…';
  camera = new CameraSource();
  try {
    await camera.start();
  } catch (err) {
    $('status').textContent = `camera didn't start (${(err as Error).message}). Allow camera access, then click Start camera.`;
    camera = null;
    return;
  }
  $<HTMLVideoElement>('video').srcObject = camera.video.srcObject;
  $('camera').textContent = 'Camera on';
  $<HTMLButtonElement>('scan').disabled = false;
  $('status').textContent = 'camera on';
  camera.onFrame(drawPose);
  if (params.has('autoscan')) scan();
}

async function scan() {
  if (!camera || scanning) return;
  scanning = true;
  frames = null;
  $<HTMLButtonElement>('scan').disabled = true;
  $<HTMLButtonElement>('forge').disabled = true;
  $('sizes').textContent = '';
  for (const b of BUCKETS) clearThumb(b);
  const timeout = Number(params.get('timeout') ?? 15) * 1000;
  try {
    frames = await captureScan(camera.video, camera, onScanUpdate, { durationMs: timeout });
  } catch (err) {
    $('status').textContent = `scan failed: ${(err as Error).message}`;
  }
  scanning = false;
  $<HTMLButtonElement>('scan').disabled = false;
  $('scan').textContent = 'Scan again';
  if (!frames) return;
  const got = BUCKETS.filter((_, i) => frames![i]);
  $('sizes').textContent = got.length
    ? BUCKETS.map((b, i) => `${b} ${frames![i] ? `${Math.round((frames![i].length * 3) / 4 / 1024)} KB` : '—'}`).join(' · ')
    : 'nothing captured: nobody was in view';
  $('status').textContent = `scan done: ${got.join(', ') || 'no frames'}`;
  $<HTMLButtonElement>('forge').disabled = got.length === 0;
  $('forgeStatus').textContent = got.length ? 'Ready to forge (three paid image calls).' : 'Scan again.';
  // For headless checks.
  (window as unknown as { scanResult: unknown }).scanResult = { got, tiers: lastTiers, sizes: frames.map((f) => f.length), frames };
}

function onScanUpdate(u: ScanUpdate) {
  $('hint').textContent = u.done ? '' : u.hint;
  lastTiers = { front: u.buckets.front.tier, left: u.buckets.left.tier, right: u.buckets.right.tier };
  drawRing(u.fraction, lastTiers, u.elapsedMs);
  for (const b of BUCKETS) $(`thumb-${b}`).className = `thumb t${u.buckets[b].tier}`;
  if (u.changed && u.crops[u.changed]) drawThumb(u.changed, u.crops[u.changed]!);
}

async function forge() {
  if (!frames) return;
  const api = $<HTMLInputElement>('forgeUrl').value.trim();
  const name = $<HTMLInputElement>('name').value.trim();
  $<HTMLButtonElement>('forge').disabled = true;
  for (const id of ['sheet', 'card', 'brief']) $(id).hidden = true;
  const started = performance.now();
  try {
    const fighter = await forgeFighter(name, frames, (f) => {
      const secs = ((performance.now() - started) / 1000).toFixed(0);
      $('forgeStatus').textContent = `${forgeStatus(f)} (${f.status}${f.step ? ` / ${f.step}` : ''}, ${secs} s)${api ? '' : ' [mock: no forge URL]'}`;
      if (f.sheetUrl) showImage('sheet', f.sheetUrl);
      if (f.cardUrl) showImage('card', f.cardUrl);
      if (f.brief) {
        $('brief').textContent = JSON.stringify(f.brief, null, 2);
        $('brief').hidden = false;
      }
    }, { api });
    if (fighter.status === 'failed') $('forgeStatus').textContent = `Forge failed: ${fighter.error ?? 'unknown error'}`;
    else $('forgeStatus').textContent += fighter.glbUrl ? ' · has 3D model' : ' · no 3D model yet (game uses the default)';
  } catch (err) {
    $('forgeStatus').textContent = `${(err as Error).message}. Is the forge running, and does FORGE_ALLOWED_ORIGINS include ${location.origin}?`;
  }
  $<HTMLButtonElement>('forge').disabled = false;
}

// --- drawing -------------------------------------------------------------------------------------

function showImage(id: string, url: string) {
  const img = $<HTMLImageElement>(id);
  if (img.src !== url) img.src = url;
  img.hidden = false;
}

function clearThumb(b: Bucket) {
  const c = $(`thumb-${b}`).querySelector('canvas')!;
  c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  $(`thumb-${b}`).className = 'thumb';
}

function drawThumb(b: Bucket, crop: HTMLCanvasElement) {
  const c = $(`thumb-${b}`).querySelector('canvas')!;
  c.width = 180;
  c.height = 300;
  const ctx = c.getContext('2d')!;
  const s = Math.min(c.width / crop.width, c.height / crop.height);
  const w = crop.width * s, h = crop.height * s;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(crop, (c.width - w) / 2, (c.height - h) / 2, w, h);
}

/** Three arcs (front at the top, then left and right; the player's left shows on the screen's left, mirrored) plus elapsed time. */
function drawRing(fraction: number, tiers: Record<Bucket, Tier>, elapsedMs = 0) {
  const r = 48, cx = 60, cy = 60;
  const arc = (from: number, to: number) => {
    const p = (deg: number) => [cx + r * Math.sin((deg * Math.PI) / 180), cy - r * Math.cos((deg * Math.PI) / 180)];
    const [x0, y0] = p(from), [x1, y1] = p(to);
    return `M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  const seg = { front: [-55, 55], right: [65, 175], left: [185, 295] } as const;
  const label = { front: [60, 22], right: [94, 82], left: [26, 82] } as const;
  $('ring').innerHTML =
    `<circle cx="60" cy="60" r="58" fill="rgba(0,0,0,0.55)"/>` +
    BUCKETS.map((b) => `<path d="${arc(seg[b][0], seg[b][1])}" stroke="${TIER_COLOR[tiers[b]]}" stroke-width="10" fill="none" stroke-linecap="round"/>`).join('') +
    BUCKETS.map((b) => `<text x="${label[b][0]}" y="${label[b][1]}">${b === 'front' ? 'F' : b === 'left' ? 'L' : 'R'}${tiers[b] === 2 ? '✓' : ''}</text>`).join('') +
    `<text x="60" y="58" style="font-size:20px">${Math.round(fraction * 100)}%</text>` +
    `<text x="60" y="76">${scanning ? `${(elapsedMs / 1000).toFixed(1)} s` : ''}</text>`;
}

function drawPose(frame: PoseFrame) {
  const canvas = $<HTMLCanvasElement>('overlay');
  const video = camera!.video;
  if (canvas.width !== video.videoWidth && video.videoWidth) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const facing = estimateFacing(frame);
  const hit = facing && classify(facing);
  const color = hit ? TIER_COLOR[hit.tier] : '#94a3b8';
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  for (const [a, b] of BONES) {
    const p = frame.image[a], q = frame.image[b];
    ctx.beginPath();
    ctx.moveTo(p.x * W, p.y * H);
    ctx.lineTo(q.x * W, q.y * H);
    ctx.stroke();
  }
  ctx.fillStyle = '#ff2d95';
  const nose = frame.image[0];
  ctx.beginPath();
  ctx.arc(nose.x * W, nose.y * H, 5, 0, Math.PI * 2);
  ctx.fill();
  const box = personBox(frame, W, H);
  if (box) {
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);
  }
  $('debug').textContent = facing
    ? `turn ${facing.yaw.toFixed(0)}°  side ${facing.side > 0 ? 'left' : facing.side < 0 ? 'right' : '?'}  ` +
      `shoulders ${facing.width.toFixed(2)}  nose ${facing.nose.toFixed(2)}${facing.frontal ? '' : '  (back?)'}\n` +
      `→ ${hit ? `${hit.bucket} (${hit.tier === 2 ? 'good' : '3/4'})` : 'no bucket'}`
    : 'torso not tracked: step back';
}
