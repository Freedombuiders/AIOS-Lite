import { describe, expect, it } from 'vitest';

import { DEFAULT_REPLY_RULES, type ReplyRuleConfig, type ReplyTemplateDto } from '../types.js';
import {
  containsPhrase,
  countWords,
  describeOutcome,
  equalsPhrase,
  findTemplate,
  findUnknownUrls,
  givenName,
  hasQuestionMark,
  hasUrl,
  matchesKeyword,
  normalizeText,
  orderedTemplates,
  pickVariant,
  renderTemplateText,
  ruleLabel,
  runPipeline,
} from './rules.js';

const rules = (patch: Partial<ReplyRuleConfig> = {}): ReplyRuleConfig => ({ ...DEFAULT_REPLY_RULES, ...patch });

let nextId = 1;
function tpl(patch: Partial<ReplyTemplateDto> = {}): ReplyTemplateDto {
  return {
    id: nextId++, pageId: 'p1', postId: null, name: 'Mẫu', keywords: [], matchMode: 'contains',
    variants: ['Cảm ơn bạn'], privateText: '', enabled: true, sort: 0, uses: 0, ...patch,
  };
}

function run(text: string, opts: { rules?: Partial<ReplyRuleConfig>; templates?: ReplyTemplateDto[]; postId?: string | null; name?: string } = {}) {
  return runPipeline({
    text, authorName: opts.name ?? 'An', rules: rules(opts.rules), templates: opts.templates ?? [], postId: opts.postId ?? null,
  });
}

describe('normalizeText', () => {
  it('lowercases, strips punctuation, symbols and emoji, and collapses whitespace', () => {
    expect(normalizeText('  Giá   bao nhiêu???  ')).toBe('giá bao nhiêu');
    expect(normalizeText('AI.')).toBe('ai');
    expect(normalizeText('Cho mình xin giá 😍🔥!!')).toBe('cho mình xin giá');
    expect(normalizeText('triệu/ngày')).toBe('triệu ngày');
  });

  it('keeps Vietnamese diacritics', () => {
    expect(normalizeText('ĐƯỢC không Ạ')).toBe('được không ạ');
  });

  it('composes decomposed diacritics so both spellings compare equal', () => {
    const decomposed = 'giá'; // "giá" typed as a + combining acute
    expect(normalizeText(decomposed)).toBe('giá');
    expect(normalizeText(decomposed)).toBe(normalizeText('giá'));
  });

  it('returns an empty string for punctuation-only or empty text', () => {
    expect(normalizeText('?!?')).toBe('');
    expect(normalizeText('')).toBe('');
  });
});

describe('countWords', () => {
  it('counts whitespace tokens after normalisation', () => {
    expect(countWords('Khóa này dùng cho ngành spa được không ạ?')).toBe(9);
    expect(countWords('  một   hai  ba ')).toBe(3);
  });

  it('ignores punctuation-only tokens and emoji', () => {
    expect(countWords('ok ... !!! 😍')).toBe(1);
    expect(countWords('😍😍')).toBe(0);
    expect(countWords('')).toBe(0);
  });
});

