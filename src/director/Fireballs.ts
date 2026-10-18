import * as THREE from 'three';
import { FIGHT_LINE_SCALE, PLAYER_COLORS } from '../game/constants';
import type { PlayerId, Projectile } from '../types';

/** Height of a fireball above the floor (world units: about chest height on the scaled fighters). */
const HEIGHT = 0.46;

type Ball = { group: THREE.Group; core: THREE.Mesh; glow: THREE.Sprite; trail: THREE.Points; trailPos: Float32Array; age: number };

/**
 * Fireballs in flight, drawn from the engine's projectile list (the host's engine, or the host's frames on the
 * client). A hot core, a pulsing glow and a short trail, in the thrower's color; bloom does the rest.
 */
export class Fireballs {
  private readonly balls = new Map<number, Ball>();
  private readonly coreGeometry = new THREE.IcosahedronGeometry(0.05, 2);
  private readonly glowTexture = glowTexture();

  constructor(private readonly scene: THREE.Scene) {}

  /** Match the shown fireballs to the engine's list. */
  sync(list: readonly Projectile[]) {
    const live = new Set(list.map((p) => p.id));
    for (const [id, ball] of this.balls) {
      if (live.has(id)) continue;
      this.remove(ball);
      this.balls.delete(id);
    }
    for (const p of list) {
      const ball = this.balls.get(p.id) ?? this.add(p.id, p.owner);
      ball.group.position.set(p.x * FIGHT_LINE_SCALE, HEIGHT, 0);
    }
  }

  /** Per render frame: pulse, spin and trail (keeps going during hit-stop). */
  update(dt: number) {
    for (const ball of this.balls.values()) {
      ball.age += dt;
      const pulse = 1 + 0.18 * Math.sin(ball.age * 40);
      ball.core.scale.setScalar(pulse);
      ball.core.rotation.set(ball.age * 9, ball.age * 7, 0);
      ball.glow.scale.setScalar(0.32 * pulse);
      // Trail: a flickering streak of sparks behind the ball, spreading out toward its tail.
      const pos = ball.trailPos;
      const n = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const spread = 0.035 * (i / n);
        pos[i * 3] = i * 0.012 * (1 + 0.25 * Math.random());
        pos[i * 3 + 1] = (Math.random() - 0.5) * spread;
        pos[i * 3 + 2] = (Math.random() - 0.5) * spread;
      }
      (ball.trail.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose() {
    for (const ball of this.balls.values()) this.remove(ball);
    this.balls.clear();
    this.coreGeometry.dispose();
    this.glowTexture.dispose();
  }

  private add(id: number, owner: PlayerId) {
    const color = new THREE.Color(PLAYER_COLORS[owner]);
    const group = new THREE.Group();
    const core = new THREE.Mesh(this.coreGeometry, new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color('#ffffff'), 0.55).multiplyScalar(5) }));
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.glowTexture, color: color.clone().multiplyScalar(4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    const trailPos = new Float32Array(24 * 3);
    const trail = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(trailPos, 3)),
      new THREE.PointsMaterial({ map: this.glowTexture, color: color.clone().multiplyScalar(3), size: 0.05, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    // The trail lives in ball space, streaming back along the direction it came from.
    trail.scale.set(owner === 'p1' ? -1 : 1, 1, 1);
    trail.frustumCulled = false;
    group.add(core, glow, trail);
    this.scene.add(group);
    const ball: Ball = { group, core, glow, trail, trailPos, age: 0 };
    this.balls.set(id, ball);
    return ball;
  }

  private remove(ball: Ball) {
    ball.group.removeFromParent();
    (ball.core.material as THREE.Material).dispose();
    ball.glow.material.dispose();
    ball.trail.geometry.dispose();
    (ball.trail.material as THREE.Material).dispose();
  }
}

function glowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
