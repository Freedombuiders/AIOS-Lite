/**
 * Message templates: `{variables}`, `{a|b}` and style-aware rendering.
 *
 * Syntax
 *   {name}          a variable (unknown variables are removed)
 *   {a|b|c}         spintax, one option picked at random; nesting is fine
 *                   ("{Chào {name}|Hi {name}}") and an empty option is allowed
 *   {{  }}          a literal "{" / "}" (outside a group)
 *
 * Zalo styles are ranges over the plain text, so rendering is done as a
 * rewrite described by pieces (copied text, replaced spans, deleted spans)
 * and the ranges are remapped through every piece. ZaloCRM shifted ranges
 * with a running offset and drifted after the first substitution.
 */

import { DEFAULT_TIMEZONE } from './marketing-deps.js';
import { remapStyles, trimRich, type RemapPiece, type ZaloStyle } from './rich-text.js';

export interface TemplateContent {
  text: string;
  styles: ZaloStyle[];
}

/** Variable values by name, without braces: { name: 'Lan', sale: 'Rocket Academy' }. */
export type TemplateVars = Record<string, string>;

export interface TemplateVariableInfo {
  name: string;
  description: string;
  example: string;
}

/** Variables the editor offers in "Chèn biến". */
export const TEMPLATE_VARIABLES: TemplateVariableInfo[] = [
  { name: 'name', description: 'Tên khách (chữ cuối của tên)', example: 'Lan' },
  { name: 'name_full', description: 'Tên khách đầy đủ', example: 'Nguyễn Thị Lan' },
  { name: 'name_first', description: 'Họ của khách (chữ đầu của tên)', example: 'Nguyễn' },
  { name: 'group', description: 'Tên nhóm (để trống với chat 1-1)', example: 'Nhóm khách VIP' },
  { name: 'sale', description: 'Tên nick Zalo đang gửi', example: 'Rocket Academy' },
  { name: 'date', description: 'Ngày hôm nay (dd/MM)', example: '09/09' },
  { name: 'weekday', description: 'Thứ trong tuần', example: 'Thứ Tư' },
  { name: 'gender', description: 'Cách xưng hô (mặc định "Anh/Chị")', example: 'Anh/Chị' },
  { name: 'age', description: 'Tuổi của khách (chỉ dùng cho mẫu chúc sinh nhật; trống nếu chưa biết năm sinh)', example: '30' },
];

const KNOWN_VARS = new Set(TEMPLATE_VARIABLES.map((v) => v.name));
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Index of the "}" closing the group opened at `open`, or -1 when unbalanced. */
function findGroupEnd(text: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Top-level "|" positions inside the group content [from, to). */
function splitOptions(text: string, from: number, to: number): Array<[number, number]> {
  const options: Array<[number, number]> = [];
  let depth = 0;
  let begin = from;
  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '|' && depth === 0) {
      options.push([begin, i]);
      begin = i + 1;
    }
  }
  options.push([begin, to]);
  return options;
}

/**
 * Render variables and spintax. Styles follow the rewritten text: a style
 * over a replaced `{var}` covers its value, one over a dropped spin option
 * or an unknown variable disappears, one over the chosen option stays.
 */
export function renderTemplate(content: TemplateContent, vars: TemplateVars, opts: { rng?: () => number } = {}): TemplateContent {
  const rng = opts.rng ?? Math.random;
  const src = content.text;
  const lookup = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  const pieces: RemapPiece[] = [];
  let out = '';

  const copy = (from: number, to: number) => {
    if (to <= from) return;
    // Merge with the previous copy so long plain runs stay one piece.
    const last = pieces[pieces.length - 1];
    if (last?.kind === 'copy' && last.oldEnd === from) {
      last.oldEnd = to;
      last.newLen = to - last.oldStart;
    } else {
      pieces.push({ kind: 'copy', oldStart: from, oldEnd: to, newStart: out.length, newLen: to - from });
    }
    out += src.slice(from, to);
  };
  const replace = (from: number, to: number, value: string) => {
    pieces.push({ kind: 'replace', oldStart: from, oldEnd: to, newStart: out.length, newLen: value.length });
    out += value;
  };

  const emit = (from: number, to: number) => {
    let plain = from;
    let i = from;
    while (i < to) {
      const ch = src[i];
      if ((ch === '{' || ch === '}') && src[i + 1] === ch) {
        copy(plain, i);
        replace(i, i + 2, ch);
        i += 2;
        plain = i;
      } else if (ch === '{') {
        const end = findGroupEnd(src, i, to);
        if (end === -1) { i++; continue; }
        copy(plain, i);
        const options = splitOptions(src, i + 1, end);
        if (options.length === 1 && VAR_NAME.test(src.slice(i + 1, end))) {
          replace(i, end + 1, lookup.get(src.slice(i + 1, end).toLowerCase()) ?? '');
        } else {
          const [from2, to2] = options[Math.min(options.length - 1, Math.floor(rng() * options.length))];
          // Everything but the chosen option is deleted (no piece), so only
          // styles over the chosen text survive.
          emit(from2, to2);
        }
        i = end + 1;
        plain = i;
      } else {
        i++;
      }
    }
    copy(plain, to);
  };

  emit(0, src.length);
  const styles = remapStyles(content.styles, pieces, out.length);
  return trimRich(out, styles);
}

