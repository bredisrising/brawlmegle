import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import islandUrl from '../../models/floating_island.glb?url';
import { disposeObject } from './dispose';
import { loadHills, type Hills } from './Hills';

const SKY_TOP = new THREE.Color('#1f5fc8');
const SKY_HORIZON = new THREE.Color('#a9cdee');
const SKY_BOTTOM = new THREE.Color('#000000');
const SUN_COLOR = new THREE.Color('#ffe0a3');
const SUN_DIRECTION = new THREE.Vector3(-2, 4, 2.5).normalize();
/** The island is modelled ~24 units across; this makes its barrels and crates read at fighter scale. */
const ISLAND_SCALE = 0.2;
/** Default island shift along the camera axis (+ = toward the camera), in world units. Tune live in the ` debug menu. */
export const ISLAND_OFFSET = -1;

export interface Arena {
  /** Current island shift along the camera axis (+ = toward the camera). */
  readonly islandOffset: number;
  setIslandOffset(z: number): void;
  /** Background hill rows (null until loaded); tune with hills.update({...}). */
  readonly hills: Hills | null;
  dispose(): void;
}

/** Sky dome: vertical gradient plus an HDR sun disk (bright enough to bloom). */
function createSky(radius: number) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: SKY_TOP },
      horizonColor: { value: SKY_HORIZON },
      bottomColor: { value: SKY_BOTTOM },
      sunColor: { value: SUN_COLOR },
      sunDirection: { value: SUN_DIRECTION },
      sunIntensity: { value: 40 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 bottomColor;
      uniform vec3 sunColor;
      uniform vec3 sunDirection;
      uniform float sunIntensity;
      varying vec3 vDirection;
      void main() {
        vec3 dir = normalize(vDirection);
        float h = dir.y;
        // Below the horizon: pale haze -> deep blue -> black straight down.
        vec3 color = h > 0.0
          ? mix(horizonColor, topColor, pow(h, 0.35))
          : mix(mix(horizonColor, topColor * 0.6, smoothstep(0.0, 0.3, -h)), bottomColor, smoothstep(0.0, 0.6, -h));
        float d = max(dot(dir, sunDirection), 0.0);
        color += sunColor * (smoothstep(0.9994, 0.9997, d) * sunIntensity + pow(d, 400.0) * 1.5 + pow(d, 12.0) * 0.15);
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
}

/** Static outdoor stage: sky dome, sky-lit environment, one sun over the floating island, hills behind. */
export function createArena(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): Arena {
  const sky = createSky(60);
  // Drawn first: it doesn't write depth, so anything past its radius (far hills) still shows over it.
  sky.renderOrder = -1;
  scene.add(sky);

  // Image-based fill from the sky itself; dim the sun disk so it doesn't double up on the directional light.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = createSky(60);
  envSky.material.uniforms.sunIntensity.value = 2;
  envScene.add(envSky);
  const envMap = pmrem.fromScene(envScene, 0.02, 0.1, 100).texture;
  envSky.geometry.dispose();
  envSky.material.dispose();
  pmrem.dispose();
  scene.environment = envMap;
  scene.environmentIntensity = 0.8;

  // Neutral sky/ground bounce so shadows read as shade rather than pure sky-blue.
  scene.add(new THREE.HemisphereLight('#dde8f5', '#6b5f4a', 1.1));

  const sun = new THREE.DirectionalLight(SUN_COLOR, 4);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -3;
  sun.shadow.camera.right = sun.shadow.camera.top = 3;
  sun.shadow.camera.far = 12;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.01;
  sun.shadow.radius = 3;
  scene.add(sun);

  let island: THREE.Group | null = null;
  let islandOffset = ISLAND_OFFSET;
  let disposed = false;
  loadIsland().then((model) => {
    if (disposed) return disposeObject(model);
    island = model;
    placeIsland(model, islandOffset);
    scene.add(model);
  }, (err) => console.error('Failed to load arena island', err));

  let hills: Hills | null = null;
  loadHills(camera).then((loaded) => {
    if (disposed) return loaded.dispose();
    hills = loaded;
    scene.add(loaded.object);
  }, (err) => console.error('Failed to load background hills', err));

  return {
    get islandOffset() {
      return islandOffset;
    },
    setIslandOffset(z) {
      islandOffset = z;
      if (island) placeIsland(island, z);
    },
    get hills() {
      return hills;
    },
    dispose() {
      disposed = true;
      envMap.dispose();
      sky.geometry.dispose();
      sky.material.dispose();
      hills?.dispose();
      if (island) {
        island.removeFromParent();
        disposeObject(island);
      }
    },
  };
}

/** The fight floor: the baked floating island, scaled to fighter size. */
async function loadIsland() {
  const model = (await new GLTFLoader().loadAsync(islandUrl)).scene;
  model.scale.setScalar(ISLAND_SCALE);
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      fixInsideOutParts(object.geometry);
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return model;
}

/**
 * Turn inside-out parts (e.g. the arch's voussoirs) right way out. The double-sided materials hide them in
 * shading, but shadows offset along the normal, so inward normals push the lookup inside the stone and the
 * part reads as fully shadowed. Parts are triangles joined by shared positions; negative volume = inside out.
 */
function fixInsideOutParts(geometry: THREE.BufferGeometry) {
  const index = geometry.index;
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  if (!index || !normal) return;

  const parent = Array.from({ length: position.count }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byPosition = new Map<string, number>();
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i).toFixed(4)},${position.getY(i).toFixed(4)},${position.getZ(i).toFixed(4)}`;
    const first = byPosition.get(key);
    if (first === undefined) byPosition.set(key, i);
    else parent[find(i)] = find(first);
  }
  for (let t = 0; t < index.count; t += 3) {
    parent[find(index.getX(t + 1))] = find(index.getX(t));
    parent[find(index.getX(t + 2))] = find(index.getX(t));
  }

  const volume = new Map<number, number>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < index.count; t += 3) {
    a.fromBufferAttribute(position, index.getX(t));
    b.fromBufferAttribute(position, index.getX(t + 1));
    c.fromBufferAttribute(position, index.getX(t + 2));
    const part = find(index.getX(t));
    volume.set(part, (volume.get(part) ?? 0) + a.dot(b.cross(c)) / 6);
  }
  if (![...volume.values()].some((v) => v < 0)) return;

  for (let t = 0; t < index.count; t += 3) {
    if (volume.get(find(index.getX(t)))! >= 0) continue;
    const second = index.getX(t + 1);
    index.setX(t + 1, index.getX(t + 2));
    index.setX(t + 2, second);
  }
  for (let i = 0; i < normal.count; i++) {
    if (volume.get(find(i))! < 0) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  }
  index.needsUpdate = true;
  normal.needsUpdate = true;
}

/** Ground meshes in the island GLB (props and outcrops are excluded so fighters never snap onto a rock). */
const GROUND_MESH = /^(Platform|Floor)[\s_]/;

/**
 * Shift the island along z, then drop it so the (uneven) ground under the origin, where the fighters stand,
 * is at y = 0. Past the island's edge there's no ground to hit, so it keeps its last height.
 */
function placeIsland(model: THREE.Object3D, z: number) {
  model.position.set(0, 0, z);
  model.updateMatrixWorld(true);
  const ground: THREE.Object3D[] = [];
  model.traverse((object) => {
    if (object instanceof THREE.Mesh && GROUND_MESH.test(object.name)) ground.push(object);
  });
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
  const hit = ray.intersectObjects(ground, false)[0];
  if (hit) model.userData.groundY = hit.point.y;
  model.position.y = -(model.userData.groundY ?? 0);
}
