// Fake GenBot Bot API for adapter tests: `POST /hooks/api/bots/<id>/messages` and `GET …/messages?thread=<id>`.
// Behaviour comes from the `scenario` option, or env FAKE_GENBOT_SCENARIO when run directly
// (`node fake-genbot.mjs` prints `LISTENING <port>`). Every request is recorded (method, path, headers, body).
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const FAKE_GENBOT_KEY = 'gbk_test_secret_value_0123456789';

/**
 * Scenarios:
 *  ok            200 {reply, thread}
 *  working       202 working, then GET answers 202 working `workingPolls` times and 200 after
 *  working-forever  202 working on POST and on every GET
 *  approval      202 needs_approval
 *  empty         200 with an empty reply
 *  working-empty 202 working, then GET answers 200 with an empty reply (a turn that failed after the 202)
 *  working-gone  202 working, then GET answers 404 (thread gone)
 *  redirect      302 to another host (the client must not follow)
 *  slow:<ms>     200 after <ms> milliseconds
 *  status:<n>    answers HTTP <n> with {error}
 *  hang          never answers (until the client goes away)
 */
export async function startFakeGenbot({ scenario = process.env.FAKE_GENBOT_SCENARIO ?? 'ok', key = process.env.FAKE_GENBOT_KEY ?? FAKE_GENBOT_KEY, workingPolls = 1, reply = 'Dạ, shop chào chị ạ.' } = {}) {
  const requests = [];
  /** requests whose connection closed before the server answered */
  const aborted = [];
  const polls = new Map();
  let threads = 0;
  /** POSTs being answered right now, and the most seen at once */
  let open = 0;
  const stats = { maxOpen: 0 };

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url ?? '/', 'http://fake');
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
    requests.push(entry);
    const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };

    const m = /^\/hooks\/api\/bots\/([\w-]{1,128})\/messages$/.exec(url.pathname);
    if (!m) return send(404, { error: 'not found' });
    if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: 'Invalid key' });

    if (req.method === 'GET') {
      const thread = url.searchParams.get('thread') ?? '';
      if (!polls.has(thread)) return send(404, { error: 'no such thread' });
      const n = polls.get(thread) + 1;
      polls.set(thread, n);
      if (scenario === 'working-forever' || n <= workingPolls) return send(202, { thread, status: 'working' });
      if (scenario === 'working-gone') return send(404, { error: 'no such thread' });
      if (scenario === 'working-empty') return send(200, { reply: '', thread });
      return send(200, { reply, thread });
    }
    if (req.method !== 'POST') return send(405, { error: 'The Bot API takes POST and GET' });

    const thread = `t${++threads}`;
    if (scenario.startsWith('status:')) {
      const status = Number(scenario.slice(7));
      return send(status, { error: `fake error ${status}` });
    }
    if (scenario === 'hang') {
      res.on('close', () => { if (!res.writableEnded) aborted.push(entry); });
      return;
    }
    if (scenario === 'approval') return send(202, { thread, status: 'needs_approval' });
    if (scenario === 'empty') return send(200, { reply: '', thread });
    if (scenario === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.2:9/hooks/api/bots/x/messages' }); return res.end(); }
    if (scenario.startsWith('slow:')) {
      open += 1;
      stats.maxOpen = Math.max(stats.maxOpen, open);
      await new Promise((r) => setTimeout(r, Number(scenario.slice(5))));
      open -= 1;
      return send(200, { reply, thread });
    }
    if (scenario === 'working' || scenario.startsWith('working-')) {
      polls.set(thread, 0);
      return send(202, { thread, status: 'working' });
    }
    return send(200, { reply, thread });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    aborted,
    stats,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = await startFakeGenbot();
  process.stdout.write(`LISTENING ${fake.port}\n`);
}