describe('keyword matching', () => {
  it('contains matches whole words and phrases, not substrings', () => {
    const n = normalizeText('Anh giám đốc cho hỏi');
    expect(containsPhrase(n, 'giá')).toBe(false);
    expect(containsPhrase(normalizeText('cho mình xin giá nhé'), 'giá')).toBe(true);
    expect(containsPhrase(normalizeText('Xin báo giá chi tiết'), 'báo giá')).toBe(true);
    expect(containsPhrase(normalizeText('giá'), 'giá')).toBe(true);
  });

  it('does not match a keyword that is a prefix or suffix of a longer word', () => {
    expect(containsPhrase(normalizeText('khóa học online'), 'học')).toBe(true);
    expect(containsPhrase(normalizeText('học viên'), 'viên học')).toBe(false);
    expect(containsPhrase(normalizeText('hocvien'), 'học')).toBe(false);
    expect(containsPhrase(normalizeText('ai cũng được'), 'ai cũng')).toBe(true);
    expect(containsPhrase(normalizeText('khai'), 'ai')).toBe(false);
  });

  it('is diacritic sensitive', () => {
    expect(containsPhrase(normalizeText('cho xin gia'), 'giá')).toBe(false);
  });

  it('normalises keywords the same way as comments', () => {
    expect(containsPhrase(normalizeText('kiếm tiền online ở nhà'), '  Kiếm  Tiền ONLINE! ')).toBe(true);
    expect(containsPhrase(normalizeText('được 5 triệu/ngày'), 'triệu/ngày')).toBe(true);
  });

  it('an empty or punctuation-only keyword never matches', () => {
    expect(containsPhrase('anything', '')).toBe(false);
    expect(containsPhrase('anything', '  ?! ')).toBe(false);
    expect(equalsPhrase('', '')).toBe(false);
  });

  it('exact means the whole comment equals the keyword after normalisation', () => {
    expect(equalsPhrase(normalizeText('AI'), 'AI')).toBe(true);
    expect(equalsPhrase(normalizeText('ai.'), 'AI')).toBe(true);
    expect(equalsPhrase(normalizeText('  Ai!!! '), 'ai')).toBe(true);
    expect(equalsPhrase(normalizeText('ai là gì'), 'AI')).toBe(false);
    expect(equalsPhrase(normalizeText('cho mình ai'), 'ai')).toBe(false);
  });

  it('matchesKeyword dispatches on the mode', () => {
    const n = normalizeText('ai là gì');
    expect(matchesKeyword(n, 'ai', 'contains')).toBe(true);
    expect(matchesKeyword(n, 'ai', 'exact')).toBe(false);
  });
});

describe('hasUrl / hasQuestionMark / findUnknownUrls', () => {
  it('detects links in several forms', () => {
    expect(hasUrl('xem https://abc.com/x nhé')).toBe(true);
    expect(hasUrl('vào www.kiemtien.vn đi')).toBe(true);
    expect(hasUrl('liên hệ zalo.me/0900000000')).toBe(true);
    expect(hasUrl('ghé abc.shop/deal')).toBe(true);
  });

  it('does not flag ordinary Vietnamese text', () => {
    expect(hasUrl('Khóa này dùng cho ngành spa được không ạ?')).toBe(false);
    expect(hasUrl('Cảm ơn bạn. Mình quan tâm nhé')).toBe(false);
    expect(hasUrl('mail me@example.com')).toBe(false);
  });

  it('detects a question mark (also full-width)', () => {
    expect(hasQuestionMark('giá?')).toBe(true);
    expect(hasQuestionMark('giá？')).toBe(true);
    expect(hasQuestionMark('giá.')).toBe(false);
  });

  it('finds URLs in agent text that are not in the known context', () => {
    expect(findUnknownUrls('xem https://evil.example/a', 'tài liệu https://good.vn/b')).toEqual(['https://evil.example/a']);
    expect(findUnknownUrls('xem https://good.vn/b.', 'tài liệu https://good.vn/b')).toEqual([]);
    expect(findUnknownUrls('không có link', '')).toEqual([]);
  });
});

describe('names and template text', () => {
  it('greets Vietnamese names by the last word and other names by the first', () => {
    expect(givenName('Nguyễn Văn An')).toBe('An');
    expect(givenName('Quốc Bảo')).toBe('Bảo'); // diacritics → Vietnamese order
    expect(givenName('Nguyen Van An')).toBe('An'); // known surname
  });

  it('uses the first word for non-Vietnamese names and the only word for single names', () => {
    expect(givenName('John Smith')).toBe('John');
    expect(givenName('Linh')).toBe('Linh');
    expect(givenName('')).toBe('');
  });

  it('replaces {ten} (any spacing/case) and falls back to "bạn"', () => {
    expect(renderTemplateText('Chào {ten}, cảm ơn {Ten} nhé', 'Trần Minh Anh')).toBe('Chào Anh, cảm ơn Anh nhé');
    expect(renderTemplateText('Chào { ten }!', '')).toBe('Chào bạn!');
    expect(renderTemplateText('Không có biến', 'An')).toBe('Không có biến');
  });

  it('rotates variants by use count and skips blank ones', () => {
    const v = ['A', ' ', 'B', 'C'];
    expect([0, 1, 2, 3, 4].map((i) => pickVariant(v, i))).toEqual(['A', 'B', 'C', 'A', 'B']);
    expect(pickVariant([], 3)).toBe('');
    expect(pickVariant(['  '], 0)).toBe('');
  });
});

