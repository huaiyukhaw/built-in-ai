import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: { port: 5174 },
  build: { target: 'es2023' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'pcm-worklet.js', 'theme-init.js'],
      manifest: {
        id: '/',
        name: 'Meeting Copilot',
        short_name: 'Copilot',
        description: 'On-device live captions, translation, Q&A and minutes for meetings, using Chrome built-in AI.',
        start_url: '/',
        display: 'standalone',
        background_color: '#121316',
        theme_color: '#1a73e8',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
        // Font subsets load per unicode-range; cache each one the first time it's used.
        runtimeCaching: [{ urlPattern: /\.woff2$/, handler: 'CacheFirst', options: { cacheName: 'fonts', expiration: { maxEntries: 30 } } }],
      },
    }),
  ],
  test: { environment: 'node' },
});
