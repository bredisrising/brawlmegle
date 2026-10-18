import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import hillsUrl from '../../models/forested_hills.glb?url';

export interface HillOptions {
  /** Hills per screen width on every line. */
  density: number;
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
  /** Atmospheric perspective: hazeColor mixed in by 1 - exp(-hazeStrength * distance from the camera). */
  hazeStrength: number;
  hazeColor: THREE.ColorRepresentation;
  /** Screen proportions that "a screen width" is measured with. */
  aspect: number;
  seed: number;
}

export const DEFAULT_HILLS: HillOptions = {
  density: 4,
  span: 1.5,
  jitter: 0.35,
  distance: 12,
  layers: 3,
  layerGap: 10,
  height: (layer) => -1.7 - layer * 0.5,
  scale: (layer) => 0.45 + layer * 0.3,
  scaleJitter: 0.2,
  hazeStrength: 0.03,
  hazeColor: '#a9cdee',
  aspect: 16 / 9,
  seed: 1,
};

export interface Hills {
  readonly object: THREE.Group;
  readonly options: HillOptions;
  /** Re-scatter with some options changed (the rest are kept). */
  update(options: Partial<HillOptions>): void;
  dispose(): void;
}

/** Background scenery: rows of the forested hill, spread across the screen at each depth and hazed with distance. */
export async function loadHills(camera: THREE.PerspectiveCamera, options: Partial<HillOptions> = {}): Promise<Hills> {
  const gltf = await new GLTFLoader().loadAsync(hillsUrl);
  // Just the mesh, without the scene placement it was exported with.
  let source: THREE.Mesh | undefined;
  gltf.scene.traverse((object) => {
    if (!source && object instanceof THREE.Mesh) source = object;
  });
  if (!source) throw new Error('forested_hills.glb has no mesh');
  const geometry = source.geometry;
  const material = (source.material as THREE.MeshStandardMaterial).clone();
  (source.material as THREE.Material).dispose();

  const haze = { hazeColor: { value: new THREE.Color() }, hazeStrength: { value: 0 } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, haze);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 hazeColor;\nuniform float hazeStrength;\nvoid main() {')
      .replace(
        '#include <fog_fragment>',
        '#include <fog_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor, 1.0 - exp(-hazeStrength * length(vViewPosition)));',
      );
  };
  material.customProgramCacheKey = () => 'hills-haze';

  const group = new THREE.Group();
  group.name = 'Background hills';
  let mesh: THREE.InstancedMesh | null = null;
  let current: HillOptions = { ...DEFAULT_HILLS, ...options };

  const scatter = () => {
    const o = current;
    haze.hazeColor.value.set(o.hazeColor);
    haze.hazeStrength.value = o.hazeStrength;

    const random = mulberry32(o.seed);
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const perLine = Math.max(1, Math.round(o.density * o.span));
    const matrices: THREE.Matrix4[] = [];
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let layer = 0; layer < o.layers; layer++) {
      const z = -(o.distance + layer * o.layerGap);
      const screenWidth = 2 * (camera.position.z - z) * tanHalfFov * o.aspect;
      const length = screenWidth * o.span;
      const spacing = length / perLine;
      for (let i = 0; i < perLine; i++) {
        position.set(-length / 2 + (i + 0.5 + (random() * 2 - 1) * o.jitter) * spacing, o.height(layer), z);
        // Half the hills face away, so neighbours don't read as copies.
        rotation.setFromAxisAngle(up, (random() < 0.5 ? 0 : Math.PI) + (random() * 2 - 1) * 0.3);
        scale.setScalar(o.scale(layer) * (1 + (random() * 2 - 1) * o.scaleJitter));
        matrices.push(new THREE.Matrix4().compose(position, rotation, scale));
      }
    }

    if (mesh) mesh.removeFromParent();
    mesh?.dispose();
    mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((m, i) => mesh!.setMatrixAt(i, m));
    mesh.computeBoundingSphere();
    group.add(mesh);
  };
  scatter();

  return {
    object: group,
    get options() {
      return current;
    },
    update(options) {
      current = { ...current, ...options };
      scatter();
    },
    dispose() {
      group.removeFromParent();
      mesh?.dispose();
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
