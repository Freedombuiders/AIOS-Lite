/**
 * Pancake integration: Pancake POS (orders, customers, products, stock) and,
 * optionally, Pancake chat pages (Facebook / Zalo / Instagram conversations).
 */
import type {
  IntegrationDefinition,
  IntegrationTestResult,
  IntegrationValues,
} from '../types.js';
import { IntegrationApiError } from '../types.js';
import {
  createPancakePagesClient,
  createPancakePosClient,
  parsePageTokens,
  type FetchImpl,
} from './client.js';
import { buildPancakeCommands, pancakeCommands } from './commands.js';

export interface PancakeTestDeps {
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
}

function errorText(e: unknown): string {
  if (e instanceof IntegrationApiError) return e.message;
  // Never echo an unknown error: a fetch error can contain the request URL.
  return 'lỗi không xác định';
}

/** Checks the stored credentials with cheap read calls. Never throws. */
export async function testPancake(
  values: IntegrationValues, signal?: AbortSignal, deps: PancakeTestDeps = {},
): Promise<IntegrationTestResult> {
  const apiKey = values.pos_api_key?.trim() ?? '';
  const rawTokens = values.page_tokens ?? '';
  const pages = parsePageTokens(rawTokens);
  const http = { signal, fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl };

  if (!apiKey && pages.length === 0 && !rawTokens.trim()) {
    return { ok: false, detail: 'Cần nhập ít nhất API key Pancake POS hoặc Page access token.' };
  }
  const malformed = rawTokens.split(/[\s,;]+/).filter((p) => p && (p.indexOf(':') <= 0 || p.endsWith(':')));
  if (malformed.length > 0) {
    return {
      ok: false,
      detail: 'Page access token sai định dạng: mỗi page cần dạng page_id:token, cách nhau bằng dấu phẩy hoặc xuống dòng.',
    };
  }

  const parts: string[] = [];
  const labels: string[] = [];
  const discovered: IntegrationValues = {};

  try {
    if (apiKey) {
      const shops = await createPancakePosClient({ apiKey, ...http }).listShops();
      if (shops.length === 0) {
        return { ok: false, detail: 'API key hợp lệ nhưng không truy cập được shop nào trên Pancake POS.' };
      }
      const stored = values.shop_id?.trim();
      const storedShop = stored ? shops.find((s) => String(s.id) === stored) : undefined;
      const shop = storedShop ?? shops.find((s) => s.preferred_shop) ?? shops[0];
      discovered.shop_id = String(shop.id);
      labels.push(shop.name);
      parts.push(`Đã kết nối Pancake POS: shop ${shop.name} (id ${shop.id})`
        + (stored && !storedShop ? `. Shop ID đã nhập (${stored}) không thuộc API key này nên dùng shop này` : ''));
    }
  } catch (e) {
    return { ok: false, detail: `Không kết nối được. ${errorText(e)}` };
  }

  if (pages.length > 0) {
    const results = await Promise.all(pages.map(async ({ pageId, token }) => {
      try {
        await createPancakePagesClient({ pageId, pageAccessToken: token, ...http }).listTags();
        return null;
      } catch (e) {
        return e instanceof IntegrationApiError ? e.message : `page ${pageId}: lỗi không xác định`;
      }
    }));
    const failed = results.filter((r): r is string => r !== null);
    if (failed.length > 0) {
      return { ok: false, detail: `Không kết nối được Pancake chat. ${failed.join('; ')}. Kiểm tra lại page access token.` };
    }
    if (!apiKey) labels.push(`Page ${pages.map((p) => p.pageId).join(', ')}`);
    parts.push(apiKey
      ? `${pages.length} page chat`
      : `Đã kết nối Pancake chat: ${pages.length} page (${pages.map((p) => p.pageId).join(', ')})`);
  }

  return {
    ok: true,
    detail: parts.join(' · '),
    accountLabel: labels.join(', '),
    discovered: Object.keys(discovered).length ? discovered : undefined,
  };
}

export const pancakeIntegration: IntegrationDefinition = {
  id: 'pancake',
  name: 'Pancake',
  category: 'Bán hàng',
  description: 'Pancake POS: đơn hàng, khách hàng, sản phẩm và tồn kho. Tùy chọn thêm Pancake chat để đọc và trả lời hội thoại Facebook, Zalo, Instagram của page.',
  docsUrl: 'https://docs.pancake.biz',
  setupSteps: [
    'Mở Pancake POS, vào Cấu hình › Nâng cao › Kết nối bên thứ ba › Webhook/API.',
    'Ở mục API KEY bấm Tạo, sao chép key và dán vào ô "API key Pancake POS".',
    'Để trống Shop ID: hệ thống tự lấy shop đầu tiên mà API key truy cập được. Nếu có nhiều shop, nhập ID shop muốn dùng.',
    'Tùy chọn, để agent đọc và trả lời tin nhắn: trong Pancake mở Cài đặt trang › Công cụ, sao chép Page access token của từng page.',
    'Dán vào ô Page access token theo dạng page_id:token, mỗi page một dòng hoặc cách nhau bằng dấu phẩy. Không bấm tạo token mới nếu không cần: token mới làm token cũ hết hiệu lực.',
  ],
  fields: [
    {
      key: 'pos_api_key',
      label: 'API key Pancake POS',
      kind: 'secret',
      required: false,
      help: 'Pancake POS › Cấu hình › Nâng cao › Kết nối bên thứ ba › Webhook/API › API KEY › Tạo.',
    },
    {
      key: 'shop_id',
      label: 'Shop ID',
      kind: 'text',
      required: false,
      placeholder: 'Tự động',
      help: 'Để trống: tự lấy shop đầu tiên mà API key truy cập được.',
    },
    {
      key: 'page_tokens',
      label: 'Page access token (Pancake chat)',
      kind: 'secret',
      required: false,
      placeholder: 'page_id:token, page_id:token',
      help: 'Tùy chọn. Mỗi page một mục page_id:token, cách nhau bằng dấu phẩy, khoảng trắng hoặc xuống dòng. Lấy ở Pancake › Cài đặt trang › Công cụ.',
    },
  ],
  test: (values, signal) => testPancake(values, signal),
  commands: pancakeCommands,
  agentGuide: 'Pancake POS holds the shop\'s orders, customers, products and stock; Pancake chat holds the Facebook/Zalo/Instagram page conversations. Look a customer up by phone with `customers search` (chat has no phone search), then read their orders; an order\'s conversationId links to its chat conversation.',
};

export { buildPancakeCommands };
