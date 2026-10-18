import * as THREE from 'three';

/**
 * The walkout's fire: a burning pillar around a fighter (flame sheets that always face the camera), a glow on the
 * floor, and embers drifting up; plus the full-screen flame wipe between shots. All additive and HDR, so the bloom
 * makes them burn. Presentation only.
 */

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/** One sheet of flame: a tongue of fire rising from the bottom edge, licking up with turbulence. */
const FLAME_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime, uAmount, uSeed;
uniform vec3 uHot, uMid, uCool;
${NOISE}
void main() {
  vec2 uv = vUv;
  float t = uTime;
  vec2 q = vec2(uv.x * 2.4 + uSeed, uv.y * 1.5 - t * 1.9);
  float n = fbm(q + vec2(fbm(q * 1.8 + vec2(uSeed, -t * 2.7)) * 0.9, 0.0));
  float width = 1.0 - pow(abs(uv.x - 0.5) * 2.0, 1.6);
  float body = width * (1.2 - uv.y * 1.35);
  float f = (body + (n - 0.5) * 1.15) * uAmount;
  float a = smoothstep(0.1, 0.5, f) * smoothstep(0.0, 0.06, uv.y);
  vec3 col = mix(uCool, uMid, smoothstep(0.12, 0.5, f));
  col = mix(col, uHot, smoothstep(0.5, 1.0, f));
  gl_FragColor = vec4(col, a);
}
`;

/** A pool of firelight on the floor. */
const GLOW_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime, uAmount;
uniform vec3 uMid;
${NOISE}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float flicker = 0.75 + 0.25 * noise(vec2(uTime * 9.0, 0.0));
  float a = (1.0 - smoothstep(0.0, 1.0, r)) * uAmount * flicker;
  gl_FragColor = vec4(uMid, a * 0.8);
}
`;

const EMBER_VERT = /* glsl */ `
attribute float aLife;
attribute float aSeed;
uniform float uSize, uTime;
varying float vLife, vSeed;
void main() {
  vLife = aLife;
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float flicker = 0.6 + 0.4 * sin(uTime * 23.0 + aSeed * 40.0);
  gl_PointSize = aLife <= 0.0 ? 0.0 : uSize * (0.35 + 0.65 * aLife) * flicker / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const EMBER_FRAG = /* glsl */ `