describe('template ordering and precedence', () => {
  it('post-scope templates win over page-scope, each by sort then id', () => {
    const pageFirst = tpl({ name: 'page-1', keywords: ['giá'], sort: 0 });
    const postLate = tpl({ name: 'post-9', keywords: ['giá'], postId: 'P', sort: 9 });
    const postEarly = tpl({ name: 'post-1', keywords: ['giá'], postId: 'P', sort: 1 });
    const names = orderedTemplates([pageFirst, postLate, postEarly], 'P').map((t) => t.name);
    expect(names).toEqual(['post-1', 'post-9', 'page-1']);
    expect(findTemplate('giá bao nhiêu', [pageFirst, postLate, postEarly], 'P')?.name).toBe('post-1');
  });

  it('ignores templates of other posts, disabled ones and ones with nothing to send', () => {
    const other = tpl({ name: 'other', keywords: ['giá'], postId: 'Q' });
    const off = tpl({ name: 'off', keywords: ['giá'], enabled: false });
    const empty = tpl({ name: 'empty', keywords: ['giá'], variants: [' '], privateText: '' });
    const ok = tpl({ name: 'ok', keywords: ['giá'], sort: 5 });
    expect(findTemplate('giá', [other, off, empty, ok], 'P')?.name).toBe('ok');
    expect(findTemplate('giá', [other, off, empty], 'P')).toBeNull();
  });

  it('page-scope templates apply to every post, post-scope only to their post', () => {
    const post = tpl({ name: 'post', keywords: ['học thử'], postId: 'P' });
    expect(findTemplate('cho học thử', [post], 'P')?.name).toBe('post');
    expect(findTemplate('cho học thử', [post], 'Q')).toBeNull();
    expect(findTemplate('cho học thử', [post], null)).toBeNull();
  });

  it('a private-text-only template is usable', () => {
    const t = tpl({ keywords: ['ai'], matchMode: 'exact', variants: [], privateText: 'Mình gửi bạn tài liệu' });
    const out = run('AI', { templates: [t] });
    expect(out.step).toBe('template');
    if (out.step === 'template') {
      expect(out.replyText).toBe('');
      expect(out.privateText).toBe('Mình gửi bạn tài liệu');
    }
  });
});

