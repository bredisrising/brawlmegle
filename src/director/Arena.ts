import * as THREE from 'three';

/** Static stage: one angled sun over a plain floor. Swap in a real environment later. */
export function createArena(scene: THREE.Scene) {
  const bg = new THREE.Color('#121216');
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 3, 8);

  // Low fill so the side facing away from the sun isn't pure black.
  scene.add(new THREE.HemisphereLight('#ffffff', '#202024', 0.5));

  const sun = new THREE.DirectionalLight('#fff4e5', 2.6);
  sun.position.set(-2, 4, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -2;
  sun.shadow.camera.right = sun.shadow.camera.top = 2;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6, 64),
    new THREE.MeshStandardMaterial({ color: '#2a2a30', roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.98, 1, 96),
    new THREE.MeshBasicMaterial({ color: '#4a4a52' }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.002;
  scene.add(ring);
}
