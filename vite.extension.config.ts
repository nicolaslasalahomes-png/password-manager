import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Builds the browser extension. Two-pass build:
 *
 *   1. Popup (this config) — HTML entry, React, all the UI bundles
 *   2. Background service worker — built separately by `build:extension:bg`
 *
 * Why two passes: Vite's HTML entry mode doesn't cleanly co-output a separate
 * service-worker bundle without complex config. Separate builds are clearer.
 *
 * The manifest + icons are copied verbatim into the output directory after the
 * popup build via the custom `copyStatic` plugin below.
 */

const ROOT = __dirname
const EXT_SRC = path.resolve(ROOT, 'extension')
const OUT = path.resolve(ROOT, 'extension/dist')

function copyStatic() {
  return {
    name: 'copy-extension-static',
    closeBundle() {
      // manifest
      fs.copyFileSync(path.join(EXT_SRC, 'manifest.json'), path.join(OUT, 'manifest.json'))
      // icons — use placeholder favicon for now; replace with real PNGs later
      const favicon = path.join(ROOT, 'public/favicon.svg')
      if (fs.existsSync(favicon)) {
        for (const size of ['16', '32', '48', '128']) {
          // Chrome accepts .png only for action icons; we leave the manifest
          // pointing at .png but copy the SVG-as-placeholder if present.
          // Replace with real PNGs before shipping to the Chrome Web Store.
          fs.copyFileSync(favicon, path.join(OUT, `icon-${size}.png`))
        }
      }
      // Vite picks up the parent /public folder despite root override —
      // delete anything that landed in dist that we don't want.
      for (const stray of ['favicon.svg', 'icons.svg']) {
        const p = path.join(OUT, stray)
        if (fs.existsSync(p)) fs.unlinkSync(p)
      }
    },
  }
}

export default defineConfig({
  root: EXT_SRC,
  // Relative asset paths so popup.html works under chrome-extension://
  base: './',
  // Don't auto-copy main public/ contents into the extension bundle
  publicDir: false,
  plugins: [react(), copyStatic()],
  resolve: {
    alias: {
      '@vault': path.resolve(ROOT, 'src'),
    },
  },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: path.resolve(EXT_SRC, 'popup.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
