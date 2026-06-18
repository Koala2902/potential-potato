import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';

const operationRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, path.resolve(operationRoot, '../..'), '');
    const apiProxyTarget = env.API_PROXY_TARGET?.trim() || 'http://127.0.0.1:3001';

    return {
        root: operationRoot,
        cacheDir: path.resolve(operationRoot, '../../.cache/vite-operation'),
        server: {
            port: 5174,
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
