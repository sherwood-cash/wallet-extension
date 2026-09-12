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

// The dapp-connection scripts the manifest references by FIXED path. They must emit as
// exactly these filenames (not hashed) so manifest.json keeps resolving after a rebuild.
const FIXED_ENTRIES: Record<string, string> = {
  background: path.resolve(here, 'src/dapp/background.ts'),
  content: path.resolve(here, 'src/dapp/content.ts'),
  inpage: path.resolve(here, 'src/dapp/inpage.ts'),
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
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      // The popup page (index.html), the approval popup page (approval.html) and the three
      // extension scripts (background / content / inpage). HTML entries carry their own
      // hashed JS; the three scripts below are named so the manifest can reference them.
      input: {
        index: path.resolve(here, 'index.html'),
        approval: path.resolve(here, 'approval.html'),
        ...FIXED_ENTRIES,
      },
      output: {
        // background.js / content.js / inpage.js keep their names; everything else (the
        // page bundles) stays hashed under assets/ so caching still works.
        entryFileNames: (chunk) =>
          chunk.name in FIXED_ENTRIES ? '[name].js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
