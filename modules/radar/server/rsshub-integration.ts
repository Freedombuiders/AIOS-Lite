/** RSSHub: the local feed bridge behind Radar's free Facebook, Instagram, Threads and TikTok reading. */

import type { IntegrationDefinition, IntegrationTestResult, IntegrationValues } from '../../../src/integrations/types.js';
import { DEFAULT_RSSHUB_URL, rsshubReachable } from './collectors/rsshub.js';

export async function testRsshub(values: IntegrationValues, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<IntegrationTestResult> {
  // An empty address means the default local container.
  const base = (values.base_url?.trim() || DEFAULT_RSSHUB_URL).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, detail: 'Địa chỉ RSSHub phải bắt đầu bằng http:// hoặc https://.' };
  return (await rsshubReachable(base, fetchImpl, signal))
    ? { ok: true, detail: `RSSHub đang chạy ở ${base}.`, accountLabel: base }
    : { ok: false, detail: `Không thấy RSSHub ở ${base}. Chạy \`docker start rsshub\` hoặc kiểm tra lại địa chỉ.` };
}

export const rsshubIntegration: IntegrationDefinition = {
  id: 'rsshub',
  name: 'RSSHub',
  category: 'Dữ liệu & nghiên cứu',
  description: 'Cầu nối nguồn cấp dữ liệu chạy trên máy bạn. Radar dùng RSSHub để đọc nhóm, fanpage Facebook, Instagram, Threads và TikTok mà không tốn tiền Apify.',
  docsUrl: 'https://docs.rsshub.app',
  authKind: 'api-key',
  setupSteps: [
    'Chạy RSSHub bằng Docker: `docker run -d --name rsshub --restart unless-stopped -p 127.0.0.1:1200:1200 diygod/rsshub`. Mặc định Radar tự tìm ở http://127.0.0.1:1200, không cần nhập gì thêm.',
    'Facebook, Instagram và X cần cookie đăng nhập. Đặt các biến môi trường FACEBOOK_COOKIE, INSTAGRAM_COOKIE, TWITTER_AUTH_TOKEN cho container RSSHub (không nhập vào app này), và dùng tài khoản phụ, không dùng tài khoản chính.',
    'RSSHub chạy ở máy khác hoặc có đặt mã truy cập (ACCESS_KEY)? Điền địa chỉ và mã vào các ô bên dưới, rồi bấm Lưu & kiểm tra.',
  ],
  fields: [
    { key: 'base_url', label: 'Địa chỉ RSSHub (tùy chọn)', kind: 'text', required: false, placeholder: DEFAULT_RSSHUB_URL, help: 'Để trống nếu RSSHub chạy ở mặc định http://127.0.0.1:1200.' },
    { key: 'access_key', label: 'Mã truy cập (tùy chọn)', kind: 'secret', required: false, help: 'Chỉ cần khi RSSHub đặt biến ACCESS_KEY.' },
  ],
  test: (values, signal) => testRsshub(values, signal),
  commands: [],
  agentGuide: 'RSSHub is a local feed bridge used by the Radar market-research scans. Agents do not call it directly; the Radar worker reads the stored address.',
};
