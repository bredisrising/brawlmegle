import type * as THREE from 'three';

export type EffectKind = 'light' | 'heavy' | 'blocked' | 'spawn' | 'ko';

/**
 * Visual effects layer (hit sparks, impact rings, etc).
 *
 * TODO: particle bursts + impact rings per EffectKind, billboarded toward the camera.
 */
export class Effects {
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  burst(_point: THREE.Vector3, _kind: EffectKind) {
    void this.scene;
  }

  /** Called every render frame (keeps animating during freeze frames). */
  update(_dt: number) {}

  dispose() {}
}
