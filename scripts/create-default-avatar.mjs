import { mkdir, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// GLTFExporter uses this browser API to assemble its binary output.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};

// One meter tall, feet on the floor, +Z forward, matching the director's guard pose.
const model = new THREE.Group();
model.name = 'default';
const material = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true });
const skin = material('#d7a079');
const shirt = material('#e8e5dc');
const trousers = material('#354b64');
const shoes = material('#202534');
const hair = material('#3d2b25');
const gloves = material('#df6247');

function part(name, geometry, surface, position) {
  const mesh = new THREE.Mesh(geometry, surface);
  mesh.name = name;
  mesh.position.set(...position);
  model.add(mesh);
  return mesh;
}

function box(name, size, surface, position) {
  return part(name, new THREE.BoxGeometry(...size), surface, position);
}

function limb(name, from, to, radiusTop, radiusBottom, surface) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const direction = end.clone().sub(start);
  const mesh = part(
    name,
    new THREE.CylinderGeometry(radiusTop, radiusBottom, direction.length(), 5, 1),
    surface,
    start.clone().add(end).multiplyScalar(0.5).toArray(),
  );
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
}

box('hips', [0.19, 0.1, 0.12], trousers, [0, 0.49, 0]);
const torso = part('shirt', new THREE.CylinderGeometry(0.17, 0.12, 0.25, 4, 1), shirt, [0, 0.665, 0]);
torso.rotation.y = Math.PI / 4;
torso.scale.z = 0.65;
box('neck', [0.065, 0.07, 0.065], skin, [0, 0.815, 0]);
box('head', [0.135, 0.16, 0.13], skin, [0, 0.9, 0]);
box('hair', [0.145, 0.04, 0.14], hair, [0, 0.98, -0.005]);
box('left eye', [0.016, 0.016, 0.008], shoes, [0.032, 0.92, 0.068]);
box('right eye', [0.016, 0.016, 0.008], shoes, [-0.032, 0.92, 0.068]);
box('nose', [0.025, 0.025, 0.025], skin, [0, 0.889, 0.073]);

for (const [side, sign] of [['left', 1], ['right', -1]]) {
  const shoulder = [sign * 0.12, 0.78, 0];
  const elbow = [sign * 0.15, 0.66, 0.04];
  const wrist = [sign * 0.07, 0.76, sign === 1 ? 0.15 : 0.12];
  limb(`${side} upper arm`, shoulder, elbow, 0.043, 0.034, skin);
  limb(`${side} forearm`, elbow, wrist, 0.034, 0.027, skin);
  part(`${side} glove`, new THREE.IcosahedronGeometry(0.047, 0), gloves, wrist);

  const hip = [sign * 0.07, 0.5, 0];
  const knee = [sign * 0.075, 0.27, sign === 1 ? 0.05 : -0.03];
  const ankle = [sign * 0.07, 0.045, sign === 1 ? 0.08 : -0.06];
  limb(`${side} thigh`, hip, knee, 0.052, 0.041, trousers);
  limb(`${side} shin`, knee, ankle, 0.041, 0.03, trousers);
  box(`${side} shoe`, [0.085, 0.06, 0.15], shoes, [ankle[0], 0.03, ankle[2] + 0.03]);
}

const glb = await new GLTFExporter().parseAsync(model, { binary: true });
const directory = new URL('../public/models/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('default.glb', directory), Buffer.from(glb));
let triangles = 0;
model.traverse((object) => {
  if (object.isMesh) triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
});
console.log(`Created default.glb: ${triangles} triangles, ${glb.byteLength} bytes`);
