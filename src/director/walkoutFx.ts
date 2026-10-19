import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BEAT } from './walkoutTiming';

/**
 * The walkout's stage: fire (cel-shaded flame sheets that always face the camera, a floor glow, embers) for the VS
 * burst, the night stage (dome, spotlights and beams, haze, motes) and the burning VS letters. Presentation only.
 */

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  // Rotating each octave hides the value noise's grid.
  float v = 0.0, a = 0.5;
  mat2 r = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = r * p + 17.1; a *= 0.5; }
  return v;
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/**
 * One sheet of flame: tongues of fire rising from the bottom edge. Cel-shaded like the fighters: three hard bands
 * (dark edge, body, hot core) instead of a soft gradient, and the turbulence steps on twos (12 fps) like hand-drawn fire.
 */
const FLAME_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime, uAmount, uSeed;
uniform vec3 uHot, uMid, uCool;
${NOISE}
void main() {
  vec2 uv = vUv;
  float t = floor(uTime * 12.0) / 12.0;
  vec2 q = vec2(uv.x * 2.6 + uSeed, uv.y * 1.7 - t * 2.1);
  float n = fbm(q + vec2(fbm(q * 1.9 + vec2(uSeed, -t * 2.9)) * 1.1, 0.0));
  float width = 1.0 - pow(abs(uv.x - 0.5) * 2.0, 1.4);
  float body = width * (1.25 - uv.y * 1.45);
  // Fade the field to nothing before the sheet's edges, so no straight cut ever shows.
  float edge = smoothstep(1.0, 0.7, uv.y) * smoothstep(0.0, 0.18, uv.x) * smoothstep(1.0, 0.82, uv.x);
  float f = (body + (n - 0.5) * 1.35) * uAmount * edge;
  float a = smoothstep(0.34, 0.37, f) * smoothstep(0.0, 0.05, uv.y);
  if (a <= 0.0) discard;
  vec3 col = f < 0.52 ? uCool : f < 0.8 ? uMid : uHot;
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

const sheet = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, blending: THREE.Blending) =>
  new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending,
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
      ? [[0, -0.18, 0.6, 0.8], [0, 0.12, 0.5, 0.16]]
      : [[0, -0.2, 0.62, 0.85], [-0.2, -0.08, 0.34, 0.5], [0.21, -0.07, 0.32, 0.44], [0.0, 0.14, 0.55, 0.17], [-0.1, -0.28, 0.42, 0.7]];
    layout.forEach(([x, z, w, h], i) => {
      // Flat, not additive: the bands stay crisp like painted fire instead of blowing out to white.
      const material = sheet(FLAME_FRAG, {
        uTime: { value: 0 },
        uAmount: { value: 0 },
        uSeed: { value: i * 3.7 + Math.random() },
        uHot: { value: hdr(palette.hot, 1.2) },
        uMid: { value: hdr(palette.mid, 0.85) },
        uCool: { value: hdr(palette.cool, 0.6) },
      }, THREE.NormalBlending);
      const mesh = new THREE.Mesh(this.sheetGeometry, material);
      mesh.scale.set(w, h, 1);
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.sheets.push({ mesh, material, offset: new THREE.Vector3(x, 0, z), scale: h });
    });
    this.glowMaterial = sheet(GLOW_FRAG, { uTime: { value: 0 }, uAmount: { value: 0 }, uMid: { value: hdr(palette.mid, 0.35) } }, THREE.AdditiveBlending);
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
      uniforms: { uSize: { value: 26 }, uTime: { value: 0 }, uHot: { value: hdr(palette.hot, 1.6) }, uTint: { value: hdr(palette.tint, 1.2) } },
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


/**
 * Night falls on the stage for the walkout: a near-black dome close around the stage (it hides the sky and hills), with
 * neon strips and a row of stage lamps as the only bright things in the dark; a key spotlight on each fighter from high
 * in front with its beam drawn through the haze, a rim spotlight from behind; slow beams sweeping the back, a little
 * haze over the floor and dust in the light. The director dims the arena's own lights while it's up. `amount` 0..1
 * fades it all.
 */
