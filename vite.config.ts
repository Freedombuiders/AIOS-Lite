import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// The web app lives in web/; module UIs live in modules/<id>/web and are bundled in via import.meta.glob.
export default defineConfig(({ mode }) => {
  // AIOS_PORT from the shell wins, then .env at the repo root, then the default.
  const fileEnv = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'AIOS_');
  const apiPort = process.env.AIOS_PORT ?? fileEnv.AIOS_PORT ?? '4380';
  return {
    root: 'web',
    plugins: [preact(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./web/src', import.meta.url)),
        '@modules': fileURLToPath(new URL('./modules', import.meta.url)),
        '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
        react: 'preact/compat',
        'react-dom': 'preact/compat',
      },
    },
    server: {
      port: 5173,
      fs: { allow: ['..'] },
      proxy: { '/api': `http://127.0.0.1:${apiPort}` },
    },
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (/node_modules[\\/](preact|@preact[\\/]signals|wouter-preact|lucide-preact)[\\/]/.test(id)) return 'vendor';
          },
        },
      },
    },
  };
});
