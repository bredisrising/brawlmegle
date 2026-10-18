import * as THREE from 'three';

export type EffectKind = 'hit' | 'blocked' | 'whiff' | 'counter' | 'ko' | 'spawn' | 'dust';
export const EFFECT_KINDS: readonly EffectKind[] = ['hit', 'blocked', 'whiff', 'counter', 'ko', 'spawn', 'dust'];

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
  // A body hitting the floor.
  dust: {
    sparks: { count: 40, color: '#b8a98f', intensity: 0.9, speed: 0.7, size: 0.05, life: 0.9, gravity: 0.8, upward: true },
    ring: { color: '#d8ccb4', intensity: 0.8, from: 0.1, to: 0.7, life: 0.5, flat: true },
  },
};

/** Room in a pooled spark / spike buffer: the biggest burst any kind throws. */
const MAX_SPARKS = Math.max(...Object.values(SPECS).map((s) => s.sparks?.count ?? 0));
const MAX_SPIKES = Math.max(...Object.values(SPECS).map((s) => s.spikes?.count ?? 0));

type LayerKind = 'sparks' | 'ring' | 'flash' | 'spikes' | 'beam';

/**
 * One live layer of a burst. Layers are pooled: the objects, materials and buffers are made once and reused, so a
 * hit allocates nothing and, above all, never disposes a material. Disposing the last material of a kind deletes its
 * shader program, and the next hit had to compile it again (a 50+ ms freeze on the frame of the hit).
 */
interface Layer {
  kind: LayerKind;
  object: THREE.Object3D;
  age: number;
  /** false once the layer is finished. */
  step(age: number): boolean;
}

/**
 * Visual effects layer: spark particles, impact rings and flashes per EffectKind.
 * Rings and flashes billboard toward the camera; sparks are world-space points.
 */
export class Effects {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly layers: Layer[] = [];
  private readonly free: Record<LayerKind, Layer[]> = { sparks: [], ring: [], flash: [], spikes: [], beam: [] };
  private readonly all: Layer[] = [];
  private readonly ringGeometry = new THREE.RingGeometry(0.85, 1, 48);
  private readonly beamGeometries = new Map<string, THREE.CylinderGeometry>();
  private readonly glowTexture = createGlowTexture();
  private readonly beamTexture = createBeamTexture();
  /** Frames left until the warm-up layers go back to the pool. */
  private warmFrames = 2;
  private readonly warm: Layer[] = [];

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.scene = scene;
    this.camera = camera;
    // Draw one of each layer, invisibly, on the first frames (the title screen), so every effect's shader is compiled
    // before the first hit of a fight.
    const at = new THREE.Vector3(0, 0.5, 0);
    for (const kind of ['sparks', 'ring', 'flash', 'spikes', 'beam'] as LayerKind[]) {
      const spec = Object.values(SPECS).find((s) => s[kind]);
      if (!spec) continue;
      const layer = this.start(kind, at, spec[kind] as never);
      this.setOpacity(layer, 0);
      this.warm.push(layer);
    }
  }

  /** `color` overrides the beam color (a player's color when they spawn in). */
  burst(point: THREE.Vector3, kind: EffectKind, color?: THREE.ColorRepresentation) {
    const spec = SPECS[kind];
    if (spec.sparks) this.layers.push(this.start('sparks', point, spec.sparks));
    if (spec.ring) this.layers.push(this.start('ring', point, spec.ring));
    if (spec.flash) this.layers.push(this.start('flash', point, spec.flash));
    if (spec.spikes) this.layers.push(this.start('spikes', point, spec.spikes));
    if (spec.beam) this.layers.push(this.start('beam', point, spec.beam, color));
  }

  /** Called every render frame (keeps animating during freeze frames). */
  update(dt: number) {
    if (this.warmFrames > 0 && --this.warmFrames === 0) {
      for (const layer of this.warm) this.release(layer);
      this.warm.length = 0;
    }
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      layer.age += dt;
      if (!layer.step(layer.age)) {
        this.release(layer);
        this.layers.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const layer of this.all) {
      layer.object.removeFromParent();
      const o = layer.object as THREE.Mesh;
      (o.material as THREE.Material).dispose();
      // Only sparks and spikes own their buffers (rings and beams share theirs, sprites use three's shared quad).
      if (layer.kind === 'sparks' || layer.kind === 'spikes') o.geometry.dispose();
    }
    this.layers.length = 0;
    this.all.length = 0;
    this.ringGeometry.dispose();
    for (const g of this.beamGeometries.values()) g.dispose();
    this.glowTexture.dispose();
    this.beamTexture.dispose();
  }

  /** A layer of `kind` from the pool (made if none is free), started at `at` and added to the scene. */
  private start<K extends LayerKind>(kind: K, at: THREE.Vector3, spec: NonNullable<EffectSpec[K]>, color?: THREE.ColorRepresentation): Layer {
    const pool = this.free[kind];
    let layer = pool.pop();
    if (!layer) {
      layer = this.make(kind);
      this.all.push(layer);
    }
    this.init(layer, at, spec as never, color);
    layer.age = 0;
    layer.step(0);
    this.scene.add(layer.object);
    return layer;
  }

  private release(layer: Layer) {
    layer.object.removeFromParent();
    this.free[layer.kind].push(layer);
  }

  private setOpacity(layer: Layer, opacity: number) {
    ((layer.object as THREE.Mesh).material as THREE.Material).opacity = opacity;
  }

  private make(kind: LayerKind): Layer {
    const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };
    switch (kind) {
      case 'sparks': {
        const positions = new Float32Array(MAX_SPARKS * 3);
        const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const points = new THREE.Points(geometry, new THREE.PointsMaterial({ map: this.glowTexture, ...additive }));
        points.frustumCulled = false;
        return new SparkLayer(points, positions);
      }
      case 'ring': {
        const mesh = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({ ...additive, side: THREE.DoubleSide }));
        return new RingLayer(mesh, this.camera);
      }
      case 'flash':
        return new FlashLayer(new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTexture, ...additive })));
      case 'spikes': {
        const positions = new Float32Array(MAX_SPIKES * 9);
        const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ ...additive, depthTest: false, side: THREE.DoubleSide }));
        mesh.renderOrder = 10;
        // The buffer is rewritten per burst: its bounding sphere would be stale. It's always at the hit anyway.
        mesh.frustumCulled = false;
        return new SpikeLayer(mesh, positions, this.camera);
      }
      case 'beam': {
        const mesh = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ ...additive, side: THREE.DoubleSide, alphaMap: this.beamTexture }));
        return new BeamLayer(mesh);
      }
    }
  }

  private init(layer: Layer, at: THREE.Vector3, spec: never, color?: THREE.ColorRepresentation) {
    if (layer instanceof BeamLayer) {
      const b = spec as NonNullable<EffectSpec['beam']>;
      const key = `${b.radius}:${b.height}`;
      let geometry = this.beamGeometries.get(key);
      if (!geometry) {
        geometry = new THREE.CylinderGeometry(b.radius, b.radius * 1.15, b.height, 32, 1, true);
        geometry.translate(0, b.height / 2, 0);
        this.beamGeometries.set(key, geometry);
      }
      layer.mesh.geometry = geometry;
      layer.init(at, b, color);
    } else {
      (layer as SparkLayer | RingLayer | FlashLayer | SpikeLayer).init(at, spec);
    }
  }
}

