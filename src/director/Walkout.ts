import * as THREE from 'three';
import { config } from '../config';
import { COUNTDOWN_FROM } from '../game/constants';
import { useGameStore } from '../game/store';
import { PLAYER_IDS, type PlayerId } from '../types';
import type { Announcer } from './Announcer';
import type { Effects } from './Effects';
import type { FighterView } from './FighterView';
import type { Renderer } from './Renderer';
import type { Sfx } from './Sfx';
import { JOINTS, copyPose, createPose, type Pose } from './pose';
import { Fire, Stage, VsSign, type FirePalette } from './walkoutFx';
import { folded, signature, stand, walk } from './walkoutPose';
import {
  DEFAULT_BEATS, beatsFor, easeInOut, easeOut, kf, linear, signatures, smoothstep, walkoutEnabled, type Beats, type Signature,
} from './walkoutTiming';

const BASE = import.meta.env.BASE_URL;
const DEFAULT_TRACK = `${BASE}walkout/walkout.mp3`;
/** The fire VS burns orange with a touch of each player's color in the embers. */
const VS_FIRE: FirePalette = { hot: '#ffd36a', mid: '#ff6a1a', cool: '#b3102e', tint: '#ffb03a' };
/** How far back the fighters start, walking up to their marks (fighter-space metres, along the way they face). */
const WALK_FROM = -1.1;
/**
 * Facing during the entrance (root yaw; 0 = the camera, fight facing is +-pi/2): a little toward each other while
 * waiting, turned out to their camera (which shoots from their outside) during their own shot.
 */
const WAIT_FACING: Record<PlayerId, number> = { p1: 0.2, p2: -0.2 };
const SHOT_FACING: Record<PlayerId, number> = { p1: -0.35, p2: 0.35 };

/** A walkout track: where to start in the file, and its beats (seconds after that). */
type Track = { url: string; start: number; beats: Beats; custom: boolean };

const ramp = (t: number, start: number, len: number) => smoothstep((t - start) / len);

/**
 * The walkout: Street Fighter 6's in-stage character entrance, before round 1. The arena goes dark and spotlights
 * find the two fighters walking up to their marks; each gets a slow low push-in while they do their signature action
 * (the other one waiting, arms folded, in the background); then a two-shot as they turn to each other and drop into
 * their stance while the camera pulls back; a white flash and a burning VS in the stage; then the countdown carries
 * on into ROUND 1 and FIGHT. The beats (walkoutTiming.ts) follow the music.
 *
 * It runs from the store, so both laptops play it from the same moment: it starts when the countdown's first beat
 * starts (the host's phase message on the client) and stops the moment that beat ends (the host's skip carries over).
 * Presentation only: the fight engine never sees it. The UI layer (ui/Walkout.tsx) reads `t` and `beats` every frame.
 */
export class Walkout {
  /** Seconds into the walkout (-1 when not running). */
  t = -1;
  /** Dev only: pin the clock here (tests and tuning: `window.__walkout.hold = 1.2`). Holds the countdown too. */
  hold: number | null = null;
  /** This walkout's beats (the track's). */
  beats: Beats = DEFAULT_BEATS;
  kinds: Record<PlayerId, Signature> = { p1: 'shadowbox', p2: 'flex' };
  private prevT = -1;
  private readonly stage: Stage;
  private readonly fire = new Fire(VS_FIRE, config.lowPower);
  private readonly sign = new VsSign();
  private music: ReturnType<Announcer['playMusic']> | null = null;
  private track: Track = { url: DEFAULT_TRACK, start: 0, beats: DEFAULT_BEATS, custom: false };
  private trackChecked = false;
  /** The arena's lights and environment before the walkout dimmed them. */
  private dimmed: [THREE.Light, number][] = [];
  private environment = 1;
  /** Each fighter's root facing before the walkout turned them (restored after). */
  private readonly facing: Record<PlayerId, number> = { p1: Math.PI / 2, p2: -Math.PI / 2 };
  private readonly scratch = { base: createPose(), fight: createPose(), other: createPose() };
  private readonly look = new THREE.Vector3();
  private readonly warmTimer: ReturnType<typeof setTimeout>;
  private readonly unsubscribe: () => void;
  private readonly offFrame: () => void;

