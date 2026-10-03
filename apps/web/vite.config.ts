import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Whiteboards: serve Excalidraw's fonts from Agent HQ itself (at
 * /excalidraw-assets/fonts) instead of its CDN, so drawing works offline.
 * The CJK font (Xiaolai, 12 MB) is left out; Excalidraw falls back to its
 * CDN for it.
 */
function excalidrawFonts(): Plugin {
  const fonts = path.join(path.dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw')), 'fonts');
  const skip = (file: string) => path.relative(fonts, file).split(path.sep)[0] === 'Xiaolai';
  let outDir = 'dist';
  return {
    name: 'excalidraw-fonts',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/excalidraw-assets/fonts', (req, res, next) => {
        const file = path.join(fonts, decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname));
        if (!file.startsWith(fonts) || skip(file) || !existsSync(file) || statSync(file).isDirectory()) return next();
        res.setHeader('content-type', 'font/woff2');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      cpSync(fonts, path.join(outDir, 'excalidraw-assets', 'fonts'), { recursive: true, filter: (src) => !skip(src) });
    },
  };
}

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  build: { chunkSizeWarningLimit: 2500 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
});
