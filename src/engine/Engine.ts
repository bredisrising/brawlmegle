import * as THREE from 'three';
import { createArena } from './Arena';

export type FrameCallback = (dt: number, frozen: boolean) => void;

/**
 * Owns the Three.js renderer, scene, camera and render loop.
 * Game logic hooks in via onFrame(); freeze() pauses simulation for hit-stop.
 */
export class Engine {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
  readonly renderer = new THREE.WebGLRenderer({ antialias: true });

  private readonly container: HTMLElement;
  private readonly callbacks = new Set<FrameCallback>();
  private readonly resizeObserver = new ResizeObserver(() => this.resize());
  private readonly cameraHome = new THREE.Vector3(0, 0.62, 1.8);
  private readonly lookTarget = new THREE.Vector3(0, 0.5, 0);
  private frameId = 0;
  private lastTime = 0;
  private freezeTimer = 0;
  private shakeAmount = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    createArena(this.scene);
    this.camera.position.copy(this.cameraHome);
    this.camera.lookAt(this.lookTarget);

    this.resizeObserver.observe(container);
    this.resize();
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
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private loop = (now: number) => {
    this.frameId = requestAnimationFrame(this.loop);
    const dt = Math.min((now - this.lastTime) / 1000, 1 / 20);
    this.lastTime = now;

    const frozen = this.freezeTimer > 0;
    if (frozen) this.freezeTimer -= dt;
    for (const cb of this.callbacks) cb(dt, frozen);

    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private updateCamera(dt: number) {
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 0.15);
    const s = this.shakeAmount;
    this.camera.position.set(
      this.cameraHome.x + (Math.random() - 0.5) * s,
      this.cameraHome.y + (Math.random() - 0.5) * s,
      this.cameraHome.z,
    );
    this.camera.lookAt(this.lookTarget);
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
