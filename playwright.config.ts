import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// End-to-end: builds the web app, starts AIOS-Lite on a spare port with throw-away data/agents dirs,
// and drives the real UI. Only the `mock` runtime is used, so no CLI or API key is needed.
const port = Number(process.env.AIOS_E2E_PORT ?? 4399);
const tmp = path.join(os.tmpdir(), `aios-e2e-${port}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `rm -rf ${tmp} && mkdir -p ${tmp} && cp -R agents ${tmp}/agents && npx vite build && AIOS_PORT=${port} AIOS_DATA_DIR=${tmp}/data AIOS_WORKSPACES_DIR=${tmp}/ws AIOS_AGENTS_DIR=${tmp}/agents npx tsx src/main.ts`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
