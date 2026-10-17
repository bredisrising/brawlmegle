// Intent tuner: live webcam (or a recorded clip) -> preprocessing -> intent reader, with every signal,
// every detection and every threshold on screen. Thresholds change live; "Copy config" gives JSON to paste
// into src/intent/intents.ts. Run `npm run dev` and open /test/tuner/.
import { CameraSource } from '../../src/input/sources/CameraSource';
import { IntentReader, type IntentOutput } from '../../src/intent/IntentReader';
import { DEFAULT_INTENT, type Intent, type IntentConfig, type LimbName } from '../../src/intent/intents';
import type { Command, FightEvent, PoseFrame, Stance } from '../../src/types';
import { FightEngine } from '../../src/fight/FightEngine';
import { Resolver } from '../../src/fight/Resolver';
import { Cpu, type CpuLevel } from '../../src/fight/Cpu';
import { FIGHT } from '../../src/fight/moves';

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
  $<HTMLButtonElement>('guided').disabled = false;
  $('camera').textContent = 'Camera on';
  camera.onFrame((frame) => onFrame(frame, performance.now()));
}

function onFrame(frame: PoseFrame, now: number) {
  lastFrame = frame;
  recording?.push(frame);
  guided?.frames.push(frame);
  frameTimes.push(now);
  frameTimes = frameTimes.filter((t) => now - t < 1000);
  const out = reader.update(frame, now);
  lastOutput = out;
  pendingIntents.push(...out.intents);
  lastStance = out.stance;
  for (const intent of out.intents) {
    logIntent(intent);
    // Intents are stamped with the frame clock, same as the guided prompts.
    guided?.intents.push(intent);
  }
}

// --- guided test ---------------------------------------------------------------------------------
// Prompts moves one at a time, records the clip with labels (so it can be scored offline too), and
// shows right away which moves the reader caught, missed or misread.

type Expect = { kind: 'strike'; limb: LimbName; style: string } | { kind: 'guard' | 'duck' } | { kind: 'dodge'; dir: 'L' | 'R' } | { kind: 'none' };
type Step = { say: string; hint: string; expect: Expect };
const STEPS: Step[] = [
  { say: 'RIGHT PUNCH', hint: 'snap your right fist at the screen', expect: { kind: 'strike', limb: 'armR', style: 'straight' } },
  { say: 'LEFT PUNCH', hint: 'snap your left fist at the screen', expect: { kind: 'strike', limb: 'armL', style: 'straight' } },
  { say: 'STAY STILL', hint: 'just hold your guard', expect: { kind: 'none' } },
  { say: 'RIGHT HOOK', hint: 'swing your right fist around from the side', expect: { kind: 'strike', limb: 'armR', style: 'hook' } },
  { say: 'LEFT HOOK', hint: 'swing your left fist around from the side', expect: { kind: 'strike', limb: 'armL', style: 'hook' } },
  { say: 'BLOCK', hint: 'both fists up in front of your face, hold', expect: { kind: 'guard' } },
  { say: 'RIGHT UPPERCUT', hint: 'dip, then drive your right fist up', expect: { kind: 'strike', limb: 'armR', style: 'upper' } },
  { say: 'LEFT UPPERCUT', hint: 'dip, then drive your left fist up', expect: { kind: 'strike', limb: 'armL', style: 'upper' } },
  { say: 'SCRATCH YOUR HEAD', hint: 'slowly, like normal', expect: { kind: 'none' } },
  { say: 'DUCK', hint: 'drop your head and shoulders quickly', expect: { kind: 'duck' } },
  { say: 'LEAN LEFT', hint: 'lean your head to your left, quickly', expect: { kind: 'dodge', dir: 'L' } },
  { say: 'LEAN RIGHT', hint: 'lean your head to your right, quickly', expect: { kind: 'dodge', dir: 'R' } },
  { say: 'RIGHT PUNCH', hint: 'again!', expect: { kind: 'strike', limb: 'armR', style: 'straight' } },
  { say: 'LEFT PUNCH', hint: 'again!', expect: { kind: 'strike', limb: 'armL', style: 'straight' } },
  { say: 'WAVE HELLO', hint: 'a normal wave', expect: { kind: 'none' } },
  { say: 'RIGHT PUNCH', hint: 'as hard as you can', expect: { kind: 'strike', limb: 'armR', style: 'straight' } },
  { say: 'LEFT HOOK', hint: 'again', expect: { kind: 'strike', limb: 'armL', style: 'hook' } },
  { say: 'RIGHT UPPERCUT', hint: 'again', expect: { kind: 'strike', limb: 'armR', style: 'upper' } },
  { say: 'BLOCK', hint: 'fists up, hold', expect: { kind: 'guard' } },
  { say: 'LEFT PUNCH', hint: 'small and quick', expect: { kind: 'strike', limb: 'armL', style: 'straight' } },
];
const STEP_MS = 3500;
const SHOW_MS = 2600; // the rest of each step is a breather

