/** Apify: the scraping platform behind Radar's Facebook, Ad Library, TikTok, Threads and Instagram sources. */

import type { IntegrationDefinition, IntegrationTestResult, IntegrationValues } from '../../../src/integrations/types.js';

const FIELDS = ['api_token', 'api_token_2', 'api_token_3'] as const;

const usd = (n: number) => `$${n.toFixed(2).replace('.', ',')}`;

/** One token: account name and this month's usage, or why Apify refused it. Never throws, never echoes the token. */
async function checkToken(token: string, signal: AbortSignal | undefined, fetchImpl: typeof fetch): Promise<{ ok: boolean; username?: string; line: string }> {
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const res = await fetchImpl('https://api.apify.com/v2/users/me', { headers, signal });
    if (res.status === 401 || res.status === 403) return { ok: false, line: 'token bị từ chối' };
    if (!res.ok) return { ok: false, line: `lỗi HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { username?: string } };
    const username = body.data?.username?.trim() || 'Apify';
    let usage = '';
    try {
      const lr = await fetchImpl('https://api.apify.com/v2/users/me/limits', { headers, signal });
      if (lr.ok) {
        const d = ((await lr.json()) as { data?: { limits?: { maxMonthlyUsageUsd?: number }; current?: { monthlyUsageUsd?: number } } }).data;
        const used = d?.current?.monthlyUsageUsd;
        const max = d?.limits?.maxMonthlyUsageUsd;
        if (typeof used === 'number' && typeof max === 'number') usage = `, tháng này đã dùng ${usd(used)}/${usd(max)}`;
      }
    } catch { /* usage is a nice-to-have */ }
    return { ok: true, username, line: `${username}${usage}` };
  } catch {
    // Never echo the error: it could carry request details.
    return { ok: false, line: 'không kết nối được' };
  }
}

export async function testApify(values: IntegrationValues, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<IntegrationTestResult> {
  const keys = FIELDS.map((k, i) => ({ n: i + 1, token: values[k]?.trim() ?? '' })).filter((k) => k.token);
  if (keys.length === 0) return { ok: false, detail: 'Cần nhập ít nhất một Personal API token của Apify.' };
  const results = await Promise.all(keys.map(async (k) => ({ n: k.n, ...(await checkToken(k.token, signal, fetchImpl)) })));
  const good = results.filter((r) => r.ok);
  const lines = results.map((r) => `Key ${r.n}: ${r.line}`).join('; ');
  if (good.length === 0) return { ok: false, detail: `Apify từ chối mọi token. ${lines}.` };
  const rotation = good.length > 1 ? ` Radar dùng lần lượt ${good.length} key và tự bỏ qua key hết hạn mức.` : '';
  return { ok: true, detail: `Đã kết nối Apify. ${lines}.${rotation}`, accountLabel: good.map((r) => r.username).join(', ') };
}

export const apifyIntegration: IntegrationDefinition = {
  id: 'apify',
  name: 'Apify',
  category: 'Dữ liệu & nghiên cứu',
  description: 'Nền tảng thu thập dữ liệu. Radar dùng Apify để đọc nhóm và fanpage Facebook, Meta Ad Library, TikTok, Threads và Instagram.',
  docsUrl: 'https://docs.apify.com/api/v2',
  authKind: 'api-key',
  setupSteps: [
    'Đăng nhập console.apify.com, mở Settings › API & Integrations.',
    'Sao chép "Personal API token".',
    'Dán vào ô bên dưới rồi bấm Lưu & kiểm tra. Apify tính tiền theo kết quả, khoảng 2–6 USD cho mỗi 1.000 kết quả, nên đặt giới hạn chi tiêu trong tài khoản Apify.',
    'Có nhiều tài khoản Apify: dán token của từng tài khoản vào ô 2 và 3. Radar dùng lần lượt từng key, key nào hết tiền hoặc chạm giới hạn thì tạm nghỉ 6 giờ và chuyển sang key sau.',
  ],
  fields: [
    { key: 'api_token', label: 'Apify token 1', kind: 'secret', required: true, help: 'console.apify.com › Settings › API & Integrations › Personal API token.' },
    { key: 'api_token_2', label: 'Apify token 2 (tùy chọn)', kind: 'secret', required: false, help: 'Token của tài khoản Apify thứ hai.' },
    { key: 'api_token_3', label: 'Apify token 3 (tùy chọn)', kind: 'secret', required: false, help: 'Token của tài khoản Apify thứ ba.' },
  ],
  test: (values, signal) => testApify(values, signal),
  commands: [],
  agentGuide: 'Apify runs web scrapers for the Radar market-research scans. Agents do not call it directly; the Radar worker uses the stored token.',
};
