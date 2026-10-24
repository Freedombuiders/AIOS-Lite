/**
 * "Agent viết biến thể": ask an agent to rewrite a template into a
 * few natural variants. Identical text sent to many people is what Zalo's
 * spam heuristics look for, so varied wording protects the nick.
 *
 * Runs one lean agent turn through the engine (ctx.agents.runLean): permissions,
 * run records and cost accounting come from the core. The agent only returns
 * text; the operator picks what to keep.
 */

import type { LeanRunInput, LeanRunResult } from '../../../src/modules/sdk.js';

const MAX_VARIANT_CHARS = 4000;
const TURN_TIMEOUT_MS = 120_000;

export interface VariantsResult {
  variants: string[];
  error?: string;
}

export function buildVariantsPrompt(input: { text: string; count: number; instructions?: string }): string {
  const extra = input.instructions?.trim();
  return [
    'Bạn đang giúp soạn tin nhắn Zalo gửi hàng loạt cho khách. Cùng một nội dung gửi cho nhiều người dễ bị Zalo coi là spam, nên cần nhiều cách diễn đạt khác nhau.',
    `Viết lại tin nhắn gốc dưới đây thành ${input.count} biến thể khác nhau, mỗi bản đọc tự nhiên như người thật đang nhắn Zalo.`,
    [
      'Quy tắc bắt buộc:',
      '1. Giữ nguyên ý nghĩa và mọi thông tin của tin gốc. Không bịa thêm giá, khuyến mãi, thời hạn, link, số điện thoại hay cam kết nào không có trong tin gốc.',
      '2. Giữ nguyên các biến dạng {name}, {sale}, {gender}... đúng từng ký tự, và giữ nguyên cú pháp chọn ngẫu nhiên {a|b|c} nếu có. Không tự thêm biến mới.',
      '3. Mỗi biến thể khác nhau rõ rệt về cách mở đầu, thứ tự ý và từ ngữ, nhưng cùng giọng điệu với tin gốc. Giữ xuống dòng hợp lý.',
      '4. Nếu tin gốc có chỗ nhấn mạnh, có thể dùng **đậm**, *nghiêng*, __gạch chân__, ~~gạch ngang~~. Không dùng markdown nào khác (không tiêu đề, không bảng, không code).',
      '5. Không thêm lời giải thích, tiêu đề hay đánh số bên ngoài các biến thể.',
    ].join('\n'),
    extra ? `Yêu cầu thêm của người dùng:\n${extra}` : '',
    `Tin nhắn gốc:\n<<<\n${input.text}\n>>>`,
    `Chỉ trả về đúng MỘT mảng JSON gồm ${input.count} chuỗi, không kèm chữ nào khác. Ví dụ: ["biến thể 1", "biến thể 2"]`,
  ].filter(Boolean).join('\n\n');
}

function variableSet(text: string): Set<string> {
  return new Set([...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1].toLowerCase()));
}

/** Pull the list of strings out of whatever the model returned. */
export function parseVariants(raw: string): string[] {
  const candidates: string[] = [];
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  // Balanced scan for bare arrays/objects.
  for (let i = 0; i < raw.length; i++) {
    const open = raw[i];
    if (open !== '[' && open !== '{') continue;
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inStr = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        candidates.push(raw.slice(i, j + 1));
        break;
      }
    }
  }
  // Outermost, longest first: a variant containing "[...]" must not win over the array around it.
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c.trim());
      const arr = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { variants?: unknown }).variants)
          ? (parsed as { variants: unknown[] }).variants
          : null;
      if (!arr) continue;
      const strings = arr
        .map((v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string' ? (v as { text: string }).text : ''))
        .map((s) => s.trim())
        .filter(Boolean);
      if (strings.length > 0) return strings;
    } catch { /* not JSON */ }
  }
  return [];
}

/** Drop variants that lost a variable, repeat the original, or repeat each other. */
export function filterVariants(original: string, variants: string[], count: number): string[] {
  const needed = variableSet(original);
  const seen = new Set([original.trim()]);
  const out: string[] = [];
  for (const raw of variants) {
    const v = raw.slice(0, MAX_VARIANT_CHARS);
    if (seen.has(v)) continue;
    const have = variableSet(v);
    if (![...needed].every((name) => have.has(name))) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= count) break;
  }
  return out;
}

export type LeanRunner = (input: LeanRunInput) => Promise<LeanRunResult>;

/** One lean agent turn (no tools, text only) through ctx.agents.runLean; the operator picks what to keep. */
export async function generateTemplateVariants(
  input: { agentId: string; text: string; count: number; instructions?: string },
  runLean: LeanRunner,
): Promise<VariantsResult> {
  let result: LeanRunResult;
  try {
    result = await runLean({
      agentId: input.agentId,
      title: 'Viết biến thể mẫu tin Zalo',
      prompt: buildVariantsPrompt(input),
      timeoutMs: TURN_TIMEOUT_MS,
      meta: { module: 'zalo', kind: 'template-variants' },
    });
  } catch (err) {
    return { variants: [], error: String((err as Error)?.message ?? err) };
  }
  const variants = filterVariants(input.text, parseVariants(result.output), input.count);
  return { variants, ...(variants.length === 0 && result.error ? { error: result.error } : {}) };
}
