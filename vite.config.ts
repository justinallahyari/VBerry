import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  base: './',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  build: {
    outDir: 'addon',
    emptyOutDir: true,
    target: 'chrome120',
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'sidepanel.html'),
        options: resolve(import.meta.dirname, 'options.html'),
        welcome: resolve(import.meta.dirname, 'welcome.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: chunk =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
