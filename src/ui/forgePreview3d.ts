import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadModel } from '../forge/models';

/**
 * The forging card's live 3D preview: TRELLIS's sparse voxels as a hologram building up, then the gray clay shape
 * sculpted in over them, then the finished fighter painted in over the clay with its rig flashing.
 *
 * Light on weak laptops: every forging card shares one small WebGL renderer (created while any card shows a preview,
 * freed after), each frame is copied onto the card's own 2D canvas, and it runs at 12 fps, which is also the stepped,
 * arcade-y turntable look. `lowPower` gets PreviewCanvas2D: the same stages drawn as points with Canvas 2D.
 */

/** Internal render size (3:4); cards scale it with CSS. */
export const PREVIEW_W = 384;
export const PREVIEW_H = 512;
const FPS = 12;
/** Seconds for one stage to sweep in over the last (bottom to top); the paint goes faster, it's the finale. */
const SWEEP = 1.2;
const PAINT_SWEEP = 0.7;
/** The rig flashes right after the paint is on, for this long (s). */
const RIG_FLASH = 0.8;
/** Turntable speed, rad/s (stepped by the frame rate). */
const SPIN = 0.9;
/**
 * TRELLIS's voxels and shape, turned y up, face +z: toward the camera, like the finished fighter (faces +x, turned -90°).
 * Measured on real shapes (the feet stick out toward +z).
 */
const TRELLIS_YAW = 0;

export interface ForgePreviewView {
  showVoxels(url: string): Promise<void>;
  showClay(url: string): Promise<void>;
  showFinal(url: string): Promise<void>;
  dispose(): void;
}

// --- the shared renderer ----------------------------------------------------------------------------------------

let renderer: THREE.WebGLRenderer | null = null;
/** Image-based light like the arena's: TRELLIS's PBR textures have metallic patches, black without an environment. */
let environment: THREE.Texture | null = null;
let timer = 0;
const views = new Set<PreviewScene>();

function frame() {
  if (!renderer) return;
  const t = performance.now() / 1000;
  for (const view of views) {
    view.tick(t);
    renderer.render(view.scene, view.camera);
    // Copied right after rendering, while the frame is still in the drawing buffer.
    view.ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
    view.ctx.drawImage(renderer.domElement, 0, 0);
  }
}

function attach(view: PreviewScene) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(1);
    renderer.setSize(PREVIEW_W, PREVIEW_H, false);
    renderer.setClearColor(0x000000, 0);
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    timer = window.setInterval(frame, 1000 / FPS);
  }
  view.scene.environment = environment;
  views.add(view);
}

function detach(view: PreviewScene) {
  views.delete(view);
  if (views.size === 0 && renderer) {
    window.clearInterval(timer);
    environment?.dispose();
    environment = null;
    renderer.dispose();
    renderer.forceContextLoss();
    renderer = null;
  }
}

// --- materials --------------------------------------------------------------------------------------------------

