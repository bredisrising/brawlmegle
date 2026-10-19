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
import type { Motion } from './fightPose';
import { JOINTS, copyPose, createPose, type Pose } from './pose';
import { Fire, FireWall, Stage, VsSign, type FirePalette } from './walkoutFx';
import { perform, spotOf, type Body } from './walkoutPose';
import { DEFAULT_BEATS, beatsFor, easeInOut, easeOut, kf, linear, smoothstep, walkoutEnabled, type Beats } from './walkoutTiming';

const BASE = import.meta.env.BASE_URL;
const DEFAULT_TRACK = `${BASE}walkout/walkout.mp3`;
/** The fire VS burns orange with a touch of each player's color in the embers. */
const VS_FIRE: FirePalette = { hot: '#ffd36a', mid: '#ff6a1a', cool: '#b3102e', tint: '#ffb03a' };
/** How far back the fighters start, walking up to their marks (fighter-space metres): fighter 2 a step behind. */
const WALK_FROM: Record<PlayerId, number> = { p1: -1.5, p2: -1.8 };
/**
 * Facing during the entrance (root yaw; 0 = the camera, fight facing is +-pi/2): a little toward each other while
 * waiting, turned to their camera during their own shot, square to the camera for the two-shot.
 */
const WAIT_FACING: Record<PlayerId, number> = { p1: 0.12, p2: -0.12 };
const SHOT_FACING: Record<PlayerId, number> = { p1: -0.3, p2: -0.22 };
const TWO_FACING: Record<PlayerId, number> = { p1: 0.08, p2: -0.08 };

/** A walkout track: where to start in the file, and its beats (seconds after that). */
type Track = { url: string; start: number; beats: Beats; custom: boolean };

const ramp = (t: number, start: number, len: number) => smoothstep((t - start) / len);