varying float vLife, vSeed;
uniform vec3 uHot, uTint;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (vLife <= 0.0 || d > 0.5) discard;
  float a = smoothstep(0.5, 0.0, d);
  vec3 col = mix(uTint, uHot, step(0.45, fract(vSeed * 7.31)) * vLife);
  gl_FragColor = vec4(col, a * min(1.0, vLife * 2.5));
}
`;

const additive = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
  new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

const hdr = (color: THREE.ColorRepresentation, intensity: number) => new THREE.Color(color).multiplyScalar(intensity);

export type FirePalette = { hot: THREE.ColorRepresentation; mid: THREE.ColorRepresentation; cool: THREE.ColorRepresentation; tint: THREE.ColorRepresentation };

/** Fire around one fighter: sheets of flame, a floor glow and embers. `amount` drives it (0 = out). */
export class Fire {
  readonly group = new THREE.Group();
  /** 0 = out, 1 = burning, more = flaring. Eased toward `target`. */
  amount = 0;
  target = 0;
  private readonly sheets: { mesh: THREE.Mesh; material: THREE.ShaderMaterial; offset: THREE.Vector3; scale: number }[] = [];
  private readonly glow: THREE.Mesh;
  private readonly glowMaterial: THREE.ShaderMaterial;
  private readonly embers: THREE.Points;
  private readonly emberMaterial: THREE.ShaderMaterial;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly decay: Float32Array;
  private readonly count: number;
  private next = 0;
  private spawnDebt = 0;
  private time = Math.random() * 10;
  private readonly sheetGeometry = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  private readonly glowGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  constructor(palette: FirePalette, lowPower: boolean) {
    this.group.visible = false;
    // Sheets: one tall one behind, two at the sides, a low one licking at the feet in front (offsets in camera space:
    // x across the screen, z toward the camera).
    const layout: [x: number, z: number, w: number, h: number][] = lowPower
      ? [[0, -0.14, 0.75, 1.0], [0, 0.1, 0.55, 0.22]]
      : [[0, -0.16, 0.8, 1.05], [-0.2, -0.05, 0.42, 0.62], [0.21, -0.04, 0.4, 0.55], [0.0, 0.12, 0.62, 0.24], [-0.12, -0.24, 0.5, 0.85]];
    layout.forEach(([x, z, w, h], i) => {
      const material = additive(FLAME_FRAG, {
        uTime: { value: 0 },
        uAmount: { value: 0 },
        uSeed: { value: i * 3.7 + Math.random() },
        uHot: { value: hdr(palette.hot, 3.2) },
        uMid: { value: hdr(palette.mid, 2.2) },
        uCool: { value: hdr(palette.cool, 1.1) },
      });
      const mesh = new THREE.Mesh(this.sheetGeometry, material);
      mesh.scale.set(w, h, 1);
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.sheets.push({ mesh, material, offset: new THREE.Vector3(x, 0, z), scale: h });
    });
    this.glowMaterial = additive(GLOW_FRAG, { uTime: { value: 0 }, uAmount: { value: 0 }, uMid: { value: hdr(palette.mid, 1.4) } });
    this.glow = new THREE.Mesh(this.glowGeometry, this.glowMaterial);
    this.glow.scale.setScalar(1.3);
    this.glow.position.y = 0.012;
    this.group.add(this.glow);

    this.count = lowPower ? 60 : 220;
    this.pos = new Float32Array(this.count * 3);
    this.vel = new Float32Array(this.count * 3);
    this.life = new Float32Array(this.count);
    this.decay = new Float32Array(this.count);
    const seeds = new Float32Array(this.count).map(() => Math.random());
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geometry.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.emberMaterial = new THREE.ShaderMaterial({
      vertexShader: EMBER_VERT,
      fragmentShader: EMBER_FRAG,
      uniforms: { uSize: { value: 26 }, uTime: { value: 0 }, uHot: { value: hdr(palette.hot, 4) }, uTint: { value: hdr(palette.tint, 3) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.embers = new THREE.Points(geometry, this.emberMaterial);
    this.embers.frustumCulled = false;
    this.embers.renderOrder = 6;
    this.group.add(this.embers);
  }

  /** Throw a burst of embers out (a slam). */
  burst(n: number, speed = 1.4) {
    for (let i = 0; i < n; i++) this.spawn(speed, true);
  }

  /** Put it out now (no embers left either). */
  clear() {
    this.amount = this.target = 0;
    this.life.fill(0);
    this.group.visible = false;
  }

  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    // Flares rise fast and settle slower.
    const rate = this.target > this.amount ? 18 : 3.5;
    this.amount += (this.target - this.amount) * (1 - Math.exp(-rate * dt));
    const alive = this.amount > 0.01 || this.life.some((l) => l > 0);
    this.group.visible = alive;
    if (!alive) return;
    // Sheets face the camera (turning about the vertical only) and sit around the fighter in camera space.
    const toCam = new THREE.Vector3().subVectors(camera.position, this.group.position).setY(0).normalize();
    const across = new THREE.Vector3(toCam.z, 0, -toCam.x);
    const angle = Math.atan2(toCam.x, toCam.z);
    for (const s of this.sheets) {
      s.mesh.position.copy(across).multiplyScalar(s.offset.x).addScaledVector(toCam, s.offset.z);
      s.mesh.rotation.y = angle;
      s.mesh.scale.y = s.scale * (0.55 + 0.45 * Math.min(1.6, this.amount));
      s.material.uniforms.uTime.value = this.time;
      s.material.uniforms.uAmount.value = Math.min(1.5, this.amount);
    }
    this.glowMaterial.uniforms.uTime.value = this.time;
    this.glowMaterial.uniforms.uAmount.value = Math.min(1.2, this.amount);
    this.emberMaterial.uniforms.uTime.value = this.time;
    // Embers: a steady stream while it burns, rising and swirling, fading out.
    this.spawnDebt += dt * 90 * Math.min(1.5, this.amount);
    while (this.spawnDebt >= 1) {
      this.spawn(1, false);
      this.spawnDebt--;
    }
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt * this.decay[i];
      const j = i * 3;
      const swirl = Math.sin(this.time * 3 + i) * 0.35;
      this.vel[j] += swirl * dt;
      this.vel[j + 1] += 0.25 * dt; // heat lifts them
      this.vel[j + 2] += Math.cos(this.time * 2.6 + i * 1.7) * 0.3 * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
    }
    this.embers.geometry.attributes.position.needsUpdate = true;
    this.embers.geometry.attributes.aLife.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    for (const s of this.sheets) s.material.dispose();
    this.sheetGeometry.dispose();
    this.glowGeometry.dispose();
    this.glowMaterial.dispose();
    this.embers.geometry.dispose();
    this.emberMaterial.dispose();
  }

  private spawn(speed: number, burst: boolean) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    const j = i * 3;
    const a = Math.random() * Math.PI * 2;
    const r = burst ? 0.05 + Math.random() * 0.12 : 0.08 + Math.random() * 0.26;
    this.pos[j] = Math.cos(a) * r;
    this.pos[j + 1] = burst ? 0.15 + Math.random() * 0.45 : Math.random() * 0.15;
    this.pos[j + 2] = Math.sin(a) * r;
    const out = burst ? speed * (0.5 + Math.random()) : 0.08;
    this.vel[j] = Math.cos(a) * out;
    this.vel[j + 1] = burst ? speed * (0.3 + Math.random() * 0.8) : 0.35 + Math.random() * 0.6;
    this.vel[j + 2] = Math.sin(a) * out;
    this.life[i] = 1;
    this.decay[i] = burst ? 0.9 + Math.random() * 0.8 : 0.6 + Math.random() * 0.6;
  }
}

/** The flame wipe: a wall of fire that sweeps across the screen, holds it for the cut, and burns away. */
const WIPE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uIn, uOut, uDir, uTime, uAspect;
uniform vec3 uHot, uMid, uCool, uTint;
${NOISE}
void main() {
  vec2 uv = vUv;
  float x = uDir > 0.0 ? uv.x : 1.0 - uv.x;
  // A slanted front, ragged with turbulence that races along it.
  vec2 q = vec2(uv.x * uAspect * 3.0, uv.y * 3.0 - uTime * 2.2);
  float n = fbm(q + fbm(q * 2.1 + uTime * 1.3));
  float front = x + (uv.y - 0.5) * 0.4 + (n - 0.5) * 0.55;
  float cover = 1.0 - smoothstep(-0.12, 0.12, front - (uIn * 1.9 - 0.45));
  float gone = smoothstep(-0.12, 0.12, front - (uOut * 1.9 - 0.45));
  float m = cover * (1.0 - (1.0 - gone) * step(0.0001, uOut));
  if (m <= 0.002) discard;
  // Heat: hottest where the fire is thick, darker reds at the ragged edges, a pulse of turbulence through it.
  float heat = m * (0.55 + 0.75 * n);
  vec3 col = mix(uCool, uMid, smoothstep(0.15, 0.55, heat));
  col = mix(col, uHot, smoothstep(0.65, 1.05, heat));
  col = mix(col, uTint, 0.25 * (1.0 - smoothstep(0.3, 0.8, heat)));
  gl_FragColor = vec4(col, smoothstep(0.0, 0.35, m));
}
`;

