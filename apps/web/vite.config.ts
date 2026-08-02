import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const apiPort = process.env.PORT ?? '3001';
const webPort = Number(process.env.E2E_WEB_PORT ?? '5173');
const apiProxy = { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } };

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: true },
      includeAssets: ['sky-bar.svg'],
      manifest: {
        name: 'Sky Bar',
        short_name: 'Sky Bar',
        description: 'Bar operations and guest self-service',
        lang: 'de',
        theme_color: '#09121e',
        background_color: '#07101b',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        runtimeCaching: [{
          urlPattern: ({ url, request }) => request.method === 'GET' && [
            '/api/v1/public/bootstrap',
            '/api/v1/guest/catalog',
          ].includes(url.pathname),
          handler: 'NetworkFirst',
          options: { cacheName: 'sky-bar-public-catalog', networkTimeoutSeconds: 3, expiration: { maxEntries: 10, maxAgeSeconds: 86_400 } },
        }],
      },
    }),
  ],
  server: {
    port: webPort,
    proxy: apiProxy,
  },
  preview: {
    port: webPort,
    proxy: apiProxy,
  },
});
