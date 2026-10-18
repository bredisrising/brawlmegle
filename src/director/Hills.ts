import * as THREE from 'three';
import { loadModel } from '../forge/models';
import hillsUrl from '../../models/forested_hills.glb?url';
import type { HillsLodReply, HillsLodRequest } from './hillsLod.worker';

export interface HillOptions {
  /** Hills per screen width on line `layer` (0 = nearest). */
  density: (layer: number) => number;
  /** How many screen widths each line stretches across (centered on x = 0), so camera pans don't run off the end. */
  span: number;
  /** Random shift from each evenly spaced slot, as a fraction of the spacing (0 = a perfect row). */
  jitter: number;
  /** How far back the nearest line sits behind the fight line (z = 0), world units. */
  distance: number;
  /** Number of lines, nearest first. */
  layers: number;
  /** Extra distance back from one line to the next. */
  layerGap: number;
  /** Height (y of the hill's base) of line `layer` (0 = nearest). */
  height: (layer: number) => number;
  /** Hill size on line `layer` (1 = as modelled, ~16 units across). Each hill also varies by ±scaleJitter of it. */
  scale: (layer: number) => number;
  scaleJitter: number;
  /**
   * Atmospheric perspective: no haze closer than hazeStart (distance from the camera), then hazeColor mixed in by
   * 1 - exp(-hazeStrength(layer) * (distance - hazeStart)), so hazeStrength is how fast it fades past the start.
   */
  hazeStart: number;
  hazeStrength: (layer: number) => number;
  hazeColor: THREE.ColorRepresentation;
  /** Screen proportions that "a screen width" is measured with. */
  aspect: number;
  seed: number;
}

export const DEFAULT_HILLS: HillOptions = {
  density: (layer) => 8 + 4 * layer,
  span: 1.5,
  jitter: 0.35,
  distance: 6,
  layers: 3,
  layerGap: 20,
  height: (layer) => -1.3 - layer * 0.0,
  scale: () => 0.3,
  scaleJitter: 0.2,
  hazeStart: 3,
  hazeStrength: () => 0.03,
  hazeColor: '#6baaf2',
  aspect: 16 / 9,
  seed: 1,
};

export interface Hills {
  readonly object: THREE.Group;
  readonly options: HillOptions;
  /** Re-scatter with some options changed (the rest are kept). */
  update(options: Partial<HillOptions>): void;
  /** Per frame, before drawing: only the hills in view get drawn. */
  cull(camera: THREE.Camera): void;
  dispose(): void;
}

/**
 * Detail budget for the far rows: a simplified hill may stray this many pixels from the full one, on a screen this
 * tall. Under a pixel nobody sees it; the farthest row drops ~2/3 of its triangles at this budget.
 */
const LOD_PIXELS = 0.5;
const LOD_SCREEN_HEIGHT = 1440;

type Row = { mesh: THREE.InstancedMesh; matrices: THREE.Matrix4[]; spheres: THREE.Sphere[]; shown: Int32Array; haze: number };

