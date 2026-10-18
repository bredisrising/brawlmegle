// three ships meshoptimizer's simplifier without type declarations; just what hillsLod.worker.ts uses.
declare module 'three/addons/libs/meshopt_simplifier.module.js' {
  type Flag = 'LockBorder' | 'Sparse' | 'ErrorAbsolute' | 'Prune' | 'Regularize' | 'Permissive' | 'RegularizeLight';
  export const MeshoptSimplifier: {
    ready: Promise<void>;
    supported: boolean;
    getScale(positions: Float32Array, stride: number): number;
    simplifyWithAttributes(
      indices: Uint32Array,
      positions: Float32Array,
      positionStride: number,
      attributes: Float32Array,
      attributeStride: number,
      weights: number[],
      lock: Uint8Array | null,
      targetIndexCount: number,
      targetError: number,
      flags?: Flag[],
    ): [Uint32Array, number];
  };
}