  constructor(
    private readonly renderer: Renderer,
    private readonly effects: Effects,
    private readonly views: Record<PlayerId, FighterView>,
    private readonly announcer: Announcer,
    private readonly sfx: Sfx,
    /** Host: end the walkout now (any key or click). Not set on the client laptop: the host's skip carries over. */
    private readonly onSkip: (() => void) | null,
  ) {
    this.stage = new Stage(config.lowPower);
    renderer.scene.add(this.stage.group, this.stage.lights, this.fire.group, this.sign.mesh);
    // Compile the stage's shaders ahead of time (after the first frames), so the walkout doesn't open on a hitch.
    this.warmTimer = setTimeout(() => this.warm(), 1500);
    this.offFrame = renderer.onFrame((dt) => this.frame(dt));
    this.unsubscribe = useGameStore.subscribe((s, prev) => {
      const on = s.phase === 'countdown' && s.countdown === COUNTDOWN_FROM;
      const was = prev.phase === 'countdown' && prev.countdown === COUNTDOWN_FROM;
      if (on && !was) this.start();
      else if (!on && was) this.stop(s.phase === 'countdown');
      // ROUND 1: the beat after the walkout.
      if (s.phase === 'countdown' && s.countdown === COUNTDOWN_FROM - 1 && prev.countdown !== s.countdown) this.announcer.bark('round', true);
    });
    // Audio unlocks on the first gesture (the Announcer listens first): decode the track then, so it starts on time.
    window.addEventListener('pointerdown', this.unlock, { once: true, passive: true });
    window.addEventListener('keydown', this.unlock, { once: true });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('pointerdown', this.onKey);
    if (import.meta.env.DEV) (window as unknown as { __walkout: Walkout }).__walkout = this;
  }

  get active() {
    return this.t >= 0;
  }

  /** How long the countdown's first beat lasts (the host's fallback timer; the music normally ends it). */
  get length() {
    if (!walkoutEnabled) return 0;
    return this.hold === null ? this.track.beats.end : Infinity;
  }

  dispose() {
    clearTimeout(this.warmTimer);
    this.stop(false);
    this.unsubscribe();
    this.offFrame();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pointerdown', this.onKey);
    window.removeEventListener('pointerdown', this.unlock);
    window.removeEventListener('keydown', this.unlock);
    this.stage.dispose();
    this.fire.dispose();
    this.sign.dispose();
  }