describe('runPipeline priority', () => {
  const template = tpl({ name: 'Giá', keywords: ['giá'], variants: ['Chào {ten}, nhắn tin Page nhé'], privateText: 'Bảng giá cho {ten}' });

  it('spam beats complaint, template and agent', () => {
    const out = run('lừa đảo, xem giá tại https://x.com', { templates: [template] });
    expect(out.step).toBe('spam');
  });

  it('complaint beats template and agent', () => {
    const out = run('Học xong lỗi hoài, giá thì cao', { templates: [template], rules: { complaintKeywords: ['lỗi'] } });
    expect(out.step).toBe('complaint');
  });

  it('template beats agent', () => {
    const out = run('Cho mình hỏi giá khóa này là bao nhiêu vậy ạ?', { templates: [template] });
    expect(out.step).toBe('template');
    if (out.step === 'template') {
      expect(out.replyText).toBe('Chào An, nhắn tin Page nhé');
      expect(out.privateText).toBe('Bảng giá cho An');
      expect(out.reason).toBe('Khớp mẫu "Giá"');
    }
  });

  it('agent when the comment is long enough', () => {
    const out = run('Khóa này dùng cho ngành spa được không bạn', { rules: { minWords: 6 } });
    expect(out.step).toBe('agent');
  });

  it('agent for a short question when questionMark is on', () => {
    expect(run('Giá?').step).toBe('agent');
    expect(run('Giá?', { rules: { questionMark: false } }).step).toBe('skip');
  });

  it('skip for a short comment without a question mark', () => {
    const out = run('Hay quá');
    expect(out.step).toBe('skip');
    if (out.step === 'skip') expect(out.reason).toContain('chưa đủ 6 từ');
  });

  it('the word threshold is inclusive', () => {
    expect(run('một hai ba bốn năm sáu').step).toBe('agent');
    expect(run('một hai ba bốn năm').step).toBe('skip');
  });

  it('empty or emoji-only comments are skipped even with a question mark threshold of 0', () => {
    const out = run('😍😍', { rules: { minWords: 0 } });
    expect(out.step).toBe('skip');
    if (out.step === 'skip') expect(out.reason).toBe('Bình luận không có chữ');
    expect(run('?').step).toBe('skip');
  });

  it('hideLinks off lets a link comment through to later steps', () => {
    expect(run('xem https://x.com đi', { rules: { hideLinks: false, minWords: 1 } }).step).toBe('agent');
    expect(run('xem https://x.com đi', { rules: { hideLinks: true } }).step).toBe('spam');
  });

  it('spam and complaint keywords match whole words only', () => {
    const r = { spamKeywords: ['giá'], complaintKeywords: [] as string[] };
    expect(run('anh giám đốc ơi', { rules: r }).step).not.toBe('spam');
    expect(run('xin giá nhé', { rules: r }).step).toBe('spam');
  });

  it('default spam keywords hide the examples from the design', () => {
    expect(run('Kiếm tiền online mỗi ngày nhé').step).toBe('spam');
    expect(run('Inbox mình để nhận quà').step).toBe('spam');
    expect(run('Làm được 5 triệu/ngày luôn').step).toBe('spam');
  });

  it('exact templates only fire on the whole comment', () => {
    const exact = tpl({ name: 'AI', keywords: ['AI'], matchMode: 'exact' });
    expect(run('AI', { templates: [exact] }).step).toBe('template');
    expect(run('ai.', { templates: [exact] }).step).toBe('template');
    expect(run('ai là gì vậy bạn ơi cho mình hỏi', { templates: [exact] }).step).toBe('agent');
  });

  it('a template reply rotates with the use count', () => {
    const t = tpl({ keywords: ['giá'], variants: ['một', 'hai'], uses: 1 });
    const out = run('giá', { templates: [t] });
    expect(out.step === 'template' && out.replyText).toBe('hai');
  });

  it('post-scope template precedence is applied inside the pipeline', () => {
    const pageT = tpl({ name: 'Page', keywords: ['giá'], variants: ['page'] });
    const postT = tpl({ name: 'Post', keywords: ['giá'], variants: ['post'], postId: 'P' });
    const out = run('giá', { templates: [pageT, postT], postId: 'P' });
    expect(out.step === 'template' && out.replyText).toBe('post');
    const other = run('giá', { templates: [pageT, postT], postId: 'Q' });
    expect(other.step === 'template' && other.replyText).toBe('page');
  });
});

describe('labels and test-box wording', () => {
  it('labels each step like the design', () => {
    expect(ruleLabel('spam', 'spam', null)).toBe('Lọc spam');
    expect(ruleLabel('complaint', 'complaint', null)).toBe('Chuyển người');
    expect(ruleLabel('template', 'template:3', 'AI')).toBe('Mẫu "AI"');
    expect(ruleLabel('template', 'template:3', null)).toBe('Mẫu đã xoá');
    expect(ruleLabel('agent', 'agent:main', null)).toBe('Agent main');
    expect(ruleLabel('skip', '', null)).toBe('Bỏ qua');
    expect(ruleLabel('', '', null)).toBe('');
  });

  it('describes outcomes with the step, head and body', () => {
    const r = rules();
    const spam = describeOutcome(run('http://x.com'), { text: 'http://x.com', rules: r });
    expect(spam).toMatchObject({ step: 'spam', head: 'Bước 1 · Ẩn bình luận.' });

    const complaint = describeOutcome(run('bị lỗi rồi'), { text: 'bị lỗi rồi', rules: r });
    expect(complaint.step).toBe('complaint');
    expect(complaint.body).toContain('Telegram');

    const t = tpl({ name: 'AI', keywords: ['ai'], matchMode: 'exact' });
    const template = describeOutcome(run('ai', { templates: [t] }), { text: 'ai', rules: r });
    expect(template).toMatchObject({ step: 'template', templateId: t.id, head: 'Bước 3 · Mẫu “AI”.' });

    const text = 'Khóa này dùng cho ngành spa được không ạ?';
    const agent = describeOutcome(run(text), { text, rules: r });
    expect(agent.step).toBe('agent');
    expect(agent.head).toBe('Bước 4 · Agent content-fb trả lời.');
    expect(agent.words).toBe(9);

    const skip = describeOutcome(run('Hay quá'), { text: 'Hay quá', rules: r });
    expect(skip).toMatchObject({ step: 'skip', head: 'Bước 5 · Bỏ qua.' });
  });
});
