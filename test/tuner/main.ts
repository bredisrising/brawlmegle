// Intent tuner: live webcam (or a recorded clip) -> preprocessing -> intent reader, with every signal,
// every detection and every threshold on screen. Thresholds change live; "Copy config" gives JSON to paste
// into src/intent/intents.ts. Run `npm run dev` and open /test/tuner/.
import { CameraSource } from '../../src/input/sources/CameraSource';
import { IntentReader, type IntentOutput } from '../../src/intent/IntentReader';
import { DEFAULT_INTENT, type Intent, type IntentConfig, type LimbName } from '../../src/intent/intents';
import type { PoseFrame } from '../../src/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const STORAGE_KEY = 'brawlegle.tuner.config';
const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];
const LIMB_LABEL: Record<LimbName, string> = { armL: 'left arm', armR: 'right arm', legL: 'left leg', legR: 'right leg' };

let config: IntentConfig = loadConfig();
let reader = new IntentReader('p1', config);
let camera: CameraSource | null = null;
let recording: PoseFrame[] | null = null;
let lastFrame: PoseFrame | null = null;
let lastOutput: IntentOutput | null = null;
let frameTimes: number[] = [];

// --- input ---------------------------------------------------------------------------------------

$('camera').onclick = () => startCamera();
// Start right away: the browser asks for camera permission, and there's no button to miss.
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
  $<HTMLButtonElement>('record').disabled = false;
  $('camera').textContent = 'Camera on';
  camera.onFrame((frame) => onFrame(frame, performance.now()));
}

function onFrame(frame: PoseFrame, now: number) {
  lastFrame = frame;
  recording?.push(frame);
  frameTimes.push(now);
  frameTimes = frameTimes.filter((t) => now - t < 1000);
  const out = reader.update(frame, now);
  lastOutput = out;
  for (const intent of out.intents) logIntent(intent);
}

