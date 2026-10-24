/**
 * The comment-reply pipeline as pure functions: spam → complaint → template →
 * agent → skip. The worker and POST /comments/test both call
 * runPipeline(), so what the test box says is exactly what the worker does.
 *
 * Text handling: lowercase and strip punctuation/symbols/emoji, but KEEP
 * Vietnamese diacritics ("giá" never matches "gia" or "giám đốc"). Keyword
 * "contains" matches whole words/phrases, not substrings.
 */

import type { ReplyRuleConfig, ReplyTemplateDto, RuleTestResult } from '../types.js';

// ── Text normalisation ───────────────────────────────────────────────

/** Lowercase, NFC, punctuation/symbols/emoji → space, collapsed whitespace. Diacritics are kept. */
export function normalizeText(text: string): string {
  return (text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whitespace tokens of the normalised text. */
export function countWords(text: string): number {
  const norm = normalizeText(text);
  return norm ? norm.split(' ').length : 0;
}

export function hasQuestionMark(text: string): boolean {
  return /[?？]/.test(text ?? '');
}

/** `keyword` appears in `normText` as a whole word or phrase. Both sides are normalised the same way. */
export function containsPhrase(normText: string, keyword: string): boolean {
  const kw = normalizeText(keyword);
  if (!kw) return false;
  return ` ${normText} `.includes(` ${kw} `);
}

/** The whole comment equals the keyword after normalisation. */
export function equalsPhrase(normText: string, keyword: string): boolean {
  const kw = normalizeText(keyword);
  return kw !== '' && normText === kw;
}

export function matchesKeyword(normText: string, keyword: string, mode: 'exact' | 'contains'): boolean {
  return mode === 'exact' ? equalsPhrase(normText, keyword) : containsPhrase(normText, keyword);
}

/** First keyword of `keywords` that `contains`-matches the comment, or null. */
export function findKeyword(normText: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    if (containsPhrase(normText, kw)) return kw.trim();
  }
  return null;
}

const URL_RE = /(?:https?:\/\/|www\.)\S+/i;
const BARE_DOMAIN_RE = /(?<![\p{L}\p{N}@.])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|vn|info|xyz|io|me|ly|link|click|top|shop|site|online|cc|tk|biz|store|co)(?![\p{L}\p{N}])/iu;

/** A link in the raw comment: scheme/www URLs and bare domains such as `abc.shop/x` or `zalo.me/123`. */
export function hasUrl(text: string): boolean {
  const t = text ?? '';
  return URL_RE.test(t) || BARE_DOMAIN_RE.test(t);
}

/** URLs in `text` that do not occur (case-insensitive, without trailing punctuation) in `known`. */
export function findUnknownUrls(text: string, known: string): string[] {
  const knownLower = (known ?? '').toLowerCase();
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (!knownLower.includes(url.toLowerCase())) out.push(url);
  }
  return out;
}

// ── Names and template text ──────────────────────────────────────────

const VN_SURNAMES = new Set([
  'nguyen', 'tran', 'le', 'pham', 'hoang', 'huynh', 'phan', 'vu', 'vo', 'dang', 'bui', 'do', 'ho', 'ngo',
  'duong', 'ly', 'trinh', 'dinh', 'lam', 'mai', 'ta', 'ha', 'truong', 'luong', 'doan', 'cao',
]);

function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

const VN_DIACRITICS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

/**
 * The name to greet a commenter with. Vietnamese names put the given name
 * last ("Nguyễn Văn An" → "An", "Quốc Bảo" → "Bảo"); other names put it first
 * ("John Smith" → "John"). A name counts as Vietnamese when it has Vietnamese
 * diacritics or starts with a common surname.
 */