  /**
   * The owner's own walkout track, if they dropped one in: public/walkout/custom.mp3, plus an optional
   * public/walkout/custom.json `{ "start": s, "drop": s, "beats": { "p1", "p2", "two", "vs", "end" } }`: where to start
   * in the file, and where (seconds after that) fighter 1's shot starts, or every cut. Missing (or the dev server's
   * index.html fallback) means the original track.
   */
  private async findTrack() {
    if (this.trackChecked) return;
    this.trackChecked = true;
    const url = `${BASE}walkout/custom.mp3`;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok && (res.headers.get('content-type') ?? '').startsWith('audio')) {
        let start = 0;
        let cue: { start?: unknown; drop?: unknown; beats?: unknown } | null = null;
        try {
          const r = await fetch(`${BASE}walkout/custom.json`);
          if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) cue = await r.json();
          if (cue && typeof cue.start === 'number' && Number.isFinite(cue.start)) start = Math.max(0, cue.start);
        } catch {
          // No cue file: start at the top, cut on the default beats.
        }
        this.track = { url, start, beats: beatsFor(cue), custom: true };
      }
    } catch {
      // Offline or blocked: the original track.
    }
    void this.announcer.preloadMusic(this.track.url);
  }

  private unlock = () => void this.findTrack();

  /** Build the stage's, fire's and VS's GPU programs now, while nothing's happening. */
  private warm() {
    const shown = [this.stage.group, this.fire.group, this.sign.mesh];
    const was = shown.map((o) => o.visible);
    for (const o of shown) o.visible = true;
    try {
      this.renderer.renderer.compile(this.renderer.scene, this.renderer.camera);
    } catch (err) {
      console.warn('walkout warm-up failed', err);
    } finally {
      shown.forEach((o, i) => (o.visible = was[i]));
    }
  }

  private start() {
    if (!walkoutEnabled) return;
    if (import.meta.env.DEV) console.debug('[walkout] start', performance.now().toFixed(0));
    void this.findTrack(); // normally done on the first click already
    const { players } = useGameStore.getState();
    this.kinds = signatures(players.p1.name, players.p2.name);
    this.beats = this.track.beats;
    this.t = 0;
    this.prevT = -1;
    this.effects.clear(); // the spawn beams from just before
    for (const id of PLAYER_IDS) {
      const view = this.views[id];
      this.facing[id] = view.root.rotation.y;
      view.entrance = (pose) => this.pose(id, pose);
      view.settle(); // the walkout is their entrance: no print-in glow over it
      if (useGameStore.getState().players[id].status === 'ready') view.setVisible(true);
    }
    this.place();
    this.sign.draw();
    this.fire.clear();
    this.dim(true);
    this.renderer.direct((camera) => this.shoot(camera));
    useGameStore.setState({ walkout: true });
    const { url, start } = this.track;
    this.music = this.announcer.playMusic(url, 0.62, start);
    this.announcer.crowd('murmur', 0.3);
  }

  /** `next`: the countdown carries on (ROUND 1), as opposed to the round being abandoned. */
  private stop(next: boolean) {
    if (this.t < 0) return;
    if (import.meta.env.DEV) console.debug('[walkout] stop at', this.t.toFixed(2), next);
    const early = this.t < this.beats.end - 0.05;
    this.t = -1;
    // The original track stops on its own at the end; a skip or a longer custom track fades out.
    this.music?.stop(early ? 0.15 : this.track.custom ? 0.7 : 0.4);
    this.music = null;
    for (const id of PLAYER_IDS) {
      const view = this.views[id];
      view.entrance = null;
      view.root.rotation.y = this.facing[id];
      view.root.position.z = 0;
      if (useGameStore.getState().players[id].status === 'ready') view.setVisible(true);
    }
    this.stage.amount = 0;
    this.fire.target = 0;
    this.sign.mesh.visible = false;
    this.dim(false);
    this.renderer.direct(null);
    useGameStore.setState({ walkout: false });
    if (next) useGameStore.setState((s) => ({ flashKey: s.flashKey + 1 }));
  }

  /** Night on the stage: the arena's own lights and sky light down to a glow (or back up). */
  private dim(on: boolean) {
    const scene = this.renderer.scene;
    if (on) {
      this.dimmed = [];
      scene.traverse((o) => {
        if (!(o instanceof THREE.Light) || this.isOurs(o)) return;
        this.dimmed.push([o, o.intensity]);
        o.intensity *= 0.08;
      });
      this.environment = scene.environmentIntensity;
      scene.environmentIntensity = this.environment * 0.12;
    } else {
      for (const [light, intensity] of this.dimmed) light.intensity = intensity;
      this.dimmed = [];
      scene.environmentIntensity = this.environment;
    }
  }

  private isOurs(o: THREE.Object3D) {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === this.stage.group) return true;
    return false;
  }

  /** Any key or click on the host skips (after a moment, so the click that started the fight doesn't). */
  private onKey = (e: Event) => {
    if (this.t < 0.3 || !this.onSkip) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // Any key but mute (M), a lone modifier, or a key held down from before.
    if (e instanceof KeyboardEvent && (e.repeat || e.code === 'KeyM' || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key))) return;
    if (useGameStore.getState().role === 'client') return;
    this.onSkip();
  };

  private crossed(at: number) {
    return this.prevT < at && this.t >= at;
  }

  /** A fighter's model arrived mid-walkout (loaded late, on the client laptop): it just appears on its mark. */
  adopt(id: PlayerId) {
    this.views[id].setVisible(true);
    this.views[id].settle();
  }

  /** Every render frame: the clock, where the fighters stand and face, the lights, and the one-off moments. */
  private frame(dt: number) {
    this.fire.update(dt, this.renderer.camera);
    this.stage.update(dt, this.renderer.camera);
    if (this.t < 0) return;
    this.prevT = this.t;
    // The music is the clock while it plays (the cuts stay on its beats through any frame hitches); else frame time.
    const heard = this.music?.clock();
    this.t = this.hold ?? (heard != null ? Math.max(this.t, heard) : this.t + dt);
    const B = this.beats;
    this.stage.amount = Math.min(1, this.t / 0.6);
    this.place();
    if (this.crossed(B.p1) || this.crossed(B.p2)) this.announcer.crowd('cheer', 0.22);
    if (this.crossed(B.vs)) this.burst();
    if (this.t >= B.vs) {
      const u = this.t - B.vs;
      const s = kf(u, [[0, 2.3], [0.09, 0.93], [0.17, 1.04], [0.26, 1]], linear) * (1 + 0.03 * u);
      this.sign.mesh.scale.setScalar(s);
    }
    // The host ends it on the music's last hit (the countdown's own timer runs on game time, which lags on a slow
    // frame rate); the client laptop follows the host's countdown.
    if (this.crossed(B.end) && this.hold === null) this.onSkip?.();
  }

  /** The fire VS: flash, letters slam in behind the fighters, flames and embers burst up around them. */
  private burst() {
    const mid = (this.views.p1.root.position.x + this.views.p2.root.position.x) / 2;
    this.sign.mesh.position.set(mid, 0.95, -0.75);
    this.sign.mesh.visible = true;
    this.sign.draw();
    this.fire.group.position.set(mid, 0, -1.35);
    this.fire.group.scale.setScalar(config.lowPower ? 1.8 : 2.4);
    this.fire.amount = 1.6;
    this.fire.target = 1.1;
    this.fire.burst(config.lowPower ? 40 : 120, 1.8);
    this.renderer.shake(0.03);
    this.sfx.play('heavy');
    this.announcer.crowd('roar', 0.4);
    this.music?.duck(0.8, 0.1);
  }

  /** Where each fighter stands and faces: walking up to the mark, then turning to the other one for the two-shot. */
  private place() {
    const B = this.beats;
    const t = Math.max(0, this.t);
    const walkEnd = B.p1 - 0.25;
    const turn = easeInOut((t - B.two - 0.1) / 0.75);
    for (const id of PLAYER_IDS) {
      const root = this.views[id].root;
      root.position.z = WALK_FROM * (1 - Math.min(1, t / walkEnd)) ** 2 * root.scale.z;
      const start = id === 'p1' ? B.p1 : B.p2;
      const end = id === 'p1' ? B.p2 : B.two;
      const own = Math.min(easeInOut((t - start + 0.15) / 0.6), 1 - easeInOut((t - end + 0.3) / 0.6));
      const entrance = WAIT_FACING[id] + (SHOT_FACING[id] - WAIT_FACING[id]) * Math.max(0, own);
      root.rotation.y = entrance + (this.facing[id] - entrance) * turn;
      this.stage.aim(id === 'p1' ? 0 : 1, root.position);
    }
  }

  /**
   * The pose for this fighter right now (FighterView.entrance, every sim tick): walking in, then waiting with arms
   * folded or doing their signature, then blending into the fight stance for the two-shot. Always returns true: the
   * cinematic runs at full frame rate, not stepped on twos.
   */
  private pose(id: PlayerId, pose: Pose) {
    if (this.t < 0) return false;
    const B = this.beats;
    const t = this.t;
    const inner = id === 'p1' ? 1 : -1;
    const { base, fight, other } = this.scratch;
    copyPose(fight, pose); // the engine's stance, for the two-shot
    stand(base, t + (id === 'p2' ? 1.3 : 0));
    const walkEnd = B.p1 - 0.25;
    walk(base, t * 2 * Math.PI * 1.6 + (id === 'p2' ? Math.PI : 0), 1 - ramp(t, walkEnd - 0.4, 0.4));
    copyPose(pose, base);
    // Waiting (arms folded) once they're on their mark, except during their own shot.
    const start = id === 'p1' ? B.p1 : B.p2;
    const end = id === 'p1' ? B.p2 : B.two;
    const own = Math.min(ramp(t, start - 0.1, 0.3), 1 - ramp(t, end - 0.25, 0.4));
    const wait = ramp(t, walkEnd - 0.1, 0.5) * (1 - own);
    if (wait > 0) {
      copyPose(other, base);
      folded(other, t, inner);
      lerp(pose, other, wait);
    }
    if (own > 0) {
      copyPose(other, base);
      signature(other, this.kinds[id], t - start - 0.05, inner);
      lerp(pose, other, own);
    }
    // The two-shot: into their fighting stance as they turn to face each other.
    const k = ramp(t, B.two + 0.1, 0.65);
    if (k > 0) lerp(pose, fight, k);
    return true;
  }

  /** The camera for this moment (Renderer.direct hands it here every frame): slow, low, cinematic. */
  private shoot(camera: THREE.PerspectiveCamera) {
    const B = this.beats;
    const t = this.t < 0 ? B.end : this.t;
    // Narrow screens (a phone held upright): back off until the fighters fit across.
    const narrow = Math.max(1, Math.pow(1.3 / camera.aspect, 0.7));
    const x1 = this.views.p1.root.position.x;
    const x2 = this.views.p2.root.position.x;
    const mid = (x1 + x2) / 2;
    let fov: number;
    if (t < B.p1) {
      // The stage: wide and dark, a slow push in as they walk up to their marks.
      const k = easeInOut(t / B.p1);
      camera.position.set(mid + 0.1 * k, 0.6 - 0.08 * k, (2.9 - 0.5 * k) * narrow);
      camera.lookAt(this.look.set(mid, 0.42, -0.3));
      fov = 31;
    } else if (t < B.two) {
      // One fighter: low 3/4 from their outside, pushing in slowly from a medium shot to their face and shoulders;
      // the other one stands soft in the background across the frame.
      const p1 = t < B.p2;
      const f = p1 ? -1 : 1; // the outside: P1's left of frame, P2's right
      const x = p1 ? x1 : x2;
      const z = (p1 ? this.views.p1 : this.views.p2).root.position.z;
      const s0 = p1 ? B.p1 : B.p2;
      const s1 = p1 ? B.p2 : B.two;
      const k = easeInOut((t - s0) / (s1 - s0));
      const angle = 0.5 - 0.12 * k;
      const dist = (1.75 - 0.5 * k) * narrow;
      camera.position.set(x + f * Math.sin(angle) * dist, 0.36 + 0.14 * k, z + Math.cos(angle) * dist);
      camera.lookAt(this.look.set(x - f * (0.13 - 0.06 * k), 0.5 + 0.1 * k, z));
      fov = 28 - 3 * k;
    } else if (t < B.vs) {
      // The two-shot: low between them looking up, pulling back toward the fight camera as they square up.
      const k = easeInOut((t - B.two) / (B.vs - B.two));
      camera.position.set(mid, 0.24 + 0.24 * k, (1.0 + 0.7 * k) * narrow);
      camera.lookAt(this.look.set(mid, 0.52 - 0.06 * k, 0));
      fov = 34 + 4 * k;
    } else {
      // The fire VS: wide on the stage, a slight drift in.
      const k = easeOut((t - B.vs) / Math.max(0.2, B.end - B.vs));
      camera.position.set(mid, 0.52, (2.2 - 0.15 * k) * narrow);
      camera.lookAt(this.look.set(mid, 0.55, -0.4));
      fov = 40;
    }
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}

function lerp(dst: Pose, src: Pose, k: number) {
  for (const j of JOINTS) dst[j].lerp(src[j], k);
}
