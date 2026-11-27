import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    // livekit-client (~550 kB) is the only chunk above the default limit; it loads on demand when
    // live voice is first used (see features/voice/state/lazy-livekit-client.ts), so the limit is
    // raised just above it instead of hiding growth in the initial chunk.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // React runtime in its own long-lived, cacheable chunk, apart from app code.
        manualChunks: (id: string) =>
          /node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'react-vendor' : undefined,
      },
    },
  },
  server: {
    port: Number(process.env.FRONTEND_PORT ?? 5173),
    proxy: {
      '/api': {
        target: process.env.BACKEND_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          proxy.on('error', (_err, _req, res) => {
            if (res && 'writeHead' in res && typeof res.writeHead === 'function' && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({ error: { code: 'NOT_READY', retryable: true } }));
            }
          });
        },
      },
    },
  },
})
