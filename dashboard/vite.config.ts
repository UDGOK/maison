import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/assets/maison_pos/dashboard/',
  build: {
    outDir: '../maison_pos/public/dashboard',
    emptyOutDir: true,
  },
  server: { port: 5174, host: '127.0.0.1' },
})
