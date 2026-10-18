import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * Anime-style impact frame: for a frame or two on a big hit, the whole picture cuts to stark two-tone with speed
 * lines bursting from the point of impact (first the negative, then the positive). Runs after tone mapping, so the
 * colors come out exactly as written.
 */
const shader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uOn: { value: 0 },
    uInvert: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
    uSeed: { value: 0 },
    uInk: { value: new THREE.Color('#0b0a10') },
    uPaper: { value: new THREE.Color('#f6f0e4') },
    uAccent: { value: new THREE.Color('#ff2d55') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uOn, uInvert, uAspect, uSeed;
    uniform vec2 uCenter;
    uniform vec3 uInk, uPaper, uAccent;
    varying vec2 vUv;
    float hash(float n) { return fract(sin(n) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (uOn < 0.5) { gl_FragColor = c; return; }
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      // Bright things (fighters under the lights, sparks) go to ink, the rest to paper: silhouettes pop.
      float dark = step(0.42, l);
      vec3 col = mix(uPaper, uInk, dark);
      if (uInvert > 0.5) col = mix(uInk, uPaper, dark);
      // Speed lines: thin wedges radiating from the hit, clear near the center.
      vec2 d = (vUv - uCenter) * vec2(uAspect, 1.0);
      float a = atan(d.y, d.x) / 6.2831853 + 0.5;
      float r = length(d);
      float slot = floor(a * 140.0);
      float width = hash(slot + uSeed) ;
      float line = step(0.78, width) * smoothstep(0.08 + 0.12 * hash(slot * 1.7 + uSeed), 0.5, r);
      col = mix(col, uInvert > 0.5 ? uPaper : uInk, line);
      // A hot core right at the impact.
      col = mix(col, uAccent, (1.0 - smoothstep(0.0, 0.05, r)) * 0.9);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class ImpactPass extends ShaderPass {
  private remaining = 0;
  private total = 0;

  constructor() {
    super(shader);
  }

  /** Cut to an impact frame for `seconds` (negative for the first half, positive after) centered on `uv`. */
  trigger(uv: { x: number; y: number }, seconds: number, accent?: THREE.ColorRepresentation) {
    this.remaining = this.total = seconds;
    this.uniforms.uCenter.value.set(uv.x, uv.y);
    this.uniforms.uSeed.value = Math.random() * 100;
    this.uniforms.uAccent.value.set(accent ?? '#ff2d55');
  }

  tick(dt: number, aspect: number) {
    this.uniforms.uAspect.value = aspect;
    const on = this.remaining > 0;
    this.uniforms.uOn.value = on ? 1 : 0;
    this.uniforms.uInvert.value = on && this.remaining > this.total / 2 ? 1 : 0;
    if (on) this.remaining -= dt;
  }
}
