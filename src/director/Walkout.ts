import * as THREE from 'three';
import { config } from '../config';
import { COUNTDOWN_FROM, PLAYER_COLORS } from '../game/constants';
import { useGameStore } from '../game/store';
import { PLAYER_IDS, type PlayerId } from '../types';
import type { Announcer } from './Announcer';
import type { Effects } from './Effects';
import type { FighterView } from './FighterView';
import type { Renderer } from './Renderer';
import type { Sfx } from './Sfx';
import { Fire, FlameWipe, type FirePalette } from './walkoutFx';
import { entrancePose, faceOffPose } from './walkoutPose';
import { WALKOUT, entranceKinds, kf, easeOut, smoothstep, walkoutEnabled, type EntranceKind } from './walkoutTiming';

const BASE = import.meta.env.BASE_URL;
const DEFAULT_TRACK = `${BASE}walkout/walkout.mp3`;
/** Fire per side: P1 burns hot pink-orange, P2 burns blue. */
const PALETTES: Record<PlayerId, FirePalette> = {
  p1: { hot: '#fff1c4', mid: '#ff6a1a', cool: '#c3133f', tint: '#ff2d95' },
  p2: { hot: '#e9fbff', mid: '#2f9bff', cool: '#3a1fb8', tint: '#5ee8ff' },
};

/** A walkout track: where to start in the file, and where (after that) the hit for P1's name slam lands. */
type Track = { url: string; start: number; drop: number; custom: boolean };

/**
 * The walkout: a Street Fighter 6-style entrance before round 1. Each fighter gets a shot (fire, the materialize,
 * a crouched power-up, then the name slam on the music's hit with a hero pose and a punch-in), a flame wipe between
 * them, then the VS face-off and READY?; the countdown carries on into ROUND 1 and FIGHT. Timing: walkoutTiming.ts.
 *
 * It runs from the store, so both laptops play it from the same moment: it starts when the countdown's first beat
 * starts (the host's phase message on the client) and stops the moment that beat ends (the host's skip carries over).
 * Presentation only: the fight engine never sees it. The UI layer (ui/Walkout.tsx) reads `t` every frame.
 */
