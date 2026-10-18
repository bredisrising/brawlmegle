import * as THREE from 'three';
import { FIGHT_LINE_SCALE, PLAYER_COLORS } from '../game/constants';
import type { PlayerId, Projectile } from '../types';

/** Height of a fireball above the floor (world units: about chest height on the scaled fighters). */
const HEIGHT = 0.46;

type Ball = { owner: PlayerId; group: THREE.Group; core: THREE.Mesh; glow: THREE.Sprite; trail: THREE.Points; trailPos: Float32Array; age: number };

/**
 * Fireballs in flight, drawn from the engine's projectile list (the host's engine, or the host's frames on the
 * client). A hot core, a pulsing glow and a short trail, in the thrower's color; bloom does the rest.
 * Balls are pooled per thrower and their materials kept: disposing them deleted the shaders, so a fireball after a
 * quiet spell compiled them again on the frame it was thrown.
 */
export class Fireballs {
  private readonly balls = new Map<number, Ball>();
  private readonly free: Record<PlayerId, Ball[]> = { p1: [], p2: [] };
  private readonly all: Ball[] = [];
  private readonly coreGeometry = new THREE.IcosahedronGeometry(0.05, 2);
  private readonly glowTexture = glowTexture();
  /** Warm-up: one ball per thrower drawn at zero size for a couple of frames, so its shaders exist before a throw. */
  private warm: Ball[] = [];
  private warmFrames = 2;

  constructor(private readonly scene: THREE.Scene) {
    for (const owner of ['p1', 'p2'] as PlayerId[]) {
      const ball = this.make(owner);
      ball.group.scale.setScalar(0);
      ball.group.position.set(0, HEIGHT, 0);
      this.scene.add(ball.group);
      this.warm.push(ball);
    }
  }

  /** Match the shown fireballs to the engine's list. */
  sync(list: readonly Projectile[]) {
    for (const [id, ball] of this.balls) {
      if (list.some((p) => p.id === id)) continue;
      this.release(ball);
      this.balls.delete(id);
    }
    for (const p of list) {
      const ball = this.balls.get(p.id) ?? this.add(p.id, p.owner);
      ball.group.position.set(p.x * FIGHT_LINE_SCALE, HEIGHT, 0);
    }
  }

  /** Per render frame: pulse, spin and trail (keeps going during hit-stop). */
  update(dt: number) {
    if (this.warmFrames > 0 && --this.warmFrames === 0) {
      for (const ball of this.warm) {
        ball.group.scale.setScalar(1);
        this.release(ball);
      }
      this.warm = [];
    }
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
    for (const ball of this.all) {
      ball.group.removeFromParent();
      (ball.core.material as THREE.Material).dispose();
      ball.glow.material.dispose();
      ball.trail.geometry.dispose();
      (ball.trail.material as THREE.Material).dispose();
    }
    this.balls.clear();
    this.all.length = 0;
    this.coreGeometry.dispose();
    this.glowTexture.dispose();
  }

  private add(id: number, owner: PlayerId) {
    const ball = this.free[owner].pop() ?? this.make(owner);
    ball.age = 0;
    this.scene.add(ball.group);
    this.balls.set(id, ball);
    return ball;
  }

  private release(ball: Ball) {
    ball.group.removeFromParent();
    this.free[ball.owner].push(ball);
  }

  private make(owner: PlayerId): Ball {
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
    const ball: Ball = { owner, group, core, glow, trail, trailPos, age: 0 };
    this.all.push(ball);
    return ball;
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
