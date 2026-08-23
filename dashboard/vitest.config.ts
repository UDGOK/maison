import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // v0.6 D1 — `src/brand.test.ts` server-renders the components to prove no hard-coded
  // "Maison" / "Boutique" reaches the screen, so .vue files must be transformed here too.
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