export function givenName(authorName: string): string {
  const parts = (authorName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const vietnamese = VN_DIACRITICS.test(authorName) || VN_SURNAMES.has(fold(parts[0]));
  return vietnamese ? parts[parts.length - 1] : parts[0];
}

/** Replaces `{ten}` with the commenter's given name ("bạn" when unknown). */
export function renderTemplateText(text: string, authorName: string): string {
  const name = givenName(authorName) || 'bạn';
  return (text ?? '').replace(/\{\s*ten\s*\}/gi, name);
}

/** Variant for the `uses`-th use of a template, rotating through the non-empty variants. */
export function pickVariant(variants: string[], uses: number): string {
  const clean = variants.map((v) => v.trim()).filter(Boolean);
  if (clean.length === 0) return '';
  return clean[((uses % clean.length) + clean.length) % clean.length];
}

// ── Pipeline ─────────────────────────────────────────────────────────

export type PipelineOutcome =
  | { step: 'spam'; reason: string; matched: string }
  | { step: 'complaint'; reason: string; matched: string }
  | { step: 'template'; template: ReplyTemplateDto; replyText: string; privateText: string; reason: string }
  | { step: 'agent'; reason: string }
  | { step: 'skip'; reason: string };

export interface PipelineInput {
  text: string;
  authorName: string;
  rules: ReplyRuleConfig;
  /** Every template of the Page; scope and enabled flags are applied here. */
  templates: ReplyTemplateDto[];
  /** The post the comment is on; selects post-scope templates. */
  postId: string | null;
}

/** Enabled templates that apply to `postId`, in evaluation order: post scope first, then Page scope, each by `sort`. */
export function orderedTemplates(templates: ReplyTemplateDto[], postId: string | null): ReplyTemplateDto[] {
  const usable = templates.filter((t) => t.enabled && (t.variants.some((v) => v.trim()) || t.privateText.trim()));
  const bySort = (a: ReplyTemplateDto, b: ReplyTemplateDto) => a.sort - b.sort || a.id - b.id;
  const post = postId ? usable.filter((t) => t.postId === postId).sort(bySort) : [];
  const page = usable.filter((t) => t.postId == null).sort(bySort);
  return [...post, ...page];
}

export function findTemplate(
  normText: string,
  templates: ReplyTemplateDto[],
  postId: string | null,
): ReplyTemplateDto | null {
  for (const t of orderedTemplates(templates, postId)) {
    if (t.keywords.some((kw) => matchesKeyword(normText, kw, t.matchMode))) return t;
  }
  return null;
}

export function runPipeline(input: PipelineInput): PipelineOutcome {
  const { text, rules } = input;
  const norm = normalizeText(text);
  const words = countWords(text);

  if (rules.hideLinks && hasUrl(text)) {
    return { step: 'spam', reason: 'Bình luận có liên kết', matched: 'link' };
  }
  const spam = findKeyword(norm, rules.spamKeywords);
  if (spam) return { step: 'spam', reason: `Chứa từ khóa spam "${spam}"`, matched: spam };

  const complaint = findKeyword(norm, rules.complaintKeywords);
  if (complaint) return { step: 'complaint', reason: `Chứa từ khóa cần người xử lý "${complaint}"`, matched: complaint };

  const template = findTemplate(norm, input.templates, input.postId);
  if (template) {
    return {
      step: 'template',
      template,
      replyText: renderTemplateText(pickVariant(template.variants, template.uses), input.authorName),
      privateText: renderTemplateText(template.privateText, input.authorName),
      reason: `Khớp mẫu "${template.name}"`,
    };
  }

  if (words === 0) return { step: 'skip', reason: 'Bình luận không có chữ' };
  const question = rules.questionMark && hasQuestionMark(text);
  if (words >= rules.minWords || question) {
    return {
      step: 'agent',
      reason: `${words} từ${hasQuestionMark(text) ? ', có dấu hỏi' : ''}`,
    };
  }
  return {
    step: 'skip',
    reason: `${words} từ, không khớp mẫu, chưa đủ ${rules.minWords} từ${rules.questionMark ? ' và không có dấu hỏi' : ''}`,
  };
}

/** The human label shown in the log's "Luật" column. */
export function ruleLabel(step: string, ruleRef: string, templateName: string | null): string {
  switch (step) {
    case 'spam': return 'Lọc spam';
    case 'complaint': return 'Chuyển người';
    case 'template': return templateName ? `Mẫu "${templateName}"` : 'Mẫu đã xoá';
    case 'agent': return `Agent ${ruleRef.startsWith('agent:') ? ruleRef.slice(6) : ruleRef || 'main'}`.trim();
    case 'skip': return 'Bỏ qua';
    default: return '';
  }
}

/** Test-box answer for an outcome, in the wording of the design ("Bước 3 · Mẫu …"). */
export function describeOutcome(outcome: PipelineOutcome, ctx: { text: string; rules: ReplyRuleConfig }): RuleTestResult {
  const words = countWords(ctx.text);
  switch (outcome.step) {
    case 'spam':
      return { step: 'spam', words, head: 'Bước 1 · Ẩn bình luận.', body: `${outcome.reason}, nên bị ẩn và không trả lời.` };
    case 'complaint':
      return {
        step: 'complaint', words, head: 'Bước 2 · Báo người.',
        body: `Câu chứa “${outcome.matched}”, không tự trả lời${ctx.rules.notify === 'none' ? '' : `, báo qua ${ctx.rules.notify === 'zalo' ? 'Zalo' : 'Telegram'}`}.`,
      };
    case 'template': {
      const parts = [];
      if (outcome.replyText) parts.push(`Trả lời: ${outcome.replyText}`);
      if (outcome.privateText) parts.push(`Nhắn riêng: ${outcome.privateText}`);
      return {
        step: 'template', words, templateId: outcome.template.id,
        head: `Bước 3 · Mẫu “${outcome.template.name}”.`, body: parts.join(' · '),
      };
    }
    case 'agent':
      return {
        step: 'agent', words,
        head: `Bước 4 · Agent ${ctx.rules.agentId} trả lời.`,
        body: `${outcome.reason}. Agent đọc bài viết, giọng Page và FAQ rồi viết câu trả lời, gửi sau ${ctx.rules.delayMinMinutes}–${ctx.rules.delayMaxMinutes} phút.`,
      };
    default:
      return { step: 'skip', words, head: 'Bước 5 · Bỏ qua.', body: `${outcome.reason}.` };
  }
}
