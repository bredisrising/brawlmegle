import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createArena, type Arena } from './Arena';
import { ImpactPass } from './ImpactPass';
import { PERF, PerfMonitor } from './PerfMonitor';
import { QualityGovernor, type PoseRate } from './QualityGovernor';
import { quality, type QualityLevel } from './quality';
import { config } from '../config';

export type FrameCallback = (dt: number, frozen: boolean) => void;

/** Frame rate while an opaque screen covers the scene (see Renderer.covered). */
const COVERED_FPS = 4;

/**
 * Owns the Three.js renderer, scene, camera and render loop.
 * The game hooks in via onFrame(); freeze() pauses the sim for hit-stop while camera + VFX keep running.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
  // No canvas MSAA: everything reaches the canvas as full-screen passes (the composer's scene target has its own).
  readonly renderer = new THREE.WebGLRenderer({ antialias: false });
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass | null = null;
  /** Steps quality down when the GPU can't fit the fight and the pose tracker (see QualityGovernor). */
  readonly governor: QualityGovernor;
  /** The pose tracker on this laptop, for the governor (set by the game). */
  private poseRate: () => PoseRate | null = () => null;
  private onePose: (on: boolean) => void = () => {};
  /** Frame cap (the sim and the camera keep running on skipped frames; only drawing is skipped). */
  private maxFps = 60;
  private lastDrawn = -Infinity;
  /**
   * An opaque screen (title, fighter select, the client's waiting screen) hides the scene: draw a few frames a
   * second instead of 60, which frees the GPU for the camera while the player scans or picks. Not zero, so models that
   * load meanwhile still get their shaders compiled and textures uploaded before the fight shows them.
   */
  covered = false;
  readonly arena: Arena;
  /** Frame-time monitor (`?perf`), null otherwise. */
  readonly perf: PerfMonitor | null;

  private readonly container: HTMLElement;
  private readonly callbacks = new Set<FrameCallback>();
  private readonly resizeObserver = new ResizeObserver(() => this.resize());
  private readonly cameraHome = new THREE.Vector3(0, 0.62, 1.8);
  private readonly lookTarget = new THREE.Vector3(0, 0.5, 0);
  private frameId = 0;
  private lastTime = 0;
  private freezeTimer = 0;
  private shakeAmount = 0;
  private readonly impactPass = new ImpactPass();
  /** Camera punch-in toward a point (big hits, K.O.), easing back out. */
  private readonly punchTarget = new THREE.Vector3();
  private punchAmount = 0;
  private punchDecay = 2;
  /** Slow motion: sim time runs at `slowScale` for `slowTimer` more real seconds. */
  private slowTimer = 0;
  private slowScale = 1;
  private readonly lookNow = new THREE.Vector3();
  /** Fighting-game camera: follows the fighters' midpoint and pushes in as they close (see track()). */
  private baseZ = 1.8;
  private baseY = 0.62;
  private trackX = 0;
  private trackSpread = 0.5;
  private camX = 0;
  private zoom = 1;
  /** K.O. replay camera: a slow low sweep around the fighters (seconds into it, and how long it lasts). */
  private sweep: { t: number; duration: number } | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer.shadowMap.enabled = !config.lowPower;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);
    this.perf = PERF ? new PerfMonitor(this.renderer) : null;

    // HDR pipeline: render -> bloom (only values above 1.0, i.e. emissive/sun) -> tone map + sRGB.
    // The composer's own target is multisampled since canvas antialiasing doesn't apply to it.
    this.composer = new EffectComposer(
      this.renderer,
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: config.lowPower ? 0 : 4 }),
    );
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (!config.lowPower) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.4, 1);
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.impactPass);

    this.arena = createArena(this.scene, this.renderer, this.camera);
    this.camera.position.copy(this.cameraHome);
    this.camera.lookAt(this.lookTarget);

    this.governor = new QualityGovernor((level) => this.applyQuality(level), () => this.poseRate(), (on) => this.onePose(on));
    this.applyQuality(quality.current);
    this.resizeObserver.observe(container);
    this.resize();
  }

  /** Where the governor reads the pose tracker's rate, and turns its one-pose mode on (this laptop's camera, if any). */
  watchPose(rate: () => PoseRate | null, onePose: (on: boolean) => void) {
    this.poseRate = rate;
    this.onePose = onePose;
  }

  /** Apply a quality level: MSAA, pixel ratio, bloom, outlines, frame cap. */
  private applyQuality(level: QualityLevel) {
    const samples = config.lowPower ? 0 : level.samples;
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (target.samples === samples) continue;
      target.samples = samples;
      target.dispose(); // reallocated with the new sample count on next use
    }
    const ratio = Math.min(window.devicePixelRatio, config.lowPower ? 1.25 : 2, level.maxPixelRatio);
    if (ratio !== this.renderer.getPixelRatio()) {
      this.renderer.setPixelRatio(ratio);
      this.resize();
    }
    if (this.bloom) this.bloom.enabled = level.bloom;
    this.maxFps = level.maxFps;
    this.scene.traverse((o) => {
      if (o.userData.outline) o.visible = level.outlines;
    });
  }

  start() {
    this.lastTime = performance.now();
    this.frameId = requestAnimationFrame(this.loop);
  }

  onFrame(cb: FrameCallback) {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  /** Freeze-frame: simulation callbacks receive frozen=true for this long. */
  freeze(seconds: number) {
    this.freezeTimer = Math.max(this.freezeTimer, seconds);
  }

  shake(amount: number) {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
  }

  /** Replay camera on (a sweep around the fighters lasting `seconds`) or off. */
  cinematic(seconds: number | null) {
    this.sweep = seconds ? { t: 0, duration: seconds } : null;
  }

  /** Where the fighters are: their midpoint on x and the gap between them (world units). Call every frame. */
  track(midX: number, spread: number) {
    this.trackX = midX;
    this.trackSpread = spread;
  }

  /** Impact frame centered on a world point (see ImpactPass). */
  impact(world: THREE.Vector3, seconds: number, accent?: THREE.ColorRepresentation) {
    const v = world.clone().project(this.camera);
    this.impactPass.trigger({ x: (v.x + 1) / 2, y: (v.y + 1) / 2 }, seconds, accent);
  }

  /** Push the camera in toward a world point by `amount` (0..1 of the way), easing out over ~1/decay seconds. */
  punch(world: THREE.Vector3, amount: number, decay = 2) {
    if (amount < this.punchAmount) return;
    this.punchTarget.copy(world);
    this.punchAmount = amount;
    this.punchDecay = decay;
  }

  /** Run the simulation at `scale` speed for `seconds` of real time (K.O. slow motion). */
  slowMotion(seconds: number, scale: number) {
    this.slowTimer = seconds;
    this.slowScale = scale;
  }

  /** World position -> CSS pixel coordinates within the container (for UI popups). */
  project(world: THREE.Vector3) {
    const v = world.clone().project(this.camera);
    return {
      x: ((v.x + 1) / 2) * this.container.clientWidth,
      y: ((1 - v.y) / 2) * this.container.clientHeight,
    };
  }

  dispose() {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.arena.dispose();
    this.composer.dispose();
    this.perf?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private loop = (now: number) => {
    this.frameId = requestAnimationFrame(this.loop);
    // Frame cap: on a fast display, frames that come sooner than the cap allows aren't drawn (a 120 Hz laptop would
    // otherwise draw the same fight twice per sim tick, on a GPU the pose tracker needs). The 0.8 lets a 144 Hz
    // display draw every other frame (72 fps) instead of every third.
    const draw = now - this.lastDrawn >= (1000 / (this.covered ? COVERED_FPS : this.maxFps)) * 0.8;
    if (draw) this.perf?.begin(now);
    const dt = Math.min((now - this.lastTime) / 1000, 1 / 20);
    this.lastTime = now;

    const frozen = this.freezeTimer > 0;
    if (frozen) this.freezeTimer -= dt;
    let simDt = dt;
    if (this.slowTimer > 0) {
      this.slowTimer -= dt;
      simDt = dt * this.slowScale;
    }
    for (const cb of this.callbacks) cb(simDt, frozen);

    this.updateCamera(dt);
    this.impactPass.tick(dt, this.camera.aspect);
    this.governor.tick(now, draw, this.covered);
    if (!draw) return;
    this.lastDrawn = now;
    this.arena.update(this.camera);
    this.composer.render(dt);
    this.perf?.end();
  };

  private updateCamera(dt: number) {
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 0.15);
    const s = this.shakeAmount;
    // Ease toward the fighters' midpoint, and in when they're close (out when they're far apart).
    const ease = 1 - Math.exp(-3 * dt);
    this.camX += (this.trackX - this.camX) * ease;
    const zoom = 0.86 + 0.3 * THREE.MathUtils.clamp((this.trackSpread - 0.3) / 0.6, 0, 1);
    this.zoom += (zoom - this.zoom) * ease;
    this.cameraHome.set(this.camX * 0.85, this.baseY, this.baseZ * this.zoom);
    this.lookTarget.set(this.camX, 0.5, 0);
    if (this.sweep) {
      // Low and close, swinging from one side of the fight to the other.
      this.sweep.t += dt;
      const k = Math.min(1, this.sweep.t / this.sweep.duration);
      const angle = -0.75 + 1.5 * (k * k * (3 - 2 * k));
      const r = 1.15 * (this.baseZ / 1.8);
      this.cameraHome.set(this.camX + Math.sin(angle) * r, 0.42, Math.cos(angle) * r);
      this.lookTarget.set(this.camX, 0.42, 0);
    }
    this.punchAmount = Math.max(0, this.punchAmount - dt * this.punchDecay * Math.max(0.15, this.punchAmount));
    const p = this.punchAmount;
    this.camera.position.set(
      this.cameraHome.x + (this.punchTarget.x - this.cameraHome.x) * p + (Math.random() - 0.5) * s,
      this.cameraHome.y + (this.punchTarget.y - this.cameraHome.y) * p * 0.5 + (Math.random() - 0.5) * s,
      this.cameraHome.z + (this.punchTarget.z - this.cameraHome.z) * p,
    );
    this.camera.lookAt(this.lookNow.copy(this.lookTarget).lerp(this.punchTarget, p * 1.2));
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Narrow screens (a phone held upright): back the camera off until the fight line fits across.
    const halfWidth = 0.6;
    const z = halfWidth / (Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
    this.baseZ = Math.max(1.8, z);
    // ...and up, looking down onto the floor, so the tall frame shows arena rather than the sky and the drop below.
    this.baseY = 0.62 + (this.baseZ - 1.8) * 0.45;
  }
}
