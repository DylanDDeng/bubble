import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import tsconfigPaths from 'vite-tsconfig-paths';

// Renderer build. Electron main/preload are built separately via scripts/build-electron.mjs.
export default defineConfig({
  plugins: [react(), tailwindcss(), tsconfigPaths()],
  server: {
    host: '127.0.0.1',
    port: parseInt(process.env.PORT || '10090'),
    strictPort: true,
  },
  optimizeDeps: {
    include: ['sonner'],
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
  },
  base: './',
});
