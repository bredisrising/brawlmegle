import * as THREE from 'three';
import { PLAYER_COLORS } from '../game/constants';

/** Static stage: background, lights, floor. Swap in a real environment later. */
export function createArena(scene: THREE.Scene) {
  const bg = new THREE.Color('#0b0614');
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 2.5, 8);

  scene.add(new THREE.HemisphereLight('#8a7cff', '#1a0f24', 0.6));

  const key = new THREE.DirectionalLight('#ffffff', 2);
  key.position.set(1, 3, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);

  // Team-colored rim lights on each side.
  const p1Rim = new THREE.PointLight(PLAYER_COLORS.p1, 3, 4);
  p1Rim.position.set(-1.4, 1, 0.5);
  const p2Rim = new THREE.PointLight(PLAYER_COLORS.p2, 3, 4);
  p2Rim.position.set(1.4, 1, 0.5);
  scene.add(p1Rim, p2Rim);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6, 64),
    new THREE.MeshStandardMaterial({ color: '#16101f', roughness: 0.85 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.95, 1, 96),
    new THREE.MeshBasicMaterial({ color: '#ff2bd6' }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.002;
  scene.add(ring);

  const grid = new THREE.GridHelper(12, 48, '#3a2350', '#22152f');
  grid.position.y = 0.001;
  scene.add(grid);
}
