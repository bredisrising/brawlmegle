import * as THREE from 'three';

export type EffectKind = 'hit' | 'blocked' | 'whiff' | 'counter' | 'ko' | 'spawn';
export const EFFECT_KINDS: readonly EffectKind[] = ['hit', 'blocked', 'whiff', 'counter', 'ko', 'spawn'];

/**
 * Per-kind recipe. Colors are HDR (intensity > 1 multiplies them past the bloom threshold).
 * Every layer is optional, so a new kind is just a new entry here.
 */
interface EffectSpec {
  sparks?: { count: number; color: string; intensity: number; speed: number; size: number; life: number; gravity: number; upward?: boolean };
  ring?: { color: string; intensity: number; from: number; to: number; life: number; flat?: boolean };
  flash?: { color: string; intensity: number; size: number; life: number };
  /** Comic-book impact star: sharp spikes bursting out from the hit, facing the camera. */
  spikes?: { count: number; color: string; intensity: number; length: number; width: number; life: number };
  /** A column of light from the floor (spawning in). */
  beam?: { color: string; intensity: number; radius: number; height: number; life: number };
}

const SPECS: Record<EffectKind, EffectSpec> = {
  hit: {
    sparks: { count: 18, color: '#ffb347', intensity: 6, speed: 1.6, size: 0.025, life: 0.35, gravity: 3 },
    spikes: { count: 9, color: '#fff1c9', intensity: 3, length: 0.2, width: 0.035, life: 0.12 },
    ring: { color: '#ffd28a', intensity: 3, from: 0.03, to: 0.22, life: 0.18 },
    flash: { color: '#fff1d0', intensity: 4, size: 0.25, life: 0.08 },
  },
  blocked: {
    sparks: { count: 8, color: '#8fd3ff', intensity: 4, speed: 0.9, size: 0.02, life: 0.25, gravity: 2 },
    ring: { color: '#bfe6ff', intensity: 2.5, from: 0.08, to: 0.16, life: 0.15 },
  },
  whiff: {
    ring: { color: '#ffffff', intensity: 0.6, from: 0.05, to: 0.14, life: 0.12 },
  },
  counter: {
    sparks: { count: 36, color: '#ff4a3d', intensity: 8, speed: 2.4, size: 0.03, life: 0.45, gravity: 3 },
    spikes: { count: 12, color: '#ffd84a', intensity: 5, length: 0.34, width: 0.05, life: 0.16 },
    ring: { color: '#ffcf5a', intensity: 5, from: 0.04, to: 0.35, life: 0.25 },
    flash: { color: '#fff4c2', intensity: 3, size: 0.32, life: 0.1 },
  },
  ko: {
    sparks: { count: 70, color: '#ffe08a', intensity: 10, speed: 3, size: 0.035, life: 0.8, gravity: 2.5 },
    spikes: { count: 16, color: '#ffffff', intensity: 6, length: 0.5, width: 0.06, life: 0.3 },
    ring: { color: '#ffffff', intensity: 3, from: 0.05, to: 0.6, life: 0.4 },
    flash: { color: '#ffffff', intensity: 2.5, size: 0.45, life: 0.16 },
  },
  spawn: {
    sparks: { count: 30, color: '#5ee8ff', intensity: 5, speed: 0.6, size: 0.02, life: 0.9, gravity: -0.6, upward: true },
    ring: { color: '#5ee8ff', intensity: 4, from: 0.05, to: 0.45, life: 0.5, flat: true },
    beam: { color: '#5ee8ff', intensity: 3, radius: 0.22, height: 1.1, life: 1.6 },
  },
};

/** One live layer of a burst; `step` returns false once it's finished. */
interface Layer {
  object: THREE.Object3D;
  material: THREE.Material;
  geometry?: THREE.BufferGeometry;
  step(age: number): boolean;
  age: number;
}

/**
 * Visual effects layer: spark particles, impact rings and flashes per EffectKind.
 * Rings and flashes billboard toward the camera; sparks are world-space points.
 */
