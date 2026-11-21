import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  base: './',
  publicDir: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    outDir: 'addon/popup',
    emptyOutDir: false,
    target: 'chrome120',
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/popup/main.ts'),
      name: 'VBerryPopup',
      formats: ['iife'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: asset =>
          asset.names?.some(n => n.endsWith('.css')) ? 'popup.css' : '[name][extname]',
      },
    },
  },
})