const DOME_FRAG = /* glsl */ `
varying vec3 vDir;
uniform float uTime, uAmount;
${NOISE}
void main() {
  vec3 d = normalize(vDir);
  float az = atan(d.x, d.z);
  float h = d.y;
  // Black, with the faintest cold haze at the horizon.
  vec3 col = mix(vec3(0.004, 0.004, 0.008), vec3(0.018, 0.014, 0.03), exp(-abs(h - 0.03) * 12.0));
  // Neon strips: short bars at a few heights, teal and magenta, bright enough to bloom.
  float seg = fract(az * 2.2 + 0.3);
  float bar1 = smoothstep(0.005, 0.0, abs(h - 0.16)) * step(0.15, seg) * step(seg, 0.55);
  float bar2 = smoothstep(0.005, 0.0, abs(h - 0.27)) * step(0.6, fract(az * 1.7)) * step(fract(az * 1.7), 0.85);
  float bar3 = smoothstep(0.004, 0.0, abs(h - 0.09)) * step(0.7, fract(az * 3.1 + 0.5));
  col += vec3(0.1, 1.1, 1.0) * bar1 + vec3(2.0, 0.2, 1.3) * bar2 + vec3(0.2, 0.9, 1.1) * bar3 * 0.7;
  // Stage lamps: a row of hot points up in the rig.
  vec2 lamp = vec2(fract(az * 4.0) - 0.5, (h - 0.42) * 7.0);
  col += vec3(4.0, 3.4, 2.6) * smoothstep(0.06, 0.0, length(lamp));
  // Crowd: a dark band with the odd phone light, under the strips.
  float crowd = smoothstep(0.06, 0.0, abs(h - 0.015));
  float phone = step(0.985, noise(vec2(az * 260.0, floor(uTime * 3.0) + floor(h * 300.0))));
  col += vec3(0.6, 0.65, 0.8) * phone * crowd;
  gl_FragColor = vec4(col * uAmount, 1.0);
}
`;
const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/** A cone of light through the haze: brightest at the lamp and along the axis, fading at the edges and the far end. */
const BEAM_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalV, vViewV;
uniform vec3 uColor;
uniform float uAmount, uTime;
void main() {
  float along = vUv.y; // 1 at the lamp (the tip), 0 at the far end
  float edge = pow(abs(dot(normalize(vNormalV), normalize(vViewV))), 1.8);
  float flicker = 0.93 + 0.07 * sin(uTime * 7.0 + along * 5.0);
  float a = edge * smoothstep(0.0, 0.5, along) * (0.25 + 1.4 * along * along) * uAmount * flicker;
  gl_FragColor = vec4(uColor * a, a);
}
`;
const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalV, vViewV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalMatrix * normal;
  vViewV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

/** A soft round glow (a lamp's flare), additive and HDR so the bloom spreads it. */
const GLOW_SPRITE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform vec3 uColor;
uniform float uAmount;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = (exp(-d * d * 9.0) + 0.25 * exp(-d * 2.5)) * uAmount;
  gl_FragColor = vec4(uColor * a, a);
}
`;

/** The warm haze at the back of the club, lit by the lanterns: what the crowd stands out against. */
const BACKGLOW_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime, uAmount;
uniform vec3 uColor;
${NOISE}
void main() {
  float y = vUv.y;
  float band = exp(-pow((y - 0.33) / 0.2, 2.0)) + 0.35 * exp(-pow((y - 0.6) / 0.25, 2.0));
  float across = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
  float n = fbm(vec2(vUv.x * 4.0 + uTime * 0.03, y * 2.5 - uTime * 0.02));
  float a = band * across * (0.55 + 0.6 * n) * uAmount;
  gl_FragColor = vec4(uColor * a, a);
}
`;

/** Haze: a soft sheet of drifting smoke. */
const HAZE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime, uAmount, uSeed;
uniform vec3 uColor;
${NOISE}
void main() {
  vec2 q = vUv * vec2(3.0, 1.5) + vec2(uTime * 0.05 + uSeed, uSeed);
  float n = fbm(q + fbm(q * 1.5 - uTime * 0.03));
  float fade = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x) * smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.4, vUv.y);
  float a = smoothstep(0.4, 0.95, n) * fade * uAmount * 0.16;
  gl_FragColor = vec4(uColor * a, a);
}
`;

