// E2E launcher for the T07 inbox scenario (e2e/care-inbox.spec.ts).
//
// Boots the real app (src/main.ts startApp: same routes, same module host, same UI bundle) and then wires, from the
// outside, exactly what a channel module does: a FakeCareConnector registered through `provides.careChannels`, one
// Zalo-like account, a draft-mode rule for a bot on the `mock` runtime. A small control server on its own port lets the
// test play the customer ("a message arrives") and read what the fake provider was asked to send. Nothing here is part
// of the product: no production file knows about it, and nothing leaves the machine.

import http from 'node:http';
import { startApp } from '../../src/main.js';
import { FakeCareConnector } from '../../modules/care/server/connectors/fake-connector.js';
import { chatMessage } from '../../modules/care/server/test-fixtures.js';

const port = Number(process.env.AIOS_PORT ?? 4398);
const controlPort = Number(process.env.CARE_E2E_CONTROL_PORT ?? port + 1);
const base = `http://127.0.0.1:${port}`;

interface CareChannelsApi {
  register(c: FakeCareConnector): void;
  ensureAccount(a: { id: string; channel: 'zalo'; connectorKind: string; label: string }): { id: string };
  ingest(e: unknown): Promise<{ outcome: string }>;
}

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json().catch(() => ({}))) as T;
}

const { deps } = await startApp();

// The bot: an agent on the mock runtime with the care scope reply.draft (a message containing "#json" makes the mock
// runtime answer with the JSON the care turn expects, so the whole path inbound -> run -> draft is the real one).
await call('POST', '/api/agents', {
  id: 'bot-cskh', name: 'Bot CSKH', runtime: 'mock', description: 'Bot e2e',
  access: { brain: {}, memory: { team: false, private: false }, skills: [], connections: {}, modules: { care: ['inbox.read', 'customers.read', 'reply.draft'] } },
});
await deps.modules.add('care', { installAgents: false });
await call('PUT', '/api/modules/care/settings', { autoDelaySeconds: 0, quietHoursStart: '00:00', quietHoursEnd: '00:00', turnDebounceSeconds: 0 });

const channels = deps.modules.provides<{ careChannels: CareChannelsApi }>('care')!.careChannels;
const connector = new FakeCareConnector('fake', 'zalo');
channels.register(connector);
const accountId = channels.ensureAccount({ id: 'zalo-e2e', channel: 'zalo', connectorKind: 'fake', label: 'Nick Trà Sen Việt' }).id;
await call('POST', '/api/m/care/assignments', { scope: 'account', accountId, mode: 'draft', agentId: 'bot-cskh', priority: 100 });

let seq = 0;
http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${controlPort}`);
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && url.pathname === '/state') return reply(200, { accountId, providerSendCount: connector.providerSendCount });
    if (req.method === 'POST' && url.pathname === '/inbound') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        void (async () => {
          const { text, key = 'peer:khach-lan', title = 'Chị Lan', kind = 'direct', direction = 'in', senderRole = direction === 'in' ? 'customer' : 'self' } = JSON.parse(raw || '{}') as {
            text: string; key?: string; title?: string; kind?: 'direct' | 'group'; direction?: 'in' | 'out'; senderRole?: 'customer' | 'self' | 'operator';
          };
          seq += 1;
          const message = chatMessage({ id: accountId, channel: 'zalo' }, {
            externalConversationKey: key, nativeMessageId: `e2e-${Date.now()}-${seq}`, text, sentAtMs: Date.now(), direction, senderRole, metadata: { type: 'chat', conversationKind: kind, title },
          });
          // the provider names the conversation (a real Zalo thread arrives with the customer's name)
          await channels.ingest({ type: 'conversation.updated', eventId: `ev-conv-${message.nativeMessageId}`, accountId, timestampMs: message.sentAtMs, externalConversationKey: key, title, kind });
          const out = await channels.ingest({ type: 'message.created', eventId: `ev-${message.nativeMessageId}`, accountId, timestampMs: message.sentAtMs, message });
          reply(200, out);
        })().catch((err) => reply(500, { error: String(err) }));
      });
      return;
    }
    reply(404, { error: 'not found' });
  })
  .listen(controlPort, '127.0.0.1', () => console.log(`care-fake control server on :${controlPort}`));
