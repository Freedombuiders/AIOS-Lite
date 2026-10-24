/**
 * fal.ai and Higgsfield as Integrations (Integrations page → "AI tạo ảnh & video").
 * KOL Studio reads the stored keys; agents do not call these services directly.
 *
 * The connection test never generates anything: it asks each queue API for the
 * status of a request id that cannot exist. A rejected key answers 401/403; an
 * accepted key answers 404 (or another non-auth error). Neither call costs money.
 */

import type { IntegrationDefinition, IntegrationTestResult, IntegrationValues } from '../../../src/integrations/types.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const PROBE_ID = '00000000-0000-4000-8000-000000000000';

async function probe(url: string, authorization: string, signal: AbortSignal | undefined, fetchImpl: FetchLike): Promise<'accepted' | 'rejected' | 'unreachable' | { status: number }> {
  try {
    const timeout = AbortSignal.timeout(15_000);
    const res = await fetchImpl(url, { headers: { Authorization: authorization, Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (res.status === 401 || res.status === 403) return 'rejected';
    if (res.status === 404 || res.status === 400 || res.status === 422 || res.ok) return 'accepted';
    return { status: res.status };
  } catch {
    return 'unreachable';
  }
}

export async function testFal(values: IntegrationValues, signal?: AbortSignal, fetchImpl: FetchLike = fetch): Promise<IntegrationTestResult> {
  const key = values.api_key?.trim() ?? '';
  if (!key) return { ok: false, detail: 'Cần nhập API key của fal.ai.' };
  if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(key)) {
    return { ok: false, detail: 'API key fal.ai thường có dạng "<key id>:<key secret>" (có dấu hai chấm). Kiểm tra lại đã sao chép đủ chưa.' };
  }
  const r = await probe(`https://queue.fal.run/fal-ai/nano-banana/requests/${PROBE_ID}/status`, `Key ${key}`, signal, fetchImpl);
  if (r === 'rejected') return { ok: false, detail: 'fal.ai từ chối API key này. Tạo key mới ở fal.ai › Dashboard › Keys.' };
  if (r === 'unreachable') return { ok: false, detail: 'Không kết nối được fal.ai. Kiểm tra mạng rồi thử lại.' };
  if (r !== 'accepted') return { ok: false, detail: `fal.ai trả lỗi HTTP ${r.status}. Thử lại sau.` };
  return { ok: true, detail: 'fal.ai đã chấp nhận API key (kiểm tra bằng một lệnh đọc miễn phí, không tạo ảnh nào). Nhớ nạp tiền và đặt giới hạn chi tiêu trong tài khoản fal.', accountLabel: 'fal.ai' };
}

export async function testHiggsfield(values: IntegrationValues, signal?: AbortSignal, fetchImpl: FetchLike = fetch): Promise<IntegrationTestResult> {
  const id = values.key_id?.trim() ?? '';
  const secret = values.key_secret?.trim() ?? '';
  if (!id || !secret) return { ok: false, detail: 'Cần nhập cả Key ID và Key Secret của Higgsfield.' };
  if (/\s/.test(id) || /\s/.test(secret) || id.includes(':')) return { ok: false, detail: 'Key ID hoặc Key Secret có ký tự lạ. Sao chép lại từ trang API Keys của Higgsfield.' };
  const r = await probe(`https://api.higgsfield.ai/requests/${PROBE_ID}/status`, `Key ${id}:${secret}`, signal, fetchImpl);
  if (r === 'rejected') return { ok: false, detail: 'Higgsfield từ chối khóa này (sai Key ID/Secret hoặc khóa đã bị thu hồi).' };
  if (r === 'unreachable') return { ok: false, detail: 'Không kết nối được Higgsfield. Kiểm tra mạng rồi thử lại.' };
  if (r !== 'accepted') return { ok: false, detail: `Higgsfield trả lỗi HTTP ${r.status}. Thử lại sau.` };
  return {
    ok: true,
    detail: 'Higgsfield đã chấp nhận khóa (kiểm tra bằng một lệnh đọc miễn phí, không tạo ảnh nào). Higgsfield chưa công bố giá theo model: nhập giá ở KOL Studio › Cài đặt trước khi dùng.',
    accountLabel: 'Higgsfield',
  };
}

export const falIntegration: IntegrationDefinition = {
  id: 'fal',
  name: 'fal.ai',
  category: 'AI tạo ảnh & video',
  description: 'Nền tảng chạy các model tạo ảnh và video hàng đầu (Nano Banana Pro, Seedream, Kling, Veo, Seedance, OmniHuman). KOL Studio dùng fal để tạo ảnh giữ nguyên khuôn mặt KOL, video từ ảnh và video nói chuyện khớp khẩu hình.',
  docsUrl: 'https://fal.ai/docs',
  authKind: 'api-key',
  setupSteps: [
    'Đăng nhập fal.ai, mở Dashboard › Keys và bấm "Add key" (quyền API).',
    'Sao chép cả key (dạng <key id>:<key secret>) ngay khi hiện ra: fal chỉ hiện một lần.',
    'Nạp tiền ở Dashboard › Billing và đặt giới hạn chi tiêu trong tài khoản fal.',
    'Dán key vào ô bên dưới rồi bấm Lưu & kiểm tra. Mỗi ảnh/video KOL Studio tạo đều được báo giá trước và tính vào hạn mức của KOL Studio.',
  ],
  fields: [
    { key: 'api_key', label: 'API key fal.ai', kind: 'secret', required: true, placeholder: 'xxxxxxxx-xxxx-…:xxxxxxxx…', help: 'fal.ai › Dashboard › Keys.' },
  ],
  test: (values, signal) => testFal(values, signal),
  commands: [],
  agentGuide: 'fal.ai hosts image and video generation models used by KOL Studio. Agents do not call it directly; request media through KOL Studio (kol-cli) so spend caps and identity checks apply.',
};

export const higgsfieldIntegration: IntegrationDefinition = {
  id: 'higgsfield',
  name: 'Higgsfield',
  category: 'AI tạo ảnh & video',
  description: 'Nền tảng AI tạo ảnh và video (Marketing Studio, Kling 3.0, Seedance 2.0). KOL Studio dùng Higgsfield làm nguồn tạo ảnh từ nhiều ảnh tham chiếu và video từ ảnh.',
  docsUrl: 'https://docs.higgsfield.ai',
  authKind: 'api-key',
  setupSteps: [
    'Đăng nhập cloud.higgsfield.ai, mở mục API Keys và tạo khóa mới.',
    'Sao chép "Key ID" và "Key Secret" (Secret chỉ hiện một lần).',
    'Dán vào hai ô bên dưới rồi bấm Lưu & kiểm tra.',
    'Higgsfield tính bằng credit và chưa công bố giá theo từng model: vào KOL Studio › Cài đặt › Giá ghi đè, nhập giá USD mỗi ảnh hoặc mỗi giây video cho model bạn dùng. Chưa có giá thì KOL Studio không gửi yêu cầu.',
  ],
  fields: [
    { key: 'key_id', label: 'Key ID', kind: 'secret', required: true, help: 'Higgsfield › API Keys › Key ID.' },
    { key: 'key_secret', label: 'Key Secret', kind: 'secret', required: true, help: 'Higgsfield › API Keys › Key Secret.' },
  ],
  test: (values, signal) => testHiggsfield(values, signal),
  commands: [],
  agentGuide: 'Higgsfield hosts image and video models used by KOL Studio. Agents do not call it directly; request media through KOL Studio (kol-cli) so spend caps and identity checks apply.',
};
