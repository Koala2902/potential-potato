import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  /** Where Express listens when you run `npm run dev:server`. Override in .env if the API is elsewhere. */
  const apiProxyTarget =
    env.API_PROXY_TARGET?.trim() || 'http://127.0.0.1:3001'

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  }
})