/** Background scenery: rows of the forested hill, spread across the screen at each depth and hazed with distance. */
export async function loadHills(camera: THREE.PerspectiveCamera, options: Partial<HillOptions> = {}): Promise<Hills> {
  const gltf = await loadModel(hillsUrl);
  // Just the mesh, without the scene placement it was exported with.
  let source: THREE.Mesh | undefined;
  gltf.scene.traverse((object) => {
    if (!source && object instanceof THREE.Mesh) source = object;
  });
  if (!source) throw new Error('forested_hills.glb has no mesh');
  const geometry = source.geometry;
  geometry.computeBoundingSphere();
  const material = (source.material as THREE.MeshStandardMaterial).clone();
  (source.material as THREE.Material).dispose();
  // Every face points out (checked: winding agrees with the normals everywhere) and the camera only ever sees the
  // hills from the front, so back faces are never visible: culling them halves the triangles rasterized.
  material.side = THREE.FrontSide;

  // Haze strength depends on the hill's line, so it rides along as a per-instance attribute.
  const haze = { hazeColor: { value: new THREE.Color() }, hazeStart: { value: 0 } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, haze);
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'attribute float instanceHaze;\nvarying float vHaze;\nvoid main() {\nvHaze = instanceHaze;',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 hazeColor;\nuniform float hazeStart;\nvarying float vHaze;\nvoid main() {')
      .replace(
        '#include <fog_fragment>',
        '#include <fog_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor, 1.0 - exp(-vHaze * max(length(vViewPosition) - hazeStart, 0.0)));',
      );
  };
  material.customProgramCacheKey = () => 'hills-haze';

  const group = new THREE.Group();
  group.name = 'Background hills';
  let rows: Row[] = [];
  let current: HillOptions = { ...DEFAULT_HILLS, ...options };
  /** Simplified index buffers by allowed error (model units), as they come back from the worker. */
  const lods = new Map<number, THREE.BufferAttribute | null>();
  let lodWorker: Worker | null = null;
  let disposed = false;

  /** How far a row's hills may stray from the full mesh (model units) for LOD_PIXELS on screen. */
  const rowError = (o: HillOptions, layer: number) => {
    // Nearest a hill of this row gets to the camera (the camera only moves toward the fighters, away from the hills).
    const distance = o.distance + layer * o.layerGap + camera.position.z * 0.8;
    const pixelsPerRadian = LOD_SCREEN_HEIGHT / THREE.MathUtils.degToRad(camera.fov);
    const world = (LOD_PIXELS * distance) / pixelsPerRadian;
    // Rounded down to a few steps, so small option tweaks reuse the same simplified meshes.
    const model = world / (o.scale(layer) * (1 + o.scaleJitter));
    return 2 ** (Math.floor(Math.log2(model) * 2) / 2);
  };

  /** A row's geometry: the shared vertex buffers, the row's index (full or simplified) and its own haze values. */
  const rowGeometry = (index: THREE.BufferAttribute | null, count: number, strength: number) => {
    const g = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) g.setAttribute(name, attribute);
    g.setIndex(index ?? geometry.index);
    g.boundingSphere = geometry.boundingSphere;
    g.setAttribute('instanceHaze', new THREE.InstancedBufferAttribute(new Float32Array(count).fill(strength), 1));
    return g;
  };

  const scatter = () => {
    const o = current;
    haze.hazeColor.value.set(o.hazeColor);
    haze.hazeStart.value = o.hazeStart;

    for (const row of rows) {
      row.mesh.removeFromParent();
      row.mesh.geometry.dispose(); // only the row's own index/haze; the shared buffers are freed in dispose()
      row.mesh.dispose();
    }
    rows = [];
    const random = mulberry32(o.seed);
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let layer = 0; layer < o.layers; layer++) {
      const z = -(o.distance + layer * o.layerGap);
      const screenWidth = 2 * (camera.position.z - z) * tanHalfFov * o.aspect;
      const length = screenWidth * o.span;
      const perLine = Math.max(1, Math.round(o.density(layer) * o.span));
      const spacing = length / perLine;
      const matrices: THREE.Matrix4[] = [];
      for (let i = 0; i < perLine; i++) {
        position.set(-length / 2 + (i + 0.5 + (random() * 2 - 1) * o.jitter) * spacing, o.height(layer), z);
        // Half the hills face away, so neighbours don't read as copies.
        rotation.setFromAxisAngle(up, (random() < 0.5 ? 0 : Math.PI) + (random() * 2 - 1) * 0.3);
        scale.setScalar(o.scale(layer) * (1 + (random() * 2 - 1) * o.scaleJitter));
        matrices.push(new THREE.Matrix4().compose(position, rotation, scale));
      }
      const error = rowError(o, layer);
      const mesh = new THREE.InstancedMesh(rowGeometry(lods.get(error) ?? null, perLine, o.hazeStrength(layer)), material, perLine);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      // Culled hill by hill in cull(), not as one big row.
      mesh.frustumCulled = false;
      // Drawn after the island and fighters, nearest row first, so whatever stands in front of a hill hides it before
      // it's shaded (three otherwise orders opaque objects by material, not distance): ~2 ms on an integrated GPU.
      mesh.renderOrder = 1 + layer;
      mesh.userData.lodError = error;
      group.add(mesh);
      rows.push({
        mesh,
        matrices,
        spheres: matrices.map((m) => geometry.boundingSphere!.clone().applyMatrix4(m)),
        shown: new Int32Array(perLine).fill(-1),
        haze: o.hazeStrength(layer),
      });
    }
    requestLods();
  };

  /** Simplify the hill for any row error not done yet (in a worker), then swap the simplified index in. */
  const requestLods = () => {
    const wanted = [...new Set(rows.map((r) => r.mesh.userData.lodError as number))].filter((e) => !lods.has(e));
    if (!wanted.length || lodWorker || typeof Worker !== 'function' || !geometry.index) return;
    const uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;
    if (!uv) return;
    try {
      lodWorker = new Worker(new URL('./hillsLod.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return;
    }
    const worker = lodWorker;
    const done = () => {
      worker.terminate();
      if (lodWorker === worker) lodWorker = null;
    };
    worker.onerror = done;
    worker.onmessage = (e: MessageEvent<HillsLodReply>) => {
      done();
      if (disposed) return;
      e.data.indices.forEach((index, i) => lods.set(wanted[i], index ? new THREE.BufferAttribute(index, 1) : null));
      for (const row of rows) {
        const lod = lods.get(row.mesh.userData.lodError as number);
        if (lod) row.mesh.geometry.setIndex(lod);
      }
      requestLods(); // options changed while this one ran
    };
    const request: HillsLodRequest = {
      index: Uint32Array.from(geometry.index.array as ArrayLike<number>),
      position: Float32Array.from(geometry.attributes.position.array as ArrayLike<number>),
      uv: Float32Array.from(uv.array as ArrayLike<number>),
      errors: wanted,
    };
    worker.postMessage(request, [request.index.buffer, request.position.buffer, request.uv.buffer]);
  };

  scatter();

  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  return {
    object: group,
    get options() {
      return current;
    },
    update(options) {
      current = { ...current, ...options };
      scatter();
    },
    cull(cam) {
      cam.updateMatrixWorld();
      frustum.setFromProjectionMatrix(viewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      for (const row of rows) {
        // Pack the hills in view to the front of the instance buffer; upload only when that set changes.
        let count = 0;
        let changed = false;
        for (let i = 0; i < row.spheres.length; i++) {
          if (!frustum.intersectsSphere(row.spheres[i])) continue;
          if (row.shown[count] !== i) {
            row.shown[count] = i;
            row.mesh.setMatrixAt(count, row.matrices[i]);
            changed = true;
          }
          count++;
        }
        if (changed || count !== row.mesh.count) {
          row.mesh.count = count;
          row.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    },
    dispose() {
      disposed = true;
      lodWorker?.terminate();
      group.removeFromParent();
      for (const row of rows) {
        row.mesh.geometry.dispose();
        row.mesh.dispose();
      }
      geometry.dispose();
      material.map?.dispose();
      material.dispose();
    },
  };
}

/** Small seeded RNG, so the same options always give the same hills. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