/**
 * The walkout: Street Fighter 6's walkout (Jamie's), shot for shot, before round 1. Out of a white flash into a dark
 * club, lanterns and a crowd: both fighters dance-walk up to their marks and the camera pushes in on fighter 1 for
 * their routine (fighter 2 grooving behind); a hard cut to fighter 2, low, for theirs; the camera pulls back to the two
 * of them for the tricks (walkoutPose.ts has the moves); a gold flash and the burning VS in the stage; then the
 * countdown carries on into ROUND 1 and FIGHT. The beats (walkoutTiming.ts) follow the music.
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
  private prevT = -1;
  /** When it started (performance.now()): the clock when the music isn't playing (muted, or audio not allowed yet). */
  private startedAt = 0;
  private readonly stage: Stage;
  /** Embers for the VS burst (its flame sheets stay out: the wall is the fire). */
  private readonly fire = new Fire(VS_FIRE, config.lowPower);
  private readonly wall = new FireWall(config.lowPower);
  private readonly sign = new VsSign();
  private music: ReturnType<Announcer['playMusic']> | null = null;
  private track: Track = { url: DEFAULT_TRACK, start: 0, beats: DEFAULT_BEATS, custom: false };
  private trackChecked = false;
  /** The arena's lights and environment before the walkout dimmed them. */
  private dimmed: [THREE.Light, number][] = [];
  private environment = 1;
  /** Each fighter's root facing before the walkout turned them (restored after). */
  private readonly facing: Record<PlayerId, number> = { p1: Math.PI / 2, p2: -Math.PI / 2 };
  private readonly scratch = { fight: createPose(), body: { slide: 0, lift: 0, turn: 0, roll: 0, spot: 0 } as Body };
  /** Where each fighter stands right now (world, on the floor): what the camera frames and the spotlights find. */
  private readonly at: Record<PlayerId, THREE.Vector3> = { p1: new THREE.Vector3(), p2: new THREE.Vector3() };
  private readonly from = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 30 };
  private readonly to = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 30 };
  private readonly warmTimer: ReturnType<typeof setTimeout>;
  private readonly unsubscribe: () => void;
  private readonly offFrame: () => void;

  constructor(
    private readonly renderer: Renderer,
    private readonly effects: Effects,
    private readonly views: Record<PlayerId, FighterView>,
    private readonly announcer: Announcer,
    private readonly sfx: Sfx,
    /** Host: end the walkout now (its end, or a skip). Not set on the client laptop: the host's end carries over. */
    private readonly onSkip: (() => void) | null,
    /** Whether a key or click may skip it: not in a match with someone on another laptop (it'd skip theirs too). */
    private readonly canSkip: () => boolean = () => true,
  ) {
    this.stage = new Stage(config.lowPower);
    renderer.scene.add(this.stage.group, this.stage.lights, this.fire.group, this.wall.group, this.sign.mesh);
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
    if (!walkoutEnabled || this.skipNext()) return 0;
    // The music's end normally ends it (frame()); this is the backstop, with room for a slow start.
    return this.hold === null ? this.track.beats.end + 1.5 : Infinity;
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
    this.wall.dispose();
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
    const shown = [this.stage.group, this.fire.group, this.wall.group, this.sign.mesh];
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

  /** A demo booth (`?demo=1`) plays the entrance before the first round only; rematches go straight to ROUND 1. */
  private played = false;
  private skipNext() {
    return config.demo && this.played && !this.active;
  }

  private start() {
    if (!walkoutEnabled || this.skipNext()) return;
    this.played = true;
    if (import.meta.env.DEV) console.debug('[walkout] start', performance.now().toFixed(0));
    void this.findTrack(); // normally done on the first click already
    this.beats = this.track.beats;
    this.t = 0;
    this.prevT = -1;
    this.effects.clear(); // the spawn beams from just before
    for (const id of PLAYER_IDS) {
      const view = this.views[id];
      this.facing[id] = view.root.rotation.y;
      view.entrance = (pose, motion) => this.pose(id, pose, motion);
      view.settle(); // the walkout is their entrance: no print-in glow over it
      if (useGameStore.getState().players[id].status === 'ready') view.setVisible(true);
    }
    this.place();
    this.sign.draw();
    this.fire.clear();
    this.wall.amount = this.wall.target = 0;
    this.dim(true);
    this.renderer.direct((camera) => this.shoot(camera));
    useGameStore.setState({ walkout: true });
    // The music starts now, on both laptops alike (the client starts when the host's countdown reaches it): the first
    // frames can stall (a fighter that just spawned uploads its textures), but that's under the white it opens on.
    this.startedAt = performance.now();
    this.music = this.announcer.playMusic(this.track.url, 0.62, this.track.start);
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
    this.wall.target = 0;
    for (const id of PLAYER_IDS) this.shade(id, 0);
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
        o.intensity *= config.lowPower ? 0.3 : 0.03;
      });
      this.environment = scene.environmentIntensity;
      scene.environmentIntensity = this.environment * (config.lowPower ? 0.3 : 0.04);
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

  /** Any key or click may skip it now (the host, not in a match with someone on another laptop). */
  get skippable() {
    return !!this.onSkip && useGameStore.getState().role !== 'client' && this.canSkip();
  }

  /** Any key or click on the host skips (after a moment, so the click that started the fight doesn't). */
  private onKey = (e: Event) => {
    if (this.t < 0.3 || !this.skippable) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // Any key but mute (M), a lone modifier, or a key held down from before.
    if (e instanceof KeyboardEvent && (e.repeat || e.code === 'KeyM' || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key))) return;
    this.onSkip?.();
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
    this.wall.update(dt);
    this.stage.update(dt, this.renderer.camera);
    if (this.t < 0) return;
    this.prevT = this.t;
    // The music is the clock while it plays (the cuts stay on its beats through any frame hitches); else real time
    // since it started (not frame time: frames are capped, so a slow laptop would play it slow and get cut off).
    const heard = this.music?.clock();
    this.t = this.hold ?? Math.max(this.t, heard ?? (performance.now() - this.startedAt) / 1000);
    const B = this.beats;
    this.stage.amount = Math.min(1, this.t / 0.6);
    this.stage.beat = this.t - B.open;
    this.place();
    if (this.crossed(B.open) || this.crossed(B.two + 0.5)) this.announcer.crowd('cheer', 0.22);
    // Depth cue: whoever's not in the shot sinks into the dark behind the one who is.
    const t = this.t;
    this.shade('p2', Math.min(ramp(t, B.p1 - 0.05, 0.3), 1 - ramp(t, B.p2 - 0.05, 0.15)));
    this.shade('p1', Math.min(ramp(t, B.p2 - 0.05, 0.3), 1 - ramp(t, B.two - 0.05, 0.15)));
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

  /**
   * Sink a fighter into the background: their colors darken and go cold (0 = as they are). Material colors only, so no
   * shader changes; the originals are kept on the material and put back at 0.
   */
  private shade(id: PlayerId, k: number) {
    if (this.shaded[id] === k) return;
    this.shaded[id] = k;
    this.views[id].root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!(m instanceof THREE.MeshStandardMaterial)) continue;
        const base = (m.userData.walkoutColor as THREE.Color | undefined) ?? (m.userData.walkoutColor = m.color.clone());
        m.color.copy(base).multiply(this.tint.setRGB(1 - 0.72 * k, 1 - 0.7 * k, 1 - 0.6 * k));
        if (k === 0) delete m.userData.walkoutColor;
      }
    });
  }

  private readonly shaded: Record<PlayerId, number> = { p1: 0, p2: 0 };
  private readonly tint = new THREE.Color();

  /** The fire VS: flash, letters slam in behind the fighters, flames and embers burst up around them. */
  private burst() {
    const mid = (this.views.p1.root.position.x + this.views.p2.root.position.x) / 2;
    this.sign.mesh.position.set(mid, 0.95, -0.75);
    this.sign.mesh.visible = true;
    this.sign.draw();
    this.wall.group.position.set(mid, 0, -0.9);
    this.wall.amount = 1.5;
    this.wall.target = 1.05;
    this.fire.group.position.set(mid, 0, -0.9);
    this.fire.group.scale.setScalar(2);
    this.fire.amount = this.fire.target = 0;
    this.fire.burst(config.lowPower ? 50 : 160, 2.2);
    this.renderer.shake(0.03);
    this.sfx.play('heavy');
    this.announcer.crowd('roar', 0.4);
    this.music?.duck(0.8, 0.1);
  }

  /** Where each fighter stands and faces: walking up to the mark, turned to their shot, then back to the fight. */
  private place() {
    const B = this.beats;
    const t = Math.max(0, this.t);
    const walkEnd = B.p1 - 0.25;
    const fight = easeInOut((t - B.vs - 0.15) / 0.7);
    for (const id of PLAYER_IDS) {
      const root = this.views[id].root;
      root.position.z = WALK_FROM[id] * (1 - Math.min(1, t / walkEnd)) ** 2 * root.scale.z;
      const facing =
        id === 'p1'
          ? kf(t, [[B.p1 - 0.3, WAIT_FACING.p1], [B.p1 + 0.3, SHOT_FACING.p1], [B.p2 + 0.1, SHOT_FACING.p1], [B.p2 + 0.6, TWO_FACING.p1]])
          : kf(t, [[B.p2 - 0.3, WAIT_FACING.p2], [B.p2, SHOT_FACING.p2], [B.two, SHOT_FACING.p2], [B.two + 0.5, TWO_FACING.p2]]);
      root.rotation.y = facing + (this.facing[id] - facing) * fight;
      root.updateMatrixWorld();
      root.localToWorld(this.at[id].set(spotOf(id, t, B), 0, 0));
      this.stage.aim(id === 'p1' ? 0 : 1, this.at[id]);
    }
  }

  /**
   * The pose for this fighter right now (FighterView.entrance, every sim tick): their routine (walkoutPose.ts), and the
   * tricks' whole-body motion; under the fire, blending into their fighting stance for ROUND 1. Always returns true:
   * the cinematic runs at full frame rate, not stepped on twos.
   */
  private pose(id: PlayerId, pose: Pose, motion: Motion) {
    if (this.t < 0) return false;
    const B = this.beats;
    const { fight, body } = this.scratch;
    copyPose(fight, pose); // the engine's stance, for the end
    perform(pose, body, id, this.t, B);
    const k = ramp(this.t, B.vs + 0.2, 0.6);
    if (k > 0) lerp(pose, fight, k);
    motion.slide = body.slide;
    motion.lift = body.lift;
    motion.turn = body.turn;
    motion.roll = body.roll;
    return true;
  }

  /**
   * The camera for this moment (Renderer.direct hands it here every frame), Street Fighter 6's moves: wide and low on
   * the club, a push in on fighter 1 as the routine starts, a hard cut to fighter 2 shot from low, a pull back to the
   * two of them, wide for the VS.
   */
  private shoot(camera: THREE.PerspectiveCamera) {
    const B = this.beats;
    const t = this.t < 0 ? B.end : this.t;
    // Narrow screens (a phone held upright): back off until the fighters fit across.
    const narrow = Math.max(1, Math.pow(1.3 / camera.aspect, 0.7));
    let shot = this.to;
    if (t < B.p1 - 0.45) this.wide(shot, t, narrow);
    else if (t < B.p1 + 0.05) {
      // The push in: from the wide shot onto fighter 1, in one move.
      this.wide(this.from, t, narrow);
      this.closeOn('p1', shot, B.p1, narrow);
      shot = mix(this.from, shot, easeInOut((t - B.p1 + 0.45) / 0.5));
    } else if (t < B.p2) this.closeOn('p1', shot, t, narrow);
    else if (t < B.two) this.closeOn('p2', shot, t, narrow);
    else if (t < B.vs) {
      // Pulling back off fighter 2 to the two of them.
      this.closeOn('p2', this.from, B.two, narrow);
      this.twoShot(shot, t, narrow);
      shot = mix(this.from, shot, easeInOut((t - B.two) / 0.55));
    } else {
      // The fire VS: wide on the stage, a slight drift in.
      const k = easeOut((t - B.vs) / Math.max(0.2, B.end - B.vs));
      const mid = (this.at.p1.x + this.at.p2.x) / 2;
      shot.pos.set(mid, 0.52, (2.2 - 0.15 * k) * narrow);
      shot.look.set(mid, 0.55, -0.4);
      shot.fov = 40;
    }
    camera.position.copy(shot.pos);
    camera.lookAt(shot.look);
    if (camera.fov !== shot.fov) {
      camera.fov = shot.fov;
      camera.updateProjectionMatrix();
    }
  }

  /** The club, wide and low, pushing in slowly as they walk up. */
  private wide(out: Shot, t: number, narrow: number) {
    const B = this.beats;
    const k = easeInOut((t - B.open) / (B.p1 - B.open));
    const mid = (this.at.p1.x + this.at.p2.x) / 2;
    out.pos.set(mid - 0.1 * k, 0.4 - 0.03 * k, (1.85 - 0.35 * k) * narrow);
    out.look.set(mid - 0.12 * k, 0.5, -0.3);
    out.fov = 36;
  }

  /**
   * One fighter, close: fighter 1 from low on their outside with fighter 2 soft behind them across the frame; fighter
   * 2 from lower still, in front on the inside, looking up. A slow drift in over the shot.
   */
  private closeOn(id: PlayerId, out: Shot, t: number, narrow: number) {
    const B = this.beats;
    const p1 = id === 'p1';
    const s0 = p1 ? B.p1 : B.p2;
    const s1 = p1 ? B.p2 : B.two;
    const k = easeInOut((t - s0) / (s1 - s0));
    const at = this.at[id];
    if (p1) {
      const angle = 0.5 - 0.12 * k;
      const dist = (0.8 - 0.08 * k) * narrow;
      out.pos.set(at.x - Math.sin(angle) * dist, 0.46 + 0.03 * k, at.z + Math.cos(angle) * dist);
      out.look.set(at.x + 0.08, 0.6, at.z);
      out.fov = 32;
    } else {
      const angle = 0.22 - 0.1 * k;
      const dist = (0.58 - 0.05 * k) * narrow;
      out.pos.set(at.x - Math.sin(angle) * dist, 0.27 + 0.03 * k, at.z + Math.cos(angle) * dist);
      out.look.set(at.x + 0.02, 0.58 - 0.02 * k, at.z);
      out.fov = 42;
    }
  }

  /** Both of them, low in front, everything from the floor to a handstand's feet in frame. */
  private twoShot(out: Shot, t: number, narrow: number) {
    const B = this.beats;
    const k = easeInOut((t - B.two) / (B.vs - B.two));
    const mid = (this.at.p1.x + this.at.p2.x) / 2;
    out.pos.set(mid, 0.3, (1.3 - 0.1 * k) * narrow);
    out.look.set(mid, 0.44, 0);
    out.fov = 38;
  }
}

type Shot = { pos: THREE.Vector3; look: THREE.Vector3; fov: number };

/** `a` moved `k` of the way to `b` (into `b`). */
function mix(a: Shot, b: Shot, k: number): Shot {
  b.pos.lerpVectors(a.pos, b.pos, k);
  b.look.lerpVectors(a.look, b.look, k);
  b.fov = a.fov + (b.fov - a.fov) * k;
  return b;
}

function lerp(dst: Pose, src: Pose, k: number) {
  for (const j of JOINTS) dst[j].lerp(src[j], k);
}