/** Voxel hologram: additive, edges glow, colored bottom to top from the second color to the player's, scanlines. */
function hologram(color: THREE.Color, other: THREE.Color, half: number, clip: THREE.Plane[]) {
  return new THREE.ShaderMaterial({
    uniforms: { uA: { value: color }, uB: { value: other }, uTime: { value: 0 }, uAlpha: { value: 1 }, uHalf: { value: half } },
    vertexShader: /* glsl */ `
      #include <clipping_planes_pars_vertex>
      varying vec3 vWorld;
      varying vec3 vLocal;
      void main() {
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vLocal = position;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <clipping_planes_pars_fragment>
      uniform vec3 uA;
      uniform vec3 uB;
      uniform float uTime;
      uniform float uAlpha;
      uniform float uHalf;
      varying vec3 vWorld;
      varying vec3 vLocal;
      void main() {
        #include <clipping_planes_fragment>
        vec3 e = abs(vLocal) / uHalf;
        float edge = smoothstep(0.7, 1.0, max(max(min(e.x, e.y), min(e.y, e.z)), min(e.x, e.z)));
        float scan = 0.6 + 0.4 * step(0.5, fract(vWorld.y * 70.0 - uTime * 3.0));
        vec3 c = mix(uB, uA, clamp(vWorld.y + 0.5, 0.0, 1.0));
        gl_FragColor = vec4(c * (0.3 + 1.6 * edge) * scan, uAlpha * (0.25 + 0.75 * edge));
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    clipping: true,
    clippingPlanes: clip,
  });
}

/** A Fresnel rim in the player's color plus a scan band that runs up the body, on any lit material. */
function addRim(material: THREE.Material, color: THREE.Color, time: { value: number }, strength: number) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = { value: color };
    shader.uniforms.uTime = time;
    shader.uniforms.uRimStrength = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vY;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim;\nuniform float uTime;\nuniform float uRimStrength;\nvarying float vY;')
      .replace(
        '#include <dithering_fragment>',
        `float rim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.5);
         float band = smoothstep(0.06, 0.0, abs(fract(vY * 0.6 - uTime * 0.35) - 0.5));
         gl_FragColor.rgb += uRim * (rim * uRimStrength + band * 0.25);
         #include <dithering_fragment>`,
      );
  };
  material.needsUpdate = true;
}

// --- one card's scene -------------------------------------------------------------------------------------------