/**
 * The club's crowd: dark figures all round the stage, edged with the lanterns' warm light, bouncing on the beat; some
 * with both arms up, some pumping a fist, some holding a phone up. Instanced: one draw for the bodies, one for the arms.
 */
const CROWD_VERT = /* glsl */ `
varying vec3 vNormalV, vViewV;
varying float vDepth;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 mv = viewMatrix * m * vec4(position, 1.0);
  vNormalV = normalize(mat3(viewMatrix) * mat3(m) * normal);
  vViewV = -mv.xyz;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const CROWD_FRAG = /* glsl */ `
varying vec3 vNormalV, vViewV;
varying float vDepth;
uniform vec3 uRim, uCool;
uniform float uAmount;
void main() {
  vec3 n = normalize(vNormalV);
  float rim = pow(1.0 - abs(dot(n, normalize(vViewV))), 4.0);
  // Black shapes against the haze, a thin warm edge from the lanterns above, a cold neon one from below.
  vec3 col = vec3(0.006, 0.005, 0.007) + uRim * rim * smoothstep(-0.2, 0.7, n.y) + uCool * rim * 0.4 * smoothstep(0.2, -0.6, n.y);
  col *= mix(1.0, 0.4, smoothstep(2.5, 6.0, vDepth));
  gl_FragColor = vec4(col * uAmount, 1.0);
}
`;

type Fan = { x: number; z: number; scale: number; build: number; phase: number; mode: number; face: number };

export class Crowd {
  readonly group = new THREE.Group();
  private readonly bodies: THREE.InstancedMesh;
  private readonly arms: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly fans: Fan[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly lean = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly shoulder = new THREE.Vector3();

  constructor(lowPower: boolean) {
    // A body (legs, torso, shoulders and head as one piece) and an arm hanging from its shoulder (the origin).
    const parts = [
      new THREE.CapsuleGeometry(0.068, 0.3, 3, 8).translate(0, 0.2, 0),
      new THREE.CapsuleGeometry(0.082, 0.2, 4, 10).translate(0, 0.5, 0),
      new THREE.SphereGeometry(1, 12, 8).scale(0.13, 0.055, 0.075).translate(0, 0.64, 0),
      new THREE.SphereGeometry(0.058, 12, 10).scale(1, 1.12, 1).translate(0, 0.77, 0),
    ];
    const body = mergeGeometries(parts);
    for (const g of parts) g.dispose();
    const arm = new THREE.CapsuleGeometry(0.024, 0.26, 3, 6).translate(0, -0.155, 0);
    this.geometries.push(body, arm);
    this.material = new THREE.ShaderMaterial({
      vertexShader: CROWD_VERT,
      fragmentShader: CROWD_FRAG,
      uniforms: { uRim: { value: hdr('#ff9a4a', 0.45) }, uCool: { value: hdr('#3fd8ff', 0.35) }, uAmount: { value: 0 } },
    });
    // Rows behind the stage and banks at the sides, packed loosely, everyone facing the middle.
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const rows: [z: number, from: number, to: number, n: number][] = lowPower
      ? [[-2.2, -2.4, 2.4, 11], [-3.0, -3.0, 3.0, 12]]
      : [[-2.0, -2.2, 2.2, 14], [-2.5, -2.7, 2.7, 17], [-3.1, -3.2, 3.2, 19], [-3.8, -3.8, 3.8, 21]];
    for (const [z, from, to, n] of rows) {
      for (let i = 0; i < n; i++) {
        const x = from + ((to - from) * (i + 0.5 + (rand() - 0.5) * 0.7)) / n;
        this.fans.push({ x, z: z + (rand() - 0.5) * 0.3, scale: 0.98 + rand() * 0.28, build: 0.88 + rand() * 0.3, phase: rand(), mode: Math.floor(rand() * 4), face: 0 });
      }
    }
    if (!lowPower) {
      for (const side of [-1, 1]) {
        for (let i = 0; i < 10; i++) {
          const x = side * (1.7 + rand() * 1.2);
          const z = -1.4 + (1.8 * i) / 9 + (rand() - 0.5) * 0.2;
          this.fans.push({ x, z, scale: 0.98 + rand() * 0.28, build: 0.88 + rand() * 0.3, phase: rand(), mode: Math.floor(rand() * 4), face: 0 });
        }
      }
    }
    for (const f of this.fans) f.face = Math.atan2(-f.x, -f.z + 0.6);
    this.bodies = new THREE.InstancedMesh(body, this.material, this.fans.length);
    this.arms = new THREE.InstancedMesh(arm, this.material, this.fans.length * 2);
    for (const mesh of [this.bodies, this.arms]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  /** `beat`: seconds into the groove (the walkout track's drop); `amount` fades them with the stage. */
  update(beat: number, time: number, amount: number) {
    this.material.uniforms.uAmount.value = amount;
    this.fans.forEach((f, i) => {
      // Down on the beat, everyone a little off it; hyped once the beat drops.
      const hype = beat > 0 ? 1 : 0.35;
      const c = Math.cos((2 * Math.PI * (beat + f.phase * 0.12)) / BEAT);
      const bob = 0.03 * ((1 + c) / 2) ** 2 * hype;
      // Swaying side to side with the beat, each at their own lean.
      const sway = (0.05 * Math.sin((Math.PI * (beat + f.phase * 0.3)) / BEAT) * hype + (f.phase - 0.5) * 0.08);
      this.q.setFromEuler(this.e.set(0, f.face, sway, 'YXZ'));
      this.s.set(f.scale * f.build, f.scale, f.scale * f.build);
      this.m.compose(this.v.set(f.x, -bob * f.scale, f.z), this.q, this.s);
      this.bodies.setMatrixAt(i, this.m);
      const body = this.lean.copy(this.q);
      for (const side of [-1, 1] as const) {
        // Raise: 0 = hanging, PI = straight up; out: a little out to the side.
        let raise = 0.25;
        const wave = Math.sin(time * 2.2 + f.phase * 6 + side);
        if (f.mode === 0) raise = (2.6 + 0.2 * wave) * hype + 0.25 * (1 - hype);
        else if (f.mode === 1 && side === 1) raise = 0.25 + (2.4 + 0.5 * (1 - (1 + c) / 2)) * hype;
        else if (f.mode === 3 && side === -1) raise = 2.3 * hype + 0.25;
        const facing = this.q.copy(body);
        this.shoulder.set(side * 0.12 * f.build, 0.64, 0).multiplyScalar(f.scale).applyQuaternion(facing).add(this.v.set(f.x, -bob * f.scale, f.z));
        // Out to the side (about the body's front axis), then a little forward.
        facing.multiply(QZ.setFromAxisAngle(Z, side * raise)).multiply(QX.setFromAxisAngle(X, -0.25 * Math.min(1, raise / 2)));
        this.m.compose(this.shoulder, this.q, this.s.setScalar(f.scale));
        this.arms.setMatrixAt(i * 2 + (side === 1 ? 1 : 0), this.m);
      }
    });
    this.bodies.instanceMatrix.needsUpdate = true;
    this.arms.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
    this.bodies.dispose();
    this.arms.dispose();
  }
}
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const QX = new THREE.Quaternion();
const QZ = new THREE.Quaternion();

/**
 * Paper lanterns hung in rows over and behind the stage, glowing orange (HDR, so they bloom), swaying a little: the
 * club's light.
 */
const LANTERN_VERT = /* glsl */ `
varying vec3 vNormalL, vNormalV, vViewV;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 mv = viewMatrix * m * vec4(position, 1.0);
  vNormalL = normal;
  vNormalV = normalize(mat3(viewMatrix) * mat3(m) * normal);
  vViewV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;
