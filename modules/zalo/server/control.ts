/**
 * The loopback channel between the AIOS process (routes, care bridge) and the zalo daemon. Reads go straight to SQLite;
 * only actions that need the live zca-js session (QR login, reconnect, sync, care sends) go over HTTP.
 *
 * The supervisor generates a random token per daemon start and hands it to the child through its environment, so there is
 * no token file on disk. Port and token are module state set with configureZaloControl().
 */

export const ZALO_TOKEN_HEADER = 'x-zalo-token';
export const DEFAULT_ZALO_CONTROL_PORT = 4381;

export interface ZaloControlConfig {
  port: number;
  token: string;
}

let config: ZaloControlConfig | null = null;

export function configureZaloControl(next: ZaloControlConfig | null): void {
  config = next;
}

export function zaloControlConfig(): ZaloControlConfig | null {
  return config;
}

export class ZaloDaemonUnavailableError extends Error {
  constructor(message = 'Dịch vụ Zalo chưa chạy') {
    super(message);
    this.name = 'ZaloDaemonUnavailableError';
  }
}

export interface ControlResponse<T> {
  status: number;
  data: T;
}

export async function callZaloDaemon<T = unknown>(
  method: 'GET' | 'POST',
  route: string,
  opts: { body?: unknown; timeoutMs?: number } = {},
): Promise<ControlResponse<T>> {
  if (!config) throw new ZaloDaemonUnavailableError();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}${route}`, {
      method,
      headers: {
        [ZALO_TOKEN_HEADER]: config.token,
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: abort.signal,
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, data };
  } catch (err) {
    if (abort.signal.aborted) throw new ZaloDaemonUnavailableError('Dịch vụ Zalo không phản hồi');
    throw new ZaloDaemonUnavailableError(`Không kết nối được dịch vụ Zalo: ${String((err as Error)?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }
}