class PreviewScene implements ForgePreviewView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, PREVIEW_W / PREVIEW_H, 0.05, 20);
  readonly ctx: CanvasRenderingContext2D;
  private readonly turntable = new THREE.Group();
  /** TRELLIS's [-0.5, 0.5] cube, scaled and centered (from the voxels) so the figure stands 1 unit tall at 0. */
  private readonly cube = new THREE.Group();
  private readonly color: THREE.Color;
  private readonly other: THREE.Color;
  private readonly time = { value: 0 };
  /** The last stage, clipped away above the sweep while the next one is sculpted in below it. */
  private readonly keepAbove = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.6);
  private readonly keepBelow = new THREE.Plane(new THREE.Vector3(0, -1, 0), -0.6);
  private sweepFrom = -1;
  private voxels: THREE.InstancedMesh | null = null;
  private voxelOrder: number[] = [];
  private voxelsAt = -1;
  private clay: THREE.Object3D | null = null;
  private final: THREE.Object3D | null = null;
  private bones: THREE.SkeletonHelper | null = null;
  private finalAt = -1;
  private disposed = false;
  private start = performance.now() / 1000;

  constructor(canvas: HTMLCanvasElement, color: string, other: string) {
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    this.ctx = canvas.getContext('2d')!;
    this.color = new THREE.Color(color);
    this.other = new THREE.Color(other);
    this.camera.position.set(0, 0.08, 2.4);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new THREE.HemisphereLight('#dfe8f5', '#202028', 1.7));
    const key = new THREE.DirectionalLight('#ffffff', 2.2);
    key.position.set(1.2, 2, 2.5);
    this.scene.add(key, this.turntable);
    this.cube.rotation.y = TRELLIS_YAW;
    this.turntable.add(this.cube);
    attach(this);
  }

  async showVoxels(url: string) {
    const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
    if (this.disposed || this.voxels || data.length < 5) return;
    const res = data[0] | (data[1] << 8);
    const n = Math.floor((data.length - 2) / 3);
    const size = 1 / res;
    // TRELLIS is z up: voxel (x, y, z) sits at (x, z, -y) here.
    const at = (i: number) => new THREE.Vector3((data[2 + i * 3] + 0.5) * size - 0.5, (data[4 + i * 3] + 0.5) * size - 0.5, -((data[3 + i * 3] + 0.5) * size - 0.5));
    const box = new THREE.Box3();
    for (let i = 0; i < n; i++) box.expandByPoint(at(i));
    const height = box.max.y - box.min.y + size;
    this.cube.scale.setScalar(1 / height);
    this.cube.position.set(0, -((box.min.y + box.max.y) / 2) / height, 0);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(size * 0.92, size * 0.92, size * 0.92), hologram(this.color, this.other, size * 0.46, [this.keepAbove]), n);
    // Built up bottom to top.
    this.voxelOrder = [...Array(n).keys()].sort((a, b) => data[4 + a * 3] - data[4 + b * 3]);
    const m = new THREE.Matrix4();
    this.voxelOrder.forEach((v, i) => mesh.setMatrixAt(i, m.makeTranslation(at(v))));
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.voxels = mesh;
    this.voxelsAt = performance.now() / 1000;
    this.cube.add(mesh);
  }

  async showClay(url: string) {
    const gltf = await loadModel(url);
    if (this.disposed || this.clay) return;
    const material = new THREE.MeshStandardMaterial({ color: '#8e8e98', roughness: 0.75, metalness: 0, clippingPlanes: [this.keepBelow] });
    addRim(material, this.color, this.time, 1.3);
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        o.material = material;
      }
    });
    this.clay = gltf.scene;
    this.cube.add(gltf.scene);
    this.sweep();
  }

  async showFinal(url: string) {
    const gltf = await loadModel(url);
    if (this.disposed || this.final) return;
    const model = gltf.scene;
    // Forged fighters face +x, 1 m tall from the floor; fit it to the clay's place.
    model.rotation.y = -Math.PI / 2;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const s = 1 / (box.max.y - box.min.y);
    model.scale.setScalar(s);
    model.position.set(-((box.min.x + box.max.x) / 2) * s, -((box.min.y + box.max.y) / 2) * s, -((box.min.z + box.max.z) / 2) * s);
    model.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          m.clippingPlanes = [this.keepBelow];
          addRim(m, this.color, this.time, 0.7);
        }
      }
    });
    this.bones = new THREE.SkeletonHelper(model);
    const lines = this.bones.material as THREE.LineBasicMaterial;
    lines.depthTest = false;
    lines.transparent = true;
    lines.blending = THREE.AdditiveBlending;
    lines.vertexColors = false;
    lines.color = this.color.clone().lerp(new THREE.Color('#ffffff'), 0.6);
    lines.needsUpdate = true;
    this.bones.visible = false;
    this.final = model;
    this.finalAt = performance.now() / 1000;
    this.turntable.add(model);
    this.scene.add(this.bones); // it draws in the model's world space itself
    // Whatever was there before (clay, or only voxels) gives way above the sweep.
    for (const o of [this.clay]) {
      o?.traverse((m) => m instanceof THREE.Mesh && ((m.material as THREE.Material).clippingPlanes = [this.keepAbove]));
    }
    this.sweep();
  }

  /** Starts a sweep: the newest stage grows up from the floor, the one before it stays above the line. */
  private sweep() {
    this.sweepFrom = performance.now() / 1000;
    if (!this.voxels) return;
    if (this.clay && this.final) this.voxels.visible = false; // long gone under the clay
    else (this.voxels.material as THREE.ShaderMaterial).clippingPlanes = [this.keepAbove];
  }

  tick(t: number) {
    this.time.value = t;
    this.turntable.rotation.y = (t - this.start) * SPIN;
    if (this.voxels) {
      const shader = this.voxels.material as THREE.ShaderMaterial;
      shader.uniforms.uTime.value = t;
      // The hologram builds up over 1.4 s, then flickers a little.
      const k = Math.min(1, (t - this.voxelsAt) / 1.4);
      this.voxels.count = Math.floor(this.voxelOrder.length * k);
      shader.uniforms.uAlpha.value = this.clay || this.final ? 0.45 : 0.85 + 0.15 * Math.sin(t * 9);
    }
    // h: the sweep line. Before any sweep the hologram shows whole (everything is above -0.6).
    const k = this.sweepFrom < 0 ? 1 : Math.min(1, (t - this.sweepFrom) / (this.final ? PAINT_SWEEP : SWEEP));
    const h = this.sweepFrom < 0 ? -0.6 : -0.6 + k * 1.25;
    if (k >= 1 && this.voxels && this.clay) this.voxels.visible = false; // the clay is all in
    this.keepBelow.constant = h; // the new stage: y <= h
    this.keepAbove.constant = -h; // the old one: y >= h
    if (this.bones) {
      // The rig flashes once the paint is on: bones blinking over the body (on two frames, off one).
      const since = t - this.finalAt - PAINT_SWEEP;
      this.bones.visible = since > 0 && since < RIG_FLASH && Math.floor(since * FPS) % 3 !== 2;
    }
  }

  dispose() {
    this.disposed = true;
    detach(this);
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
  }
}