$('record').onclick = () => {
  if (!recording) {
    recording = [];
    $('record').textContent = 'Stop + download';
    $('record').classList.add('on');
    return;
  }
  const frames = recording;
  recording = null;
  $('record').textContent = 'Record clip';
  $('record').classList.remove('on');
  const header = { clip: 'tuner recording', model: new URLSearchParams(location.search).get('pose') ?? 'full', frames: frames.length };
  const blob = new Blob([[header, ...frames].map((x) => JSON.stringify(x)).join('\n') + '\n'], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pose-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.jsonl`;
  a.click();
};

$<HTMLInputElement>('replay').onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const lines = (await file.text()).trim().split('\n').map((l) => JSON.parse(l));
  const frames = (lines.slice(1) as (PoseFrame | { missing: true; t: number })[]).filter((f): f is PoseFrame => !('missing' in f));
  reader = new IntentReader('p1', config);
  $('log').textContent = '';
  $('status').textContent = `replaying ${file.name} (${frames.length} frames)`;
  // Play back at recorded speed, on the clip's own clock.
  const start = performance.now();
  const t0 = frames[0]?.t ?? 0;
  for (const frame of frames) {
    const wait = frame.t - t0 - (performance.now() - start);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    onFrame(frame, frame.t);
  }
  $('status').textContent = `replay done: ${file.name}`;
};

// --- detections ----------------------------------------------------------------------------------

function describe(intent: Intent): string | null {
  switch (intent.kind) {
    case 'strike': {
      const side = intent.limb.endsWith('L') ? 'LEFT' : 'RIGHT';
      return `${side} ${intent.style.toUpperCase()} · ${intent.height} · speed ${intent.speed.toFixed(2)} · windup ${intent.windup.toFixed(2)}`;
    }
    case 'jump': return `JUMP · power ${intent.power.toFixed(2)}`;
    case 'duck': return 'DUCK';
    case 'dodge': return `DODGE ${intent.dir === 'L' ? 'LEFT' : 'RIGHT'}`;
    case 'guard': return intent.up ? 'guard up' : 'guard down';
    case 'anticipate': return `… ${LIMB_LABEL[intent.limb]} winding up`;
    case 'cancel': return `× ${LIMB_LABEL[intent.limb]} wind-up dropped`;
  }
}

let flashTimer = 0;
function logIntent(intent: Intent) {
  const text = describe(intent);
  if (!text) return;
  const row = document.createElement('div');
  row.className = intent.kind;
  if (intent.kind === 'strike') row.title = `latency from motion start: ${Math.round(intent.t - intent.onsetT)} ms, reach ${intent.reach.toFixed(2)}`;
  row.textContent = `${new Date().toLocaleTimeString().slice(3, 8)}  ${text}`;
  const log = $('log');
  log.prepend(row);
  while (log.childElementCount > 80) log.lastElementChild?.remove();
  if (intent.kind === 'anticipate' || intent.kind === 'cancel' || intent.kind === 'guard') return;
  const flash = $('flash');
  flash.textContent = text.split(' · ')[0];
  flash.style.opacity = '1';
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => (flash.style.opacity = '0'), 700);
}

// --- drawing -------------------------------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('overlay');
const ctx = canvas.getContext('2d')!;

function draw() {
  requestAnimationFrame(draw);
  // Match the overlay (and the stage) to the camera's shape: laptop webcams are often 16:9.
  const video = $<HTMLVideoElement>('video');
  const aspect = video.videoWidth ? video.videoWidth / video.videoHeight : lastFrame?.aspect ?? 4 / 3;
  if (Math.abs(canvas.width / canvas.height - aspect) > 0.01) {
    canvas.width = Math.round(480 * aspect);
    canvas.height = 480;
    (canvas.parentElement as HTMLElement).style.aspectRatio = String(aspect);
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const frame = lastFrame;
  if (frame) {
    const phases = lastOutput?.debug?.limbs;
    const colorFor = (a: number, b: number) => {
      const limb: LimbName | null = [13, 15].includes(b) || [13, 15].includes(a) ? 'armL' : [14, 16].includes(b) || [14, 16].includes(a) ? 'armR'
        : [25, 27].includes(b) ? 'legL' : [26, 28].includes(b) ? 'legR' : null;
      const phase = limb ? phases?.[limb].phase : null;
      return phase === 'onset' ? '#ffd34d' : phase === 'recover' ? '#4ade80' : '#7dd3fc';
    };
    ctx.lineWidth = 4;
    for (const [a, b] of BONES) {
      const p = frame.image[a];
      const q = frame.image[b];
      ctx.strokeStyle = colorFor(a, b);
      ctx.globalAlpha = Math.min(p.visibility, q.visibility) < 0.5 ? 0.35 : 1;
      ctx.beginPath();
      ctx.moveTo(p.x * canvas.width, p.y * canvas.height);
      ctx.lineTo(q.x * canvas.width, q.y * canvas.height);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const out = lastOutput;
  const fps = frameTimes.length;
  if (camera) $('status').textContent = `${fps} fps from camera · ${out?.stance.tracked ? 'tracking' : 'no body found'}${recording ? ` · recording ${recording.length} frames` : ''}`;
  const d = out?.debug;
  if (!d) return;
  $('limbs').innerHTML = (Object.keys(d.limbs) as LimbName[]).map((n) => {
    const limb = d.limbs[n];
    const cfg = n.startsWith('arm') ? config.arm : config.leg;
    const scale = cfg.strikeDist * 2.5;
    return `<div class="meter phase-${limb.phase}"><span>${LIMB_LABEL[n]}</span>
      <div class="bar"><i style="width:${Math.min(100, (limb.disp / scale) * 100)}%"></i><b style="left:${(cfg.strikeDist / scale) * 100}%"></b></div>
      <span>${limb.phase}</span></div>`;
  }).join('');
  const meter = (label: string, value: number, threshold: number, max: number) =>
    `<div class="meter"><span>${label}</span><div class="bar"><i style="width:${Math.max(0, Math.min(100, (value / max) * 100))}%"></i><b style="left:${(threshold / max) * 100}%"></b></div><span>${value.toFixed(2)}</span></div>`;
  $('core').innerHTML = [
    meter('duck', d.headDrop, config.duck.drop, config.duck.drop * 2.5),
    meter('dodge', Math.abs(d.lean), config.dodge.shift, config.dodge.shift * 2.5),
    meter('jump', d.rootY, config.jump.rise, config.jump.rise * 4),
    meter('closer', d.scale - 1, config.advance.in, 0.4),
    `<div class="meter"><span>guard</span><span>${d.guard ? 'UP' : 'down'}</span><span></span></div>`,
  ].join('');
}
requestAnimationFrame(draw);

// --- live config ---------------------------------------------------------------------------------

function loadConfig(): IntentConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return mergeDeep(structuredClone(DEFAULT_INTENT), JSON.parse(saved));
  } catch {}
  return structuredClone(DEFAULT_INTENT);
}

function saveConfig() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

function mergeDeep<T>(target: T, source: unknown): T {
  if (source && typeof source === 'object') {
    for (const [k, v] of Object.entries(source)) {
      const t = (target as Record<string, unknown>)[k];
      if (t && typeof t === 'object' && v && typeof v === 'object') mergeDeep(t, v);
      else if (typeof v === typeof t) (target as Record<string, unknown>)[k] = v;
    }
  }
  return target;
}

/** One slider per number in the config, grouped by section. */
function buildConfigUI() {
  const root = $('config');
  root.textContent = '';
  const walk = (obj: Record<string, unknown>, defaults: Record<string, unknown>, path: string) => {
    for (const [key, value] of Object.entries(obj)) {
      const full = path ? `${path}.${key}` : key;
      if (value && typeof value === 'object') {
        const g = document.createElement('div');
        g.className = 'group';
        g.textContent = full;
        root.append(g);
        walk(value as Record<string, unknown>, defaults[key] as Record<string, unknown>, full);
      } else if (typeof value === 'number') {
        const base = (defaults?.[key] as number) || value || 1;
        const row = document.createElement('div');
        row.className = 'row';
        const label = document.createElement('span');
        label.textContent = key;
        label.title = full;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '0';
        input.max = String(base * 3);
        input.step = String(base / 100);
        input.value = String(value);
        const shown = document.createElement('span');
        shown.textContent = round(value);
        input.oninput = () => {
          obj[key] = Number(input.value);
          shown.textContent = round(Number(input.value));
          reader.setConfig(config);
          saveConfig();
        };
        row.append(label, input, shown);
        root.append(row);
      }
    }
  };
  walk(config as unknown as Record<string, unknown>, DEFAULT_INTENT as unknown as Record<string, unknown>, '');
}
const round = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2));

$('copy').onclick = async () => {
  await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
  $('status').textContent = 'config copied: paste it into DEFAULT_INTENT (src/intent/intents.ts) or send it over';
};
$('reset').onclick = () => {
  config = structuredClone(DEFAULT_INTENT);
  reader.setConfig(config);
  saveConfig();
  buildConfigUI();
};
buildConfigUI();