/** Human-readable problems in a template; empty when it is clean. Never blocks saving. */
export function validateTemplate(text: string): string[] {
  const warnings: string[] = [];
  let depth = 0;
  let unbalanced = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === '{' || ch === '}') && text[i + 1] === ch && depth === 0) { i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (depth === 0) unbalanced = true;
      else depth--;
    }
  }
  if (depth > 0 || unbalanced) warnings.push('Dấu ngoặc { } chưa khớp cặp: phần không khớp sẽ được gửi nguyên văn.');

  const unknown = new Set<string>();
  let emptyOption = false;
  const scan = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const ch = text[i];
      if ((ch === '{' || ch === '}') && text[i + 1] === ch) { i += 2; continue; }
      if (ch !== '{') { i++; continue; }
      const end = findGroupEnd(text, i, to);
      if (end === -1) { i++; continue; }
      const options = splitOptions(text, i + 1, end);
      const inner = text.slice(i + 1, end);
      if (options.length === 1 && VAR_NAME.test(inner)) {
        if (!KNOWN_VARS.has(inner.toLowerCase())) unknown.add(inner);
      } else {
        for (const [a, b] of options) {
          if (text.slice(a, b).trim() === '') emptyOption = true;
          else scan(a, b);
        }
      }
      i = end + 1;
    }
  };
  scan(0, text.length);
  if (unknown.size > 0) {
    warnings.push(`Biến không có trong danh sách sẽ bị bỏ trống: ${[...unknown].map((v) => `{${v}}`).join(', ')}.`);
  }
  if (emptyOption) warnings.push('Có phương án rỗng trong {a|b}: đôi khi tin sẽ bị cụt phần đó. Bỏ qua nếu bạn cố ý.');
  return warnings;
}

const WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

/** Built from parts: the vi-VN locale's own layout varies across ICU builds. */
function zonedDayParts(now: Date, timeZone: string): { day: string; month: string; weekday: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { day: p.day, month: p.month, weekday: WEEKDAYS[index < 0 ? 0 : index] };
}

/** Standard variables for a thread. */
export function buildTemplateVars(input: {
  threadName: string;
  threadType: 'user' | 'group';
  accountName: string;
  now?: Date;
  /** IANA zone for {date}/{weekday}; defaults to Asia/Ho_Chi_Minh. */
  timezone?: string;
  /** "Anh", "Chị"... Defaults to the neutral "Anh/Chị". */
  gender?: string;
}): TemplateVars {
  const parts = input.threadName.trim().split(/\s+/).filter(Boolean);
  let day: ReturnType<typeof zonedDayParts>;
  try {
    day = zonedDayParts(input.now ?? new Date(), input.timezone || DEFAULT_TIMEZONE);
  } catch {
    // A bad timezone string in settings must not stop a send.
    day = zonedDayParts(input.now ?? new Date(), DEFAULT_TIMEZONE);
  }
  return {
    name: parts[parts.length - 1] ?? '',
    name_full: input.threadName.trim(),
    name_first: parts[0] ?? '',
    group: input.threadType === 'group' ? input.threadName : '',
    sale: input.accountName,
    date: `${day.day}/${day.month}`,
    weekday: day.weekday,
    gender: input.gender?.trim() || 'Anh/Chị',
  };
}