/** HDR color of a layer: the spec's color times its intensity. */
function hdr(out: THREE.Color, color: THREE.ColorRepresentation, intensity: number) {
  return out.set(color).multiplyScalar(intensity);
}

const dir = new THREE.Vector3();

class SparkLayer implements Layer {
  readonly kind = 'sparks';
  age = 0;
  private readonly velocities = new Float32Array(MAX_SPARKS * 3);
  private spec!: NonNullable<EffectSpec['sparks']>;
  private last = 0;
  private readonly material: THREE.PointsMaterial;
  private readonly attr: THREE.BufferAttribute;

  constructor(readonly object: THREE.Points, private readonly positions: Float32Array) {
    this.material = object.material as THREE.PointsMaterial;
    this.attr = object.geometry.attributes.position as THREE.BufferAttribute;
  }

  init(at: THREE.Vector3, s: NonNullable<EffectSpec['sparks']>) {
    this.spec = s;
    this.last = 0;
    const { positions, velocities } = this;
    for (let i = 0; i < s.count; i++) {
      dir.randomDirection();
      if (s.upward) dir.set(dir.x * 0.6, Math.abs(dir.y) + 0.4, dir.z * 0.6).normalize();
      dir.multiplyScalar(s.speed * (0.4 + Math.random() * 0.6));
      at.toArray(positions, i * 3);
      dir.toArray(velocities, i * 3);
    }
    this.object.geometry.setDrawRange(0, s.count);
    hdr(this.material.color, s.color, s.intensity);
    this.material.size = s.size;
  }

  step(age: number) {
    const s = this.spec;
    const dt = age - this.last;
    this.last = age;
    const { positions, velocities } = this;
    for (let i = 0; i < s.count; i++) {
      velocities[i * 3 + 1] -= s.gravity * dt;
      for (let k = 0; k < 3; k++) {
        velocities[i * 3 + k] *= 1 - 2 * dt; // drag
        positions[i * 3 + k] += velocities[i * 3 + k] * dt;
      }
    }
    this.attr.needsUpdate = true;
    const t = age / s.life;
    this.material.opacity = 1 - t * t;
    return t < 1;
  }
}

