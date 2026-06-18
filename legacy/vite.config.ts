import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';

const legacyRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, path.resolve(legacyRoot, '..'), '');
    const apiProxyTarget = env.API_PROXY_TARGET?.trim() || 'http://127.0.0.1:3001';

    return {
        root: legacyRoot,
        cacheDir: path.resolve(legacyRoot, '../.cache/vite-tablet'),
        server: {
            port: 5175,
            strictPort: true,
            host: '0.0.0.0',
            allowedHosts: true,
            proxy: {
                '/api': {
                    target: apiProxyTarget,
                    changeOrigin: true,
                },
            },
        },
    };
});
