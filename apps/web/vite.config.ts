import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

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
          urlPattern: ({ url }) => url.pathname.startsWith('/api/v1/') && !url.pathname.includes('/auth/'),
          handler: 'NetworkFirst',
          options: { cacheName: 'sky-bar-api', networkTimeoutSeconds: 3, expiration: { maxEntries: 80, maxAgeSeconds: 86_400 } },
        }],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } },
  },
});