class RingLayer implements Layer {
  readonly kind = 'ring';
  age = 0;
  private spec!: NonNullable<EffectSpec['ring']>;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(readonly object: THREE.Mesh, private readonly camera: THREE.Camera) {
    this.material = object.material as THREE.MeshBasicMaterial;
  }

  init(at: THREE.Vector3, r: NonNullable<EffectSpec['ring']>) {
    this.spec = r;
    hdr(this.material.color, r.color, r.intensity);
    this.object.position.copy(at);
    this.object.rotation.set(r.flat ? -Math.PI / 2 : 0, 0, 0);
  }

  step(age: number) {
    const r = this.spec;
    const t = age / r.life;
    const eased = 1 - (1 - t) ** 3;
    this.object.scale.setScalar(THREE.MathUtils.lerp(r.from, r.to, eased));
    if (!r.flat) this.object.quaternion.copy(this.camera.quaternion);
    this.material.opacity = 1 - t;
    return t < 1;
  }
}

class FlashLayer implements Layer {
  readonly kind = 'flash';
  age = 0;
  private spec!: NonNullable<EffectSpec['flash']>;

  constructor(readonly object: THREE.Sprite) {}

  init(at: THREE.Vector3, f: NonNullable<EffectSpec['flash']>) {
    this.spec = f;
    hdr(this.object.material.color, f.color, f.intensity);
    this.object.position.copy(at);
  }

  step(age: number) {
    const f = this.spec;
    const t = age / f.life;
    this.object.scale.setScalar(f.size * (0.6 + 0.4 * t));
    this.object.material.opacity = 1 - t;
    return t < 1;
  }
}

class SpikeLayer implements Layer {
  readonly kind = 'spikes';
  age = 0;
  private spec!: NonNullable<EffectSpec['spikes']>;
  private spin = 0;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(readonly object: THREE.Mesh, private readonly positions: Float32Array, private readonly camera: THREE.Camera) {
    this.material = object.material as THREE.MeshBasicMaterial;
  }

  init(at: THREE.Vector3, k: NonNullable<EffectSpec['spikes']>) {
    this.spec = k;
    // Thin triangles from the center outward at random angles and lengths, in one billboarded mesh.
    const p = this.positions;
    for (let i = 0; i < k.count; i++) {
      const a = ((i + Math.random() * 0.6) / k.count) * Math.PI * 2;
      const len = k.length * (0.5 + Math.random() * 0.5);
      const w = k.width * (0.6 + Math.random() * 0.4);
      const c = Math.cos(a);
      const s = Math.sin(a);
      const base = 0.25 * len;
      p.set([c * base - s * w, s * base + c * w, 0, c * base + s * w, s * base - c * w, 0, c * len, s * len, 0], i * 9);
    }
    const geometry = this.object.geometry;
    (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    geometry.setDrawRange(0, k.count * 3);
    hdr(this.material.color, k.color, k.intensity);
    this.object.position.copy(at);
    this.spin = (Math.random() - 0.5) * 0.6;
  }

  step(age: number) {
    const k = this.spec;
    const t = age / k.life;
    // Snap out to full size almost at once, then thin out.
    const grow = 0.6 + 0.6 * Math.min(1, t * 4);
    this.object.scale.set(grow, grow, 1);
    this.object.quaternion.copy(this.camera.quaternion);
    this.object.rotateZ(this.spin);
    this.material.opacity = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
    return t < 1;
  }
}

class BeamLayer implements Layer {
  readonly kind = 'beam';
  age = 0;
  private spec!: NonNullable<EffectSpec['beam']>;
  readonly object: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(readonly mesh: THREE.Mesh) {
    this.object = mesh;
    this.material = mesh.material as THREE.MeshBasicMaterial;
  }

  init(at: THREE.Vector3, b: NonNullable<EffectSpec['beam']>, color?: THREE.ColorRepresentation) {
    this.spec = b;
    hdr(this.material.color, color ?? b.color, b.intensity);
    this.mesh.position.set(at.x, 0, at.z);
  }

  step(age: number) {
    const b = this.spec;
    const t = age / b.life;
    // Shoots up fast, holds while the fighter prints in, then narrows away.
    const narrow = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    this.mesh.scale.set(narrow, Math.min(1, t * 6), narrow);
    this.material.opacity = t < 0.1 ? t * 10 : t < 0.7 ? 0.9 : 0.9 * (1 - (t - 0.7) / 0.3);
    return t < 1;
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
