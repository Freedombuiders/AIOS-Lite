import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// End-to-end: builds the web app, starts AIOS-Lite on a spare port with throw-away data/agents dirs,
// and drives the real UI. Only the `mock` runtime is used, so no CLI or API key is needed.
const port = Number(process.env.AIOS_E2E_PORT ?? 4399);
const tmp = path.join(os.tmpdir(), `aios-e2e-${port}`);
// T07: a second app on its own port and data dir, with a fake care connector (e2e/support/care-fake-server.ts).
// It reuses the web build the first server makes (both serve <root>/dist/web).
const carePort = Number(process.env.AIOS_CARE_E2E_PORT ?? 4398);
const careTmp = path.join(os.tmpdir(), `aios-e2e-care-${carePort}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 } },
  webServer: [
    {
      command: `rm -rf ${tmp} && mkdir -p ${tmp} && cp -R agents ${tmp}/agents && npx vite build && AIOS_MOCK=1 AIOS_PORT=${port} AIOS_DATA_DIR=${tmp}/data AIOS_WORKSPACES_DIR=${tmp}/ws AIOS_AGENTS_DIR=${tmp}/agents npx tsx src/main.ts`,
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `rm -rf ${careTmp} && mkdir -p ${careTmp} && cp -R agents ${careTmp}/agents && AIOS_MOCK=1 AIOS_PORT=${carePort} CARE_E2E_CONTROL_PORT=${carePort + 1} AIOS_DATA_DIR=${careTmp}/data AIOS_WORKSPACES_DIR=${careTmp}/ws AIOS_AGENTS_DIR=${careTmp}/agents npx tsx e2e/support/care-fake-server.ts`,
      url: `http://127.0.0.1:${carePort}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
