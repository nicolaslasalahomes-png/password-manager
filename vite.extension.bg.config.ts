import { defineConfig } from 'vite'
import path from 'node:path'

/**
 * Second pass for the extension: build the background service worker as a
 * single ESM file written to extension/dist/background.js.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: path.resolve(__dirname, 'extension/dist'),
    emptyOutDir: false, // don't clobber popup output
    sourcemap: false,
    lib: {
      entry: path.resolve(__dirname, 'extension/src/background.ts'),
      formats: ['es'],
      fileName: () => 'background.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