let guided: { frames: PoseFrame[]; intents: Intent[]; labels: { say: string; expect: Expect; start: number; end: number }[] } | null = null;

$('guided').onclick = async () => {
  if (guided || !camera) return;
  guided = { frames: [], intents: [], labels: [] };
  $('log').textContent = '';
  const prompt = $('prompt');
  prompt.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('guided').textContent = 'Guided test running…';
  for (const n of [3, 2, 1]) {
    prompt.innerHTML = `get ready… ${n}<small>guard up: fists by your chin</small>`;
    await sleep(1000);
  }
  for (const step of STEPS) {
    const start = lastFrame?.t ?? performance.now();
    prompt.innerHTML = `${step.say}<small>${step.hint}</small>`;
    await sleep(SHOW_MS);
    prompt.innerHTML = '';
    await sleep(STEP_MS - SHOW_MS);
    guided.labels.push({ say: step.say, expect: step.expect, start, end: start + STEP_MS });
  }
  prompt.innerHTML = 'done!<small>results on the right, clip saved to Downloads</small>';
  setTimeout(() => (prompt.innerHTML = ''), 4000);
  $('guided').textContent = 'Guided test (90 s)';
  showResults(guided);
  $('results').scrollIntoView({ block: 'center', behavior: 'smooth' });
  download(guided);
  void upload(guided);
  guided = null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function matches(intent: Intent, expect: Expect) {
  if (expect.kind === 'strike') return intent.kind === 'strike' && intent.limb === expect.limb;
  if (expect.kind === 'guard') return intent.kind === 'guard' && intent.up;
  if (expect.kind === 'dodge') return intent.kind === 'dodge';
  return intent.kind === expect.kind;
}

function showResults(g: NonNullable<typeof guided>) {
  const actions = g.intents.filter((i) => i.kind !== 'anticipate' && i.kind !== 'cancel' && !(i.kind === 'guard' && !i.up));
  let hits = 0, scored = 0;
  const rows = g.labels.map((label) => {
    const during = actions.filter((i) => i.t >= label.start && i.t <= label.end);
    const seen = during.map((i) => describe(i)?.split(' · ')[0]).join(', ') || 'nothing';
    let cls: string, verdict: string;
    if (label.expect.kind === 'none') {
      const fired = during.filter((i) => i.kind !== 'guard');
      cls = fired.length ? 'bad' : 'good';
      verdict = fired.length ? 'false trigger' : 'ok';
    } else {
      scored++;
      const hit = during.find((i) => matches(i, label.expect));
      const styleOk = hit && (label.expect.kind !== 'strike' || (hit.kind === 'strike' && hit.style === label.expect.style))
        && (label.expect.kind !== 'dodge' || (hit.kind === 'dodge' && hit.dir === label.expect.dir));
      if (hit) hits++;
      cls = styleOk ? 'good' : hit ? 'meh' : 'bad';
      verdict = styleOk ? '✓' : hit ? 'caught, wrong type' : 'missed';
    }
    return `<tr><td>${label.say}</td><td class="${cls}">${verdict}</td><td>${seen}</td></tr>`;
  });
  $('resultsBody').innerHTML = `<p>${hits}/${scored} moves caught.</p><table>${rows.join('')}</table>`;
  $('results').hidden = false;
}

/** Send the labeled session (pose points only, never video) to our server to train the move reader. */
async function upload(g: NonNullable<typeof guided>) {
  const base = location.hostname.endsWith('sslip.io') ? '' : 'https://54-149-60-196.sslip.io';
  const header = { clip: 'guided test', model: new URLSearchParams(location.search).get('pose') ?? 'full', frames: g.frames.length, labels: g.labels, ua: navigator.userAgent };
  const note = document.createElement('p');
  note.className = 'hint';
  try {
    const res = await fetch(`${base}/samples`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: [header, ...g.frames].map((x) => JSON.stringify(x)).join('\n') + '\n' });
    note.textContent = res.ok ? 'Uploaded to train the move reader. Thanks!' : `Upload failed (${res.status}); the file in Downloads works too.`;
  } catch {
    note.textContent = 'Upload failed (offline?); the file in Downloads works too.';
  }
  $('resultsBody').append(note);
}

