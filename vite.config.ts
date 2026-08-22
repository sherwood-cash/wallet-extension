import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, 'dist')

/** manifest.json has to sit at the root of the bundle, and it is not something Vite
 *  knows about. Everything else the extension needs is already under public/. */
function copyManifest() {
  return {
    name: 'copy-manifest',
    apply: 'build' as const,
    async closeBundle() {
      await copyFile(path.join(here, 'manifest.json'), path.join(outDir, 'manifest.json'))
    },
  }
}

export default defineConfig({
  // Extension pages load from chrome-extension://<id>/, with the bundle at the root of
  // that origin, so relative asset URLs are the only ones that resolve.
  base: './',
  plugins: [
    react(),
    // The privacy layer is a port of a node codebase and wants Buffer and node crypto;
    // snarkjs reaches for node globals of its own.
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      include: ['crypto', 'buffer', 'stream', 'util', 'vm'],
    }),
    copyManifest(),
  ],
  resolve: {
    // `@app` is the vendored protocol layer — the same modules the Sherwood web app
    // runs. The alias is kept (rather than rewriting every import) so a file can be
    // diffed against its upstream copy without noise.
    alias: { '@app': path.resolve(here, 'src/protocol') },
  },
  optimizeDeps: { exclude: ['snarkjs'] },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    // One popup page: splitting buys nothing and a single bundle keeps the surface the
    // MV3 content-security-policy has to allow as small as possible.
    chunkSizeWarningLimit: 8000,
  },
})