export class Effects {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly layers: Layer[] = [];
  private readonly ringGeometry = new THREE.RingGeometry(0.85, 1, 48);
  private readonly glowTexture = createGlowTexture();
  private readonly beamTexture = createBeamTexture();

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
  }

  /** `color` overrides the beam color (a player's color when they spawn in). */
  burst(point: THREE.Vector3, kind: EffectKind, color?: THREE.ColorRepresentation) {
    const spec = SPECS[kind];
    const at = point.clone();
    if (spec.sparks) this.addSparks(at, spec.sparks);
    if (spec.ring) this.addRing(at, spec.ring);
    if (spec.flash) this.addFlash(at, spec.flash);
    if (spec.spikes) this.addSpikes(at, spec.spikes);
    if (spec.beam) this.addBeam(at, spec.beam, color);
  }

  /** Called every render frame (keeps animating during freeze frames). */
  update(dt: number) {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      layer.age += dt;
      if (!layer.step(layer.age)) {
        this.removeLayer(layer);
        this.layers.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const layer of this.layers) this.removeLayer(layer);
    this.layers.length = 0;
    this.ringGeometry.dispose();
    this.glowTexture.dispose();
    this.beamTexture.dispose();
  }

  private addSparks(at: THREE.Vector3, s: NonNullable<EffectSpec['sparks']>) {
    const positions = new Float32Array(s.count * 3);
    const velocities = new Float32Array(s.count * 3);
    const dir = new THREE.Vector3();
    for (let i = 0; i < s.count; i++) {
      dir.randomDirection();
      if (s.upward) dir.set(dir.x * 0.6, Math.abs(dir.y) + 0.4, dir.z * 0.6).normalize();
      dir.multiplyScalar(s.speed * (0.4 + Math.random() * 0.6));
      at.toArray(positions, i * 3);
      dir.toArray(velocities, i * 3);
    }
    const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: new THREE.Color(s.color).multiplyScalar(s.intensity),
      map: this.glowTexture,
      size: s.size,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;

    let last = 0;
    this.addLayer(points, material, geometry, (age) => {
      const dt = age - last;
      last = age;
      const attr = geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < s.count; i++) {
        velocities[i * 3 + 1] -= s.gravity * dt;
        for (let k = 0; k < 3; k++) {
          velocities[i * 3 + k] *= 1 - 2 * dt; // drag
          positions[i * 3 + k] += velocities[i * 3 + k] * dt;
        }
      }
      attr.needsUpdate = true;
      const t = age / s.life;
      material.opacity = 1 - t * t;
      return t < 1;
    });
  }

  private addRing(at: THREE.Vector3, r: NonNullable<EffectSpec['ring']>) {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(r.color).multiplyScalar(r.intensity),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(this.ringGeometry, material);
    ring.position.copy(at);
    if (r.flat) ring.rotation.x = -Math.PI / 2;

    this.addLayer(ring, material, undefined, (age) => {
      const t = age / r.life;
      const eased = 1 - (1 - t) ** 3;
      ring.scale.setScalar(THREE.MathUtils.lerp(r.from, r.to, eased));
      if (!r.flat) ring.quaternion.copy(this.camera.quaternion);
      material.opacity = 1 - t;
      return t < 1;
    });
  }

  private addFlash(at: THREE.Vector3, f: NonNullable<EffectSpec['flash']>) {
    const material = new THREE.SpriteMaterial({
      color: new THREE.Color(f.color).multiplyScalar(f.intensity),
      map: this.glowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(at);

    this.addLayer(sprite, material, undefined, (age) => {
      const t = age / f.life;
      sprite.scale.setScalar(f.size * (0.6 + 0.4 * t));
      material.opacity = 1 - t;
      return t < 1;
    });
  }

  private addSpikes(at: THREE.Vector3, k: NonNullable<EffectSpec['spikes']>) {
    // Thin triangles from the center outward at random angles and lengths, in one billboarded mesh.
    const verts: number[] = [];
    for (let i = 0; i < k.count; i++) {
      const a = ((i + Math.random() * 0.6) / k.count) * Math.PI * 2;
      const len = k.length * (0.5 + Math.random() * 0.5);
      const w = k.width * (0.6 + Math.random() * 0.4);
      const [c, s] = [Math.cos(a), Math.sin(a)];
      const base = 0.25 * len;
      verts.push(c * base - s * w, s * base + c * w, 0, c * base + s * w, s * base - c * w, 0, c * len, s * len, 0);
    }
    const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(k.color).multiplyScalar(k.intensity),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(at);
    mesh.renderOrder = 10;
    const spin = (Math.random() - 0.5) * 0.6;
    this.addLayer(mesh, material, geometry, (age) => {
      const t = age / k.life;
      // Snap out to full size almost at once, then thin out.
      mesh.scale.set(0.6 + 0.6 * Math.min(1, t * 4), 0.6 + 0.6 * Math.min(1, t * 4), 1);
      mesh.quaternion.copy(this.camera.quaternion);
      mesh.rotateZ(spin);
      material.opacity = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
      return t < 1;
    });
  }

  private addBeam(at: THREE.Vector3, b: NonNullable<EffectSpec['beam']>, color?: THREE.ColorRepresentation) {
    const geometry = new THREE.CylinderGeometry(b.radius, b.radius * 1.15, b.height, 32, 1, true);
    geometry.translate(0, b.height / 2, 0);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color ?? b.color).multiplyScalar(b.intensity),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      alphaMap: this.beamTexture,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(at.x, 0, at.z);
    this.addLayer(mesh, material, geometry, (age) => {
      const t = age / b.life;
      // Shoots up fast, holds while the fighter prints in, then narrows away.
      mesh.scale.set(t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3, Math.min(1, t * 6), t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
      material.opacity = t < 0.1 ? t * 10 : t < 0.7 ? 0.9 : 0.9 * (1 - (t - 0.7) / 0.3);
      return t < 1;
    });
  }

  private addLayer(object: THREE.Object3D, material: THREE.Material, geometry: THREE.BufferGeometry | undefined, step: Layer['step']) {
    const layer: Layer = { object, material, geometry, step, age: 0 };
    step(0);
    this.scene.add(object);
    this.layers.push(layer);
  }

  private removeLayer(layer: Layer) {
    layer.object.removeFromParent();
    layer.material.dispose();
    layer.geometry?.dispose();
  }
}

/** Soft radial falloff used for spark points and flash sprites. */
function createGlowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Vertical fade for the spawn beam: bright at the floor, gone at the top. */
function createBeamTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 64, 0, 0);
  // alphaMap reads the green channel, so this is an opaque gray ramp, not transparency.
  g.addColorStop(0, '#fff');
  g.addColorStop(0.5, '#737373');
  g.addColorStop(1, '#000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  return new THREE.CanvasTexture(canvas);
}
