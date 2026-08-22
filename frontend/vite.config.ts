import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ command }) => ({
  // dev server runs at / so the router base matches; production assets live under Frappe's /assets
  base: command === 'serve' ? '/' : '/assets/maison_pos/pos/',
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      scope: '/pos',
      manifest: {
        name: 'Maison POS',
        short_name: 'Maison',
        description: 'Maison boutique point of sale',
        start_url: '/pos',
        scope: '/pos',
        display: 'standalone',
        orientation: 'landscape',
        theme_color: '#0A1410',
        background_color: '#0A1410',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        navigateFallback: null,
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        runtimeCaching: [
          {
            // catalog endpoints: NetworkFirst so the last good bootstrap survives offline
            urlPattern: ({ url }) => url.pathname.startsWith('/api/method/maison_pos.api.catalog.'),
            handler: 'NetworkFirst',
            method: 'GET',
            options: {
              cacheName: 'maison-catalog',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 7 }
            }
          },
          {
            // sales.* must NEVER be cached: NetworkOnly
            urlPattern: ({ url }) => url.pathname.startsWith('/api/method/maison_pos.api.sales.'),
            handler: 'NetworkOnly'
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'maison-fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } }
          }
        ]
      },
      devOptions: { enabled: false }
    })
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  build: {
    outDir: '../maison_pos/public/pos',
    emptyOutDir: true,
    manifest: true,
    sourcemap: false
  },
  server: { port: 5173, host: true },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/tests/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts']
  }
}) as any)
