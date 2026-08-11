import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../apps/web/public/aerstello.svg', import.meta.url));
await Promise.all([
  sharp(source).resize(192, 192).png().toFile(fileURLToPath(new URL('../apps/web/public/pwa-192.png', import.meta.url))),
  sharp(source).resize(512, 512).png().toFile(fileURLToPath(new URL('../apps/web/public/pwa-512.png', import.meta.url))),
]);
console.log('PWA icons generated.');