function download(g: NonNullable<typeof guided>) {
  const header = { clip: 'guided test', model: new URLSearchParams(location.search).get('pose') ?? 'full', frames: g.frames.length, labels: g.labels };
  const blob = new Blob([[header, ...g.frames].map((x) => JSON.stringify(x)).join('\n') + '\n'], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `guided-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.jsonl`;
  a.click();
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
  if (camera) {
    const st = camera.stats;
    $('status').textContent = `${fps} fps tracked (camera ${st.width}×${st.height} @ ${Math.round(st.fps)}) · MediaPipe ${st.detectMs.toFixed(0)} ms/frame · ${out?.stance.tracked ? 'tracking' : 'no body found'}${recording ? ` · recording ${recording.length} frames` : ''}`;
  }
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
$<HTMLInputElement>('exposure').onchange = async (e) => {
  const on = (e.target as HTMLInputElement).checked;
  const ok = (await camera?.setShortExposure(on)) ?? false;
  if (!ok) {
    (e.target as HTMLInputElement).checked = false;
    alert("This camera doesn't allow manual exposure. A bright light in front of you helps the same way.");
  }
};
$('reset').onclick = () => {
  config = structuredClone(DEFAULT_INTENT);
  reader.setConfig(config);
  saveConfig();
  buildConfigUI();
};
buildConfigUI();

// --- fight a dummy ---------------------------------------------------------------------------------
// The real resolver + fight engine at 60 Hz: you (p1, from the camera) against p2: a punching bag, or the CPU.

const engine = new FightEngine();
const resolver = new Resolver();
let pendingIntents: Intent[] = [];
let lastStance: Stance = { player: 'p1', guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: false };
let tick = 0;
const DUMMY_STANCE: Stance = { player: 'p2', guard: false, advance: 0, lean: { x: 0, y: 0 }, tracked: true };
const lastMove: { p1?: Command; p2?: Command } = {};
let cpu: Cpu | null = null;
let fights = 0;

/** Off = a punching bag; otherwise p2 is the CPU at that level (a new seed each fight). */
function setOpponent() {
  const level = $<HTMLSelectElement>('dummyLevel').value;
  cpu = level === 'off' ? null : new Cpu('p2', level as CpuLevel, ++fights);
}
$<HTMLSelectElement>('dummyLevel').onchange = setOpponent;
setOpponent(); // the browser may have restored the select on reload
const p2Name = () => (cpu ? `${cpu.level} cpu` : 'dummy');

setInterval(() => {
  tick++;
  const commands = resolver.resolve('p1', pendingIntents, engine);
  pendingIntents = [];
  for (const c of commands) if (c.kind === 'attack') lastMove.p1 = c;
  let p2Stance = DUMMY_STANCE;
  if (cpu) {
    const out = cpu.think(engine, tick);
    for (const c of out.commands) if (c.kind === 'attack') lastMove.p2 = c;
    commands.push(...out.commands);
    p2Stance = out.stance;
  }
  for (const event of engine.step(commands, { p1: lastStance, p2: p2Stance })) logFight(event);
  if (tick % 4 === 0) drawFight();
}, 1000 / 60);

function logFight(ev: FightEvent) {
  const who = ev.attacker === 'p1' ? 'you' : p2Name();
  let text: string | null = null;
  if (ev.type === 'startup') {
    const c = ev.attacker === 'p1' ? lastMove.p1 : lastMove.p2;
    const lunge = c && c.kind === 'attack' && c.lunge ? ` (lunged ${c.lunge.toFixed(2)} m)` : '';
    text = `${who}: ${ev.move.toUpperCase()}${lunge}`;
  } else if (ev.type === 'hit' || ev.type === 'counter') text = `  → ${ev.type === 'counter' ? 'COUNTER ' : ''}HIT ${ev.damage}`;
  else if (ev.type === 'blocked') text = `  → blocked (${ev.damage} chip)`;
  else if (ev.type === 'whiff') text = '  → missed';
  else if (ev.type === 'ko') text = ev.attacker === 'p1' ? 'K.O.! you win' : `K.O.! the ${p2Name()} wins`;
  if (!text) return;
  const row = document.createElement('div');
  row.className = ev.type;
  row.textContent = text;
  const log = $('fightLog');
  log.prepend(row);
  while (log.childElementCount > 60) log.lastElementChild?.remove();
}

function drawFight() {
  const p1 = engine.state('p1');
  const p2 = engine.state('p2');
  ($('hp1') as HTMLElement).style.width = `${p1.hp}%`;
  ($('hp2') as HTMLElement).style.width = `${p2.hp}%`;
  $('hpn1').textContent = String(Math.round(p1.hp));
  $('hpn2').textContent = String(Math.round(p2.hp));
  ($('st1') as HTMLElement).style.width = `${(p1.stamina / FIGHT.maxStamina) * 100}%`;
  const pos = (x: number) => `${((x + FIGHT.arenaHalfWidth) / (2 * FIGHT.arenaHalfWidth)) * 100}%`;
  ($('dot1') as HTMLElement).style.left = pos(p1.x);
  ($('dot2') as HTMLElement).style.left = pos(p2.x);
  const evade = engine.evading('p1');
  $('phases').textContent = `distance ${engine.distance().toFixed(2)} m · you: ${p1.phase}${p1.move ? ` ${p1.move}` : ''}${lastStance.guard ? ' · guard up' : ''}${evade ? ` · ${evade}` : ''} · ${p2Name()}: ${p2.phase}${p2.move ? ` ${p2.move}` : ''}`;
}

$('fightReset').onclick = () => {
  engine.reset();
  setOpponent();
  $('fightLog').textContent = '';
};