// --- lowPower: the same stages as Canvas 2D points --------------------------------------------------------------

class PreviewCanvas2D implements ForgePreviewView {
  private readonly ctx: CanvasRenderingContext2D;
  private points: { x: number; y: number; z: number }[] = [];
  private kind: 'voxels' | 'clay' | null = null;
  private timer: number;
  private shownAt = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, private readonly color: string, private readonly other: string) {
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    this.ctx = canvas.getContext('2d')!;
    this.timer = window.setInterval(() => this.draw(performance.now() / 1000), 1000 / 8);
  }

  async showVoxels(url: string) {
    const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
    if (this.disposed || this.kind || data.length < 5) return;
    const res = data[0] | (data[1] << 8);
    const pts = [];
    for (let i = 2; i + 2 < data.length; i += 3) pts.push({ x: data[i] / res - 0.5, y: data[i + 2] / res - 0.5, z: -(data[i + 1] / res - 0.5) });
    this.set(pts, 'voxels');
  }

  async showClay(url: string) {
    const gltf = await loadModel(url);
    if (this.disposed) return;
    const pts: { x: number; y: number; z: number }[] = [];
    gltf.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const p = o.geometry.attributes.position;
      const step = Math.max(1, Math.floor(p.count / 2500));
      for (let i = 0; i < p.count; i += step) pts.push({ x: p.getX(i), y: p.getY(i), z: p.getZ(i) });
    });
    this.set(pts, 'clay');
  }

  async showFinal() {
    // The card shows the finished fighter's art; the 2D preview just holds the clay.
  }

  private set(pts: { x: number; y: number; z: number }[], kind: 'voxels' | 'clay') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) (lo = Math.min(lo, p.y)), (hi = Math.max(hi, p.y));
    const s = 1 / Math.max(hi - lo, 1e-3);
    const mid = (lo + hi) / 2;
    this.points = pts.map((p) => ({ x: p.x * s, y: (p.y - mid) * s, z: p.z * s })); // TRELLIS faces +z: toward us
    this.kind = kind;
    this.shownAt = performance.now() / 1000;
  }

  private draw(t: number) {
    const { ctx } = this;
    ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
    if (!this.kind) return;
    const a = (t - this.shownAt) * SPIN;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const scale = PREVIEW_H * 0.82;
    const shown = Math.floor(this.points.length * Math.min(1, (t - this.shownAt) / 1.4));
    const size = this.kind === 'voxels' ? 4 : 2;
    for (let i = 0; i < shown; i++) {
      const p = this.points[i];
      const x = p.x * cos + p.z * sin;
      const z = -p.x * sin + p.z * cos;
      ctx.fillStyle = z > 0 ? this.color : this.other;
      ctx.globalAlpha = 0.35 + 0.5 * Math.max(0, z + 0.5);
      ctx.fillRect(PREVIEW_W / 2 + x * scale - size / 2, PREVIEW_H / 2 - p.y * scale - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  dispose() {
    this.disposed = true;
    window.clearInterval(this.timer);
  }
}

/** The live preview on one card's canvas (WebGL, or Canvas 2D points when `lowPower`). */
export function createForgePreview(canvas: HTMLCanvasElement, color: string, other: string, lowPower: boolean): ForgePreviewView {
  return lowPower ? new PreviewCanvas2D(canvas, color, other) : new PreviewScene(canvas, color, other);
}