export class Walkout {
  /** Seconds into the walkout (-1 when not running). */
  t = -1;
  /** Dev only: pin the clock here (tests and tuning: `window.__walkout.hold = 1.2`). Holds the countdown too. */
  hold: number | null = null;
  kinds: Record<PlayerId, EntranceKind> = { p1: 'point', p2: 'flex' };
  private prevT = -1;
  private readonly fires: Record<PlayerId, Fire>;
  private readonly wipe = new FlameWipe();
  private music: { stop(fade?: number): void } | null = null;
  private track: Track = { url: DEFAULT_TRACK, start: 0, drop: WALKOUT.p1Slam, custom: false };
  private readonly look = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
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
    this.fires = { p1: new Fire(PALETTES.p1, config.lowPower), p2: new Fire(PALETTES.p2, config.lowPower) };
    for (const id of PLAYER_IDS) renderer.scene.add(this.fires[id].group);
    renderer.scene.add(this.wipe.mesh);
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
    const unlock = () => void this.findTrack();
    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('pointerdown', this.onKey);
    if (import.meta.env.DEV) (window as unknown as { __walkout: Walkout }).__walkout = this;
  }

  get active() {
    return this.t >= 0;
  }

  dispose() {
    this.stop(false);
    this.unsubscribe();
    this.offFrame();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pointerdown', this.onKey);
    for (const id of PLAYER_IDS) this.fires[id].dispose();
    this.wipe.dispose();
  }

  /**
   * The owner's own walkout track, if they dropped one in: public/walkout/custom.mp3 (+ optional custom.json
   * `{ "start": s, "drop": s }`: where to start in the file, and how long after that the name-slam hit lands).
   * Missing (or the dev server's index.html fallback) means the original track.
   */
  private async findTrack() {
    const url = `${BASE}walkout/custom.mp3`;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok && (res.headers.get('content-type') ?? '').startsWith('audio')) {
        let start = 0;
        let drop: number = WALKOUT.p1Slam;
        try {
          const cue = await fetch(`${BASE}walkout/custom.json`);
          if (cue.ok && (cue.headers.get('content-type') ?? '').includes('json')) {
            const j = (await cue.json()) as { start?: unknown; drop?: unknown };
            if (typeof j.start === 'number' && Number.isFinite(j.start)) start = Math.max(0, j.start);
            if (typeof j.drop === 'number' && Number.isFinite(j.drop)) drop = Math.max(0, j.drop);
          }
        } catch {
          // No cue file: start at the top, hit at the usual moment.
        }
        this.track = { url, start, drop, custom: true };
      }
    } catch {
      // Offline or blocked: the original track.
    }
    void this.announcer.preloadMusic(this.track.url);
  }

  private start() {
    if (!walkoutEnabled) return;
    const { players } = useGameStore.getState();
    this.kinds = entranceKinds(players.p1.name, players.p2.name);
    this.t = 0;
    this.prevT = -1;
    for (const id of PLAYER_IDS) {
      this.views[id].entrance = (pose, motion) => this.pose(id, pose, motion);
      this.fires[id].clear();
    }
    this.views.p2.setVisible(false);
    this.shown = { p1: '', p2: '' };
    this.arrive('p1');
    this.renderer.direct((camera, dt) => this.shoot(camera, dt));
    useGameStore.setState({ walkout: true });
    // Line the track's hit up with P1's name slam: start later into the file, or wait before starting it.
    const { url, start, drop } = this.track;
    this.music = this.announcer.playMusic(url, 0.62, start + Math.max(0, drop - WALKOUT.p1Slam), Math.max(0, WALKOUT.p1Slam - drop));
  }

  /** `next`: the countdown carries on (ROUND 1), as opposed to the round being abandoned. */
  private stop(next: boolean) {
    if (this.t < 0) return;
    const early = this.t < WALKOUT.end - 0.05;
    this.t = -1;
    // The original track ends on its own at the hit; a skip or a longer custom track fades out.
    this.music?.stop(early ? 0.15 : this.track.custom ? 0.7 : 0.4);
    this.music = null;
    for (const id of PLAYER_IDS) {
      this.views[id].entrance = null;
      this.fires[id].target = 0;
      if (useGameStore.getState().players[id].status === 'ready') this.views[id].setVisible(true);
    }
    this.wipe.set(0, 0, 1, 0, '#000');
    this.renderer.direct(null);
    useGameStore.setState({ walkout: false });
    if (next) useGameStore.setState((s) => ({ flashKey: s.flashKey + 1 }));
  }

  /** Any key or click on the host skips (after a moment, so the click that started the fight doesn't). */
  private onKey = (e: Event) => {
    if (this.t < 0.3 || !this.onSkip) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (useGameStore.getState().role === 'client') return;
    this.onSkip();
  };

  private crossed(at: number) {
    return this.prevT < at && this.t >= at;
  }

  /** Every render frame: the clock, and the beats' one-off moments. */
  private frame(dt: number) {
    for (const id of PLAYER_IDS) {
      this.fires[id].group.position.copy(this.views[id].root.position).setY(0);
      this.fires[id].update(dt, this.renderer.camera);
    }
    if (this.t < 0) return;
    this.prevT = this.t;
    this.t = this.hold ?? this.t + dt;
    const W = WALKOUT;
    const { p1, p2 } = this.fires;
    if (this.crossed(W.p1Slam)) this.slam('p1');
    if (this.crossed(W.p1Hit)) {
      this.renderer.shake(0.015);
      p1.burst(25, 0.9);
    }
    if (this.crossed(W.wipe1)) this.sfx.play('whoosh', 1.3);
    if (this.crossed(W.p2Spawn)) this.arrive('p2');
    if (this.crossed(W.p2)) {
      this.views.p1.setVisible(false);
      p1.clear();
    }
    if (this.crossed(W.p2Slam)) this.slam('p2');
    if (this.crossed(W.wipe2)) this.sfx.play('whoosh', 1.3);
    if (this.crossed(W.readyBark)) this.announcer.bark('ready', true);
    if (this.crossed(W.vs)) {
      this.views.p1.setVisible(true);
      p1.target = 0.75;
      p2.target = 0.75;
      p1.burst(40);
      p2.burst(40);
    }
    if (this.crossed(W.vs + 0.02)) {
      this.renderer.shake(0.035);
      this.sfx.play('counter');
      this.announcer.crowd('roar', 0.35);
    }
    if (this.crossed(W.ready)) {
      this.renderer.shake(0.02);
      p1.target = p2.target = 1.1;
    }
    if (this.crossed(W.flash)) p1.target = p2.target = 0.3;
  }

  /** A fighter's shot begins: they print in out of a beam, standing in fire. */
  private arrive(id: PlayerId) {
    const view = this.views[id];
    view.setVisible(true);
    view.materialize();
    this.sfx.play('spawn');
    this.fires[id].amount = 0.2;
    this.fires[id].target = 1.25;
    this.fires[id].burst(30, 0.6);
  }

  /** The name slam: the fire flares, embers burst, an impact frame and the camera jolts (the punch-in is the shot's). */
  private slam(id: PlayerId) {
    const fire = this.fires[id];
    fire.amount = 1.9;
    fire.target = 1;
    fire.burst(config.lowPower ? 30 : 90, 1.6);
    const head = this.views[id].worldJoint('head');
    if (config.impactFrames && !config.lowPower) this.renderer.impact(head, 0.06, PLAYER_COLORS[id]);
    this.renderer.shake(0.035);
    this.sfx.play('heavy');
    this.announcer.crowd('cheer', 0.3);
  }

  /** The entrance pose for this fighter right now; true on the frames where it should snap (key frames). */
  private pose(id: PlayerId, pose: Parameters<typeof entrancePose>[0], motion: Parameters<typeof entrancePose>[1]) {
    if (this.t < 0) return false;
    const W = WALKOUT;
    const lead = id === 'p1' ? 1 : -1;
    const start = id === 'p1' ? W.p1 : W.p2Spawn;
    const slam = (id === 'p1' ? W.p1Slam : W.p2Slam) - start;
    const beat = this.t >= W.vs ? 'vs' : this.t - start >= slam ? 'hero' : 'power';
    if (beat === 'vs') faceOffPose(pose, this.t);
    else entrancePose(pose, motion, this.kinds[id], this.t - start, slam, lead, this.t);
    // A new beat shows on its exact frame (the on-twos stepping would otherwise hold the old pose a little).
    const snap = beat !== this.shown[id];
    this.shown[id] = beat;
    return snap;
  }

  private shown: Record<PlayerId, string> = { p1: '', p2: '' };

  /** The camera for this moment of the walkout (Renderer.direct hands it here every frame). */
  private shoot(camera: THREE.PerspectiveCamera, _dt: number) {
    const W = WALKOUT;
    const t = this.t < 0 ? W.end : this.t;
    let fov: number;
    if (t < W.vs) {
      // Solo shot: low and 3/4 front, framed off-center (P1 on the left third, P2 on the right) for the name.
      const id: PlayerId = t < W.p2 ? 'p1' : 'p2';
      const f = id === 'p1' ? 1 : -1;
      const start = id === 'p1' ? W.p1 : W.p2;
      const slamAt = id === 'p1' ? W.p1Slam : W.p2Slam;
      const end = id === 'p1' ? W.p2 : W.vs;
      const x = this.views[id].root.position.x;
      let ox: number, oy: number, oz: number, lookY: number, shift: number;
      if (t < slamAt) {
        // Before the slam: a low, wide-ish push in on the power-up.
        const k = easeOut((t - start) / (slamAt - start));
        ox = kf(k, [[0, 0.66], [1, 0.5]]);
        oy = kf(k, [[0, 0.1], [1, 0.14]]);
        oz = kf(k, [[0, 1.12], [1, 0.9]]);
        lookY = kf(k, [[0, 0.34], [1, 0.4]]);
        fov = kf(k, [[0, 42], [1, 37]]);
        shift = 0.12;
      } else {
        // The slam: cut in closer, a zoom punch that settles, then a slow drift in.
        const u = t - slamAt;
        const k = smoothstep(u / (end - slamAt));
        ox = 0.44 - 0.05 * k;
        oy = 0.2 + 0.03 * k;
        oz = 0.72 - 0.08 * k;
        lookY = 0.47;
        fov = 33 - 3 * k - 7 * Math.exp(-u * 9);
        shift = 0.2;
      }
      camera.position.set(x + f * ox, oy, oz);
      this.look.set(x, lookY, 0);
      // Screen-right from this camera; aim beside the fighter so they sit on one side of the frame.
      this.tmp.subVectors(this.look, camera.position).normalize();
      this.right.crossVectors(this.tmp, camera.up).normalize();
      this.look.addScaledVector(this.right, id === 'p1' ? shift : -shift);
      camera.lookAt(this.look);
    } else {
      // VS: both of them, low and centered, pushing in; a zoom punch on the VS slam.
      const u = t - W.vs;
      const mid = (this.views.p1.root.position.x + this.views.p2.root.position.x) / 2;
      const k = smoothstep(u / (W.end - W.vs));
      camera.position.set(mid, 0.22 + 0.04 * k, 1.38 - 0.16 * k);
      camera.lookAt(this.look.set(mid, 0.42, 0));
      fov = 38 - 2 * k - 6 * Math.exp(-u * 8);
    }
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    // The flame wipes ride on the lens.
    camera.updateMatrixWorld();
    this.wipe.fit(camera);
    const w1 = this.wipeAt(t, W.wipe1);
    const w2 = this.wipeAt(t, W.wipe2);
    if (w1) this.wipe.set(w1[0], w1[1], 1, t, PLAYER_COLORS.p1);
    else if (w2) this.wipe.set(w2[0], w2[1], -1, t, PLAYER_COLORS.p2);
    else this.wipe.set(0, 0, 1, t, '#000');
  }

  /** [cover, uncover] for a wipe starting at `at`, or null outside it. */
  private wipeAt(t: number, at: number): [number, number] | null {
    const { wipeIn, wipeOut } = WALKOUT;
    const hold = 0.1;
    if (t < at || t > at + wipeIn + hold + wipeOut) return null;
    return [Math.min(1, (t - at) / wipeIn), Math.max(0, (t - at - wipeIn - hold) / wipeOut)];
  }
}
