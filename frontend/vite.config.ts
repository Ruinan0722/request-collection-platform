import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@modules': path.resolve(__dirname, 'src/modules'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 17863,
    strictPort: true,
    allowedHosts: ['localhost', '127.0.0.1'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:17864',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:17864',
        changeOrigin: true,
      },
    },
  },
});