const LANTERN_FRAG = /* glsl */ `
varying vec3 vNormalL, vNormalV, vViewV;
uniform vec3 uHot, uDeep;
uniform float uAmount;
void main() {
  vec3 n = normalize(vNormalL);
  float facing = abs(dot(normalize(vNormalV), normalize(vViewV)));
  // Hot through the middle of the paper, deep red at the edges; the ribs and the caps dark.
  vec3 col = mix(uDeep, uHot, pow(facing, 1.5));
  float rib = 0.72 + 0.28 * smoothstep(0.0, 0.6, abs(cos(atan(n.x, n.z) * 6.0)));
  float cap = smoothstep(0.82, 0.9, abs(n.y));
  col *= rib * (1.0 - 0.92 * cap);
  gl_FragColor = vec4(col * uAmount, 1.0);
}
`;

type Hung = { x: number; y: number; z: number; size: number; phase: number };

export class Lanterns {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.SphereGeometry(1, 16, 12);
  private readonly hung: Hung[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(lowPower: boolean) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: LANTERN_VERT,
      fragmentShader: LANTERN_FRAG,
      uniforms: { uHot: { value: hdr('#ff9838', 1.9) }, uDeep: { value: hdr('#c42a12', 0.75) }, uAmount: { value: 0 } },
    });
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // Strings across the room: [z, height, half width, count, sag].
    const strings: [number, number, number, number, number][] = lowPower
      ? [[-4.4, 1.3, 4, 12, 0.06], [-2.4, 1.5, 3, 9, 0.1]]
      : [
          [-4.9, 1.2, 4.6, 19, 0.06], [-4.4, 1.38, 4.2, 16, 0.08], [-4.2, 1.9, 4.0, 16, 0.14], [-3.3, 1.65, 3.4, 13, 0.12],
          [-2.4, 1.5, 2.9, 11, 0.1], [-1.2, 1.6, 2.4, 8, 0.1], [0.2, 1.8, 2.0, 6, 0.08],
        ];
    for (const [z, y, w, n, sag] of strings) {
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n;
        const x = -w + 2 * w * u + (rand() - 0.5) * 0.1;
        this.hung.push({ x, y: y - sag * Math.sin(Math.PI * u), z: z + (rand() - 0.5) * 0.15, size: 0.05 + rand() * 0.03, phase: rand() * 6 });
      }
    }
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, this.hung.length);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
  }

  update(time: number, amount: number) {
    this.material.uniforms.uAmount.value = amount;
    this.hung.forEach((h, i) => {
      const swing = 0.05 * Math.sin(time * 0.9 + h.phase);
      this.q.setFromEuler(this.e.set(0.04 * Math.sin(time * 0.7 + h.phase * 1.3), h.phase, swing));
      this.s.set(h.size, h.size * 1.18, h.size);
      this.m.compose(this.v.set(h.x + swing * 0.05, h.y, h.z), this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

export class Stage {
  readonly group = new THREE.Group();
  /** 0 = gone, 1 = up. */
  amount = 0;
  /** Seconds into the walkout track's groove (negative before the drop): the crowd bounces to it. */
  beat = -1;
  private readonly crowd: Crowd;
  private readonly lanterns: Lanterns;
  private readonly backglow: THREE.ShaderMaterial;
  /**
   * The spotlights (key in front, rim behind, per fighter): always in the scene, at zero when the stage is down, since
   * adding or removing a light recompiles every lit material (a long hitch). None in low power: a phone shouldn't pay
   * for dark lights through the fight, and it gets a milder dim instead (the director).
   */
  readonly lights = new THREE.Group();
  readonly spots: THREE.SpotLight[] = [];
  readonly rims: THREE.SpotLight[] = [];
  private readonly beams: { mesh: THREE.Mesh; material: THREE.ShaderMaterial; sweep: number }[] = [];
  private readonly lamps: THREE.Mesh[] = [];
  private readonly lampMaterial: THREE.ShaderMaterial;
  private readonly hazes: { mesh: THREE.Mesh; material: THREE.ShaderMaterial }[] = [];
  private readonly dome: THREE.Mesh;
  private readonly domeMaterial: THREE.ShaderMaterial;
  private readonly motes: THREE.Points;
  private readonly moteMaterial: THREE.PointsMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private time = 0;
  private readonly keyPower = 9;
  private readonly rimPower = 5.5;

  constructor(lowPower: boolean) {
    this.group.visible = false;
    this.domeMaterial = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: { uTime: { value: 0 }, uAmount: { value: 0 } },
      side: THREE.BackSide,
    });
    // Close around the stage: everything past it (the sky, the hills) goes to black.
    const domeGeometry = new THREE.SphereGeometry(9, 48, 24);
    this.geometries.push(domeGeometry);
    this.dome = new THREE.Mesh(domeGeometry, this.domeMaterial);
    this.group.add(this.dome);

    const beamGeometry = new THREE.CylinderGeometry(0.0, 1, 1, 32, 1, true).translate(0, -0.5, 0);
    this.geometries.push(beamGeometry);
    const beam = (color: THREE.ColorRepresentation, intensity: number, sweep: number) => {
      const material = new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms: { uColor: { value: hdr(color, intensity) }, uAmount: { value: 0 }, uTime: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(beamGeometry, material);
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.beams.push({ mesh, material, sweep });
      return mesh;
    };
    const lampGeometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(lampGeometry);
    this.lampMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: GLOW_SPRITE_FRAG,
      uniforms: { uColor: { value: hdr('#fff0d8', 5) }, uAmount: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < 2; i++) {
      if (!lowPower) {
        const key = new THREE.SpotLight('#ffe2bc', 0, 7, 0.3, 0.6, 1.1);
        this.lights.add(key, key.target);
        this.spots.push(key);
        const rim = new THREE.SpotLight(i === 0 ? '#ff6ab4' : '#6ab8ff', 0, 5, 0.45, 0.5, 1.2);
        this.lights.add(rim, rim.target);
        this.rims.push(rim);
      }
      beam('#ffe9c8', 0.22, 0);
      const lamp = new THREE.Mesh(lampGeometry, this.lampMaterial);
      lamp.scale.setScalar(0.35);
      lamp.renderOrder = 4;
      this.group.add(lamp);
      this.lamps.push(lamp);
    }
    // Background beams sweeping slowly through the dark.
    if (!lowPower) {
      beam('#ffb066', 0.12, 1).position.set(-1.6, 3.4, -3.2);
      beam('#ff7a3a', 0.12, -1).position.set(1.7, 3.4, -3.4);
      beam('#5ee8ff', 0.06, 0.6).position.set(0.1, 3.6, -4.2);
    }
    // A little haze low over the floor, behind the fighters.
    const hazeGeometry = new THREE.PlaneGeometry(1, 1);
    this.geometries.push(hazeGeometry);
    const hazeAt: [number, number, number, number, number][] = lowPower
      ? [[0, 0.3, -1.0, 4, 1.2]]
      : [[0, 0.3, -1.0, 4.5, 1.3], [0.2, 0.55, -2.2, 6, 2], [-0.3, 0.9, -3.6, 9, 2.6]];
    hazeAt.forEach(([x, y, z, w, h], i) => {
      const material = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: HAZE_FRAG,
        uniforms: { uTime: { value: 0 }, uAmount: { value: 0 }, uSeed: { value: i * 3.1 }, uColor: { value: new THREE.Color('#70462f') } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(hazeGeometry, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(w, h, 1);
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.hazes.push({ mesh, material });
    });
    // Dust motes hanging in the light.
    const n = lowPower ? 120 : 400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos.set([(Math.random() - 0.5) * 2.4, Math.random() * 1.6, (Math.random() - 0.6) * 1.8], i * 3);
    const moteGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometries.push(moteGeometry);
    this.moteMaterial = new THREE.PointsMaterial({ color: '#ffe8c8', size: 0.006, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.motes = new THREE.Points(moteGeometry, this.moteMaterial);
    this.group.add(this.motes);
    this.crowd = new Crowd(lowPower);
    this.lanterns = new Lanterns(lowPower);
    this.group.add(this.crowd.group, this.lanterns.mesh);
    this.backglow = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: BACKGLOW_FRAG,
      uniforms: { uTime: { value: 0 }, uAmount: { value: 0 }, uColor: { value: hdr('#ff7a2e', 0.55) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(hazeGeometry, this.backglow);
    glow.position.set(0, 1.4, -5.6);
    glow.scale.set(16, 4.4, 1);
    glow.renderOrder = 1;
    this.group.add(glow);
  }

  /** Aim fighter `i`'s key and rim lights, beam and lamp at `at` (their feet). */
  aim(i: number, at: THREE.Vector3) {
    const side = i === 0 ? -1 : 1; // the fighter's outside
    const lamp = this.lamps[i].position.set(at.x + side * 0.4, 1.75, at.z + 1.15);
    const key = this.spots[i];
    if (key) {
      key.position.copy(lamp);
      key.target.position.set(at.x, 0.5, at.z);
    }
    const rim = this.rims[i];
    if (rim) {
      rim.position.set(at.x - side * 0.5, 1.4, at.z - 1.3);
      rim.target.position.set(at.x, 0.55, at.z);
    }
    const beam = this.beams[i].mesh;
    beam.position.copy(lamp);
    const dir = new THREE.Vector3(at.x, 0.2, at.z).sub(lamp);
    const len = dir.length() + 0.3;
    beam.scale.set(Math.tan(0.22) * len, len, Math.tan(0.22) * len);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
  }

  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    const k = this.amount;
    this.group.visible = k > 0.001;
    for (const s of this.spots) s.intensity = this.keyPower * k;
    for (const r of this.rims) r.intensity = this.rimPower * k;
    if (!this.group.visible) return;
    this.dome.position.copy(camera.position).setY(0);
    this.domeMaterial.uniforms.uTime.value = this.time;
    this.domeMaterial.uniforms.uAmount.value = k;
    this.lampMaterial.uniforms.uAmount.value = k;
    for (const l of this.lamps) l.quaternion.copy(camera.quaternion);
    for (const b of this.beams) {
      b.material.uniforms.uAmount.value = k;
      b.material.uniforms.uTime.value = this.time;
      if (b.sweep) {
        const a = Math.sin(this.time * 0.35 * Math.abs(b.sweep) + b.sweep) * 0.5;
        b.mesh.rotation.set(0.25 + 0.1 * Math.sin(this.time * 0.5), 0, a);
        b.mesh.scale.set(0.8, 5, 0.8);
      }
    }
    for (const h of this.hazes) {
      h.material.uniforms.uTime.value = this.time;
      h.material.uniforms.uAmount.value = k;
      h.mesh.quaternion.copy(camera.quaternion);
    }
    this.moteMaterial.opacity = 0.7 * k;
    this.motes.rotation.y = this.time * 0.02;
    this.motes.position.y = Math.sin(this.time * 0.3) * 0.02;
    this.crowd.update(this.beat, this.time, k);
    this.lanterns.update(this.time, k);
    this.backglow.uniforms.uTime.value = this.time;
    this.backglow.uniforms.uAmount.value = k;
  }

  dispose() {
    this.group.removeFromParent();
    this.lights.removeFromParent();
    for (const g of this.geometries) g.dispose();
    this.domeMaterial.dispose();
    this.lampMaterial.dispose();
    this.moteMaterial.dispose();
    for (const b of this.beams) b.material.dispose();
    for (const h of this.hazes) h.material.dispose();
    for (const s of [...this.spots, ...this.rims]) s.dispose();
    this.crowd.dispose();
    this.lanterns.dispose();
    this.backglow.dispose();
  }
}

/**
 * Soft fire for the VS wall: a smooth hot-to-cool gradient (no bands), licking tongues from fbm turbulence, additive and
 * HDR so it glows through the bloom.
 */
const SOFT_FIRE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime, uAmount, uSeed;
uniform vec3 uHot, uMid, uCool;
${NOISE}
void main() {
  vec2 uv = vUv;
  vec2 q = vec2(uv.x * 3.0 + uSeed, uv.y * 2.0 - uTime * 1.6);
  float n = fbm(q + vec2(fbm(q * 1.7 + vec2(uSeed, -uTime * 2.3)) * 1.2, 0.0));
  float width = smoothstep(0.0, 0.35, uv.x) * smoothstep(1.0, 0.65, uv.x);
  float body = width * (1.3 - uv.y * 1.5);
  float f = clamp((body + (n - 0.5) * 1.1) * uAmount, 0.0, 1.6);
  float a = smoothstep(0.08, 0.6, f) * smoothstep(0.0, 0.08, uv.y);
  vec3 col = mix(uCool, uMid, smoothstep(0.1, 0.6, f));
  col = mix(col, uHot, smoothstep(0.55, 1.2, f));
  gl_FragColor = vec4(col * a, a);
}
`;

/** The wall of fire that fills the stage behind the fighters for the VS: overlapping soft sheets in three depths. */
export class FireWall {
  readonly group = new THREE.Group();
  amount = 0;
  target = 0;
  private readonly sheets: { mesh: THREE.Mesh; material: THREE.ShaderMaterial; h: number }[] = [];
  private readonly geometry = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  private time = 0;

  constructor(lowPower: boolean) {
    this.group.visible = false;
    // [x, z, width, height, layer]: a tall dark-red back row, an orange middle row, bright low tongues in front.
    const layers: [number, number, number, number, number][] = [];
    const across = lowPower ? 4 : 7;
    for (let i = 0; i < across; i++) {
      const x = -2.4 + (4.8 * (i + 0.5)) / across;
      layers.push([x, -0.6, 4.8 / across + 0.7, 2.0 + 0.4 * Math.sin(i * 2.3), 0]);
      if (!lowPower || i % 2 === 0) layers.push([x + 0.25, -0.25, 4.8 / across + 0.5, 1.35 + 0.3 * Math.cos(i * 1.7), 1]);
      if (!lowPower) layers.push([x - 0.2, 0.05, 4.8 / across + 0.3, 0.7 + 0.2 * Math.sin(i * 3.1), 2]);
    }
    const palette = [
      { hot: '#ff9a3c', mid: '#d4341a', cool: '#4a0710', glow: 1.0 },
      { hot: '#ffc35a', mid: '#ff5a1a', cool: '#7a1010', glow: 1.4 },
      { hot: '#ffe08a', mid: '#ff8a1a', cool: '#a3200f', glow: 1.3 },
    ];
    layers.forEach(([x, z, w, h, layer], i) => {
      const p = palette[layer];
      const material = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: SOFT_FIRE_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uAmount: { value: 0 },
          uSeed: { value: i * 1.37 },
          uHot: { value: hdr(p.hot, 0.32 * p.glow) },
          uMid: { value: hdr(p.mid, 0.22 * p.glow) },
          uCool: { value: hdr(p.cool, 0.16) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.position.set(x, 0, z);
      mesh.scale.set(w, h, 1);
      mesh.renderOrder = 5 + layer;
      this.group.add(mesh);
      this.sheets.push({ mesh, material, h });
    });
  }

  update(dt: number) {
    this.time += dt;
    const rate = this.target > this.amount ? 14 : 3;
    this.amount += (this.target - this.amount) * (1 - Math.exp(-rate * dt));
    this.group.visible = this.amount > 0.01;
    if (!this.group.visible) return;
    for (const s of this.sheets) {
      s.material.uniforms.uTime.value = this.time;
      s.material.uniforms.uAmount.value = Math.min(1.5, this.amount);
      s.mesh.scale.y = s.h * (0.4 + 0.6 * Math.min(1.3, this.amount));
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.geometry.dispose();
    for (const s of this.sheets) s.material.dispose();
  }
}

/** The fire VS: big burning letters standing in the stage behind the fighters, slammed in at the end of the walkout. */
export class VsSign {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly texture: THREE.CanvasTexture;
  private drawn = false;

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // HDR tint: the letters bloom like they're burning.
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, color: new THREE.Color(1.35, 1.05, 0.8), toneMapped: true });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), this.material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 10; // after the fire behind it
  }

  /** Paint the letters (once the graffiti font is ready: call again later and it repaints). */
  draw() {
    if (this.drawn) return;
    const canvas = this.texture.image as HTMLCanvasElement;
    const g = canvas.getContext('2d');
    if (!g) return;
    const font = '400 380px "Rubik Wet Paint", "Archivo Black", sans-serif';
    const ready = typeof document !== 'undefined' && document.fonts?.check?.(font);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // A soft orange glow behind the letters, then a dark keyline, then the hot fill.
    g.save();
    g.shadowColor = 'rgba(255, 120, 30, 0.95)';
    g.shadowBlur = 60;
    g.fillStyle = '#ff7a1a';
    g.fillText('VS', 512, 270);
    g.restore();
    const fill = g.createLinearGradient(0, 100, 0, 430);
    fill.addColorStop(0, '#fff8d8');
    fill.addColorStop(0.45, '#ffc21a');
    fill.addColorStop(1, '#ff4a1a');
    g.lineJoin = 'round';
    g.lineWidth = 22;
    g.strokeStyle = '#2a0805';
    g.strokeText('VS', 512, 270);
    g.fillStyle = fill;
    g.fillText('VS', 512, 270);
    this.texture.needsUpdate = true;
    this.drawn = !!ready;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
