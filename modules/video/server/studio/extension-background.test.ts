import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const file = path.resolve('../rocketflow-extension/rocketflow/background.js');
describe.skipIf(!fs.existsSync(file))('extension local app client', () => {
  it('connects without a key, waits for app readiness, prefers app commands, and reconnects', async () => {
    const settings = { mcpPorts: [17898, 17893], claudeclawPairingKey: 'obsolete-key' };
    const sockets: any[] = []; let alarm: any; let changed: any;
    class Socket {
      readyState = 1; sent: any[] = []; closed = false;
      onopen?: () => void; onclose?: () => void; onmessage?: (event: any) => Promise<void>;
      constructor(readonly url: string) { sockets.push(this); }
      send(raw: string) { this.sent.push(JSON.parse(raw)); }
      close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
    }
    const text = fs.readFileSync(file, 'utf8');
    vm.runInNewContext(text.slice(text.indexOf('const DEFAULT_MCP_PORTS'), text.indexOf('// ---- Đổi tên file')), {
      WebSocket: Socket,
      chrome: { storage: { local: { get: async () => ({ rf_settings: settings }) }, onChanged: { addListener: (fn: any) => { changed = fn; } } },
        runtime: { id: 'a'.repeat(32), getManifest: () => ({ version: 'test' }) },
        alarms: { create: vi.fn(), onAlarm: { addListener: (fn: any) => { alarm = fn; } } } },
      setTimeout: vi.fn(), checkExpiry: () => ({ ok: true }), isExpired: () => false,
    });
    alarm({ name: 'rf-mcp' }); await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const app = sockets[0]; const legacy = sockets[1]; app.onopen(); legacy.onopen();
    expect(app.url).toBe('ws://127.0.0.1:17898/rocketflow');
    expect(app.sent[0]).toEqual({ type: 'hello', version: 'test', extId: 'a'.repeat(32) });
    const ping = { data: JSON.stringify({ type: 'cmd', id: 1, cmd: 'ping' }) };
    await app.onmessage(ping); expect(app.sent).toHaveLength(1);
    await app.onmessage({ data: JSON.stringify({ type: 'app_ready', protocol: 1 }) });
    await app.onmessage(ping); expect(app.sent[1]).toMatchObject({ type: 'result', id: 1, ok: true });
    await legacy.onmessage(ping); expect(legacy.sent).toHaveLength(1);
    changed({ rf_settings: { oldValue: settings, newValue: { ...settings, unrelated: true } } }, 'local'); expect(app.closed).toBe(false);
    app.close(); await legacy.onmessage(ping); expect(legacy.sent[1]).toMatchObject({ type: 'result' });
    alarm({ name: 'rf-mcp' }); await vi.waitFor(() => expect(sockets).toHaveLength(3));
  });
});
