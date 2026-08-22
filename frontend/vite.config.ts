import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ASSET_BASE = '/assets/maison_pos/pos/'
const OUT_DIR = '../maison_pos/public/pos'

/**
 * The worker is served from /api/method/maison_pos.api.pwa.service_worker (see src/main.ts),
 * so every precache URL must be absolute. `workbox.modifyURLPrefix` handles the glob entries
 * but vite-plugin-pwa appends `manifest.webmanifest` (and manifest icons) relative afterwards;
 * rewrite those once the worker has been written.
 */
function absolutePrecacheUrls() {
  return {
    name: 'maison:absolute-precache-urls',
    closeBundle: {
      sequential: true as const,
      order: 'post' as const,
      handler() {
        const sw = resolve(__dirname, OUT_DIR, 'sw.js')
        if (!existsSync(sw)) return
        const src = readFileSync(sw, 'utf8')
        const out = src.replace(/url:"(?!\/|https?:)([^"]+)"/g, (_m, u: string) => `url:"${ASSET_BASE}${u}"`)
        if (out !== src) writeFileSync(sw, out)
      }
    }
  }
}

export default defineConfig(({ command }) => ({
  // dev server runs at / so the router base matches; production assets live under Frappe's /assets
  base: command === 'serve' ? '/' : ASSET_BASE,
  plugins: [
    vue(),
    absolutePrecacheUrls(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registration is done by hand in src/main.ts: the worker is fetched through
      // /api/method/maison_pos.api.pwa.service_worker (which adds Service-Worker-Allowed: /pos/)
      // so that scope /pos/ is accepted on hosts that serve /assets without that header.
      injectRegister: null,
      scope: '/pos/',
      includeManifestIcons: false, // icons are picked up by globPatterns (with the absolute prefix)
      manifest: {
        name: 'Maison POS',
        short_name: 'Maison',
        description: 'Maison boutique point of sale',
        start_url: '/pos/',
        scope: '/pos/',
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
        // The worker is served from /api/method/..., not from /assets/maison_pos/pos/, so it
        // must not rely on its own URL: bundle workbox into sw.js and make precache URLs absolute.
        inlineWorkboxRuntime: true,
        modifyURLPrefix: { '': ASSET_BASE },
        // Navigations are handled by the NetworkFirst "maison-shell" route below (the shell is
        // rendered by www/pos.py with the CSRF token, so it must come from the network when
        // possible). navigateFallback stays off; the precached index.html is the last resort.
        navigateFallback: null,
        navigateFallbackDenylist: [/^\/api\//, /^\/app\//],
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        runtimeCaching: [
          {
            // app shell: /pos and /pos/* navigations. NetworkFirst keeps the server-rendered
            // page (CSRF token, login redirect) fresh while online; offline, any /pos/* reload
            // gets the last cached shell (single cache key) or the precached Vite index.html.
            urlPattern: ({ request, url }) =>
              request.mode === 'navigate' && url.origin === self.location.origin && /^\/pos(\/|$)/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'maison-shell',
              networkTimeoutSeconds: 6,
              plugins: [
                {
                  cacheKeyWillBeUsed: async () => '/pos/',
                  // never cache a login redirect or an error page as the shell
                  cacheWillUpdate: async ({ response }) =>
                    response && response.status === 200 && !response.redirected ? response : null,
                  handlerDidError: async () =>
                    (await caches.match('/assets/maison_pos/pos/index.html', { ignoreSearch: true })) ?? Response.error()
                }
              ]
            }
          },
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
    outDir: OUT_DIR,
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