export class FlameWipe {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: WIPE_FRAG,
      uniforms: {
        uIn: { value: 0 },
        uOut: { value: 0 },
        uDir: { value: 1 },
        uTime: { value: 0 },
        uAspect: { value: 1.6 },
        uHot: { value: hdr('#fff4c8', 2.4) },
        uMid: { value: hdr('#ff8a1e', 1.6) },
        uCool: { value: hdr('#a3120a', 0.9) },
        uTint: { value: hdr('#ff2d95', 1.2) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = 100;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** `cover` 0..1 sweeps it in, `uncover` 0..1 burns it away; `dir` 1 sweeps left to right. */
  set(cover: number, uncover: number, dir: 1 | -1, time: number, tint: THREE.ColorRepresentation) {
    const u = this.material.uniforms;
    u.uIn.value = cover;
    u.uOut.value = uncover;
    u.uDir.value = dir;
    u.uTime.value = time;
    (u.uTint.value as THREE.Color).copy(hdr(tint, 1.3));
    this.mesh.visible = cover > 0 && uncover < 1;
  }

  /** Glue it over the camera's view (call after the camera moved). */
  fit(camera: THREE.PerspectiveCamera) {
    const d = camera.near * 1.5;
    const h = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    this.mesh.position.copy(camera.position);
    this.mesh.quaternion.copy(camera.quaternion);
    this.mesh.translateZ(-d);
    this.mesh.scale.set(h * camera.aspect * 1.02, h * 1.02, 1);
    this.material.uniforms.uAspect.value = camera.aspect;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
