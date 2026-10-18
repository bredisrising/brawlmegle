import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The arena's GLBs (models/*.glb, baked in Blender) ship optimized: WebP textures at full size and meshopt geometry,
 * 7.7 MB -> ~2 MB (research/perf-assets.md). Same optimizer the forge runs on fighters (forge/optimize.js), run on
 * the build output, so re-baking in Blender needs no extra step. Dev serves the originals; the loader takes both.
 */
function optimizeGlbs(): Plugin {
  return {
    name: 'brawlmegle:optimize-glbs',
    apply: 'build',
    async generateBundle(_, bundle) {
      // Loaded at build time only (and kept out of the config bundle): its packages are devDependencies.
      const { optimizeGlb, ARENA } = await import(new URL('./forge/optimize.js', import.meta.url).href);
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.glb')) continue;
        const input = typeof file.source === 'string' ? new TextEncoder().encode(file.source) : file.source;
        try {
          const result = await optimizeGlb(input, ARENA);
          if (!result) continue;
          file.source = new Uint8Array(result.glb);
          this.info(`${file.fileName}: ${(result.bytesBefore / 1e6).toFixed(2)} -> ${(result.bytesAfter / 1e6).toFixed(2)} MB`);
        } catch (err) {
          // A deploy shouldn't be blocked by this: ship the original (it loads the same, just bigger).
          this.warn(`${file.fileName} NOT optimized (${(err as Error).message}); run npm ci for the optimizer's packages`);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), optimizeGlbs()],
  build: {
    // three.js is ~670 kB on its own (170 kB gzipped); it's one cached download.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // Libraries in their own chunks: they rarely change, so a redeploy of the game (often, at a hackathon)
        // only re-downloads the game's own code. MediaPipe's JS is split off already (loaded with the camera).
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|zustand)[\\/]/ },
          ],
        },
      },
    },
  },
});
