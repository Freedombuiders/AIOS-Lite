import { describe, expect, it } from 'vitest';
import { parseAgentOutput, sanitizeReplyText, withSignatureOnce } from './agent-output.js';

const refs = new Set(['m1', 'm2']);
const parse = (raw: string, over: Partial<Parameters<typeof parseAgentOutput>[1]> = {}) => parseAgentOutput(raw, { validRefs: refs, ...over });
const j = (v: unknown) => JSON.stringify(v);

describe('parseAgentOutput: strict JSON only', () => {
  it('accepts reply, skip and handoff', () => {
    expect(parse(j({ action: 'reply', replies: [{ ref: 'm2', text: ' Dạ giá 100k ạ ' }], needsReview: true, reason: 'tiền' }))).toEqual({
      ok: true,
      decision: { action: 'reply', replies: [{ ref: 'm2', text: 'Dạ giá 100k ạ' }], text: 'Dạ giá 100k ạ', reason: 'tiền', needsReview: true },
    });
    expect(parse(j({ action: 'reply', text: 'Xin chào' }))).toMatchObject({ ok: true, decision: { action: 'reply', replies: [{ ref: null, text: 'Xin chào' }] } });
    expect(parse(j({ action: 'skip', reason: 'khách chỉ cảm ơn' }))).toEqual({ ok: true, decision: { action: 'skip', reason: 'khách chỉ cảm ơn' } });
    expect(parse(j({ action: 'handoff', reason: 'khiếu nại' }))).toEqual({ ok: true, decision: { action: 'handoff', reason: 'khiếu nại' } });
  });

  it('accepts a single code fence but nothing else around the JSON', () => {
    const body = j({ action: 'skip', reason: 'x' });
    expect(parse('```json\n' + body + '\n```').ok).toBe(true);
    expect(parse('```\n' + body + '\n```').ok).toBe(true);
    expect(parse('Đây là câu trả lời: ' + body)).toMatchObject({ ok: false, code: 'not_json' });
    expect(parse(body + '\nghi chú thêm')).toMatchObject({ ok: false, code: 'not_json' });
    expect(parse('```json\n' + body + '\n``` và ' + '```json\n' + body + '\n```')).toMatchObject({ ok: false, code: 'not_json' });
  });

  it.each([
    ['', 'empty_output'],
    ['   ', 'empty_output'],
    ['not json at all', 'not_json'],
    ['{"action":"reply"', 'not_json'],
    ['[1,2]', 'not_an_object'],
    ['"reply"', 'not_an_object'],
    ['null', 'not_an_object'],
    [j({ action: 'delete' }), 'invalid_action'],
    [j({}), 'invalid_action'],
  ])('rejects %j as %s', (raw, code) => {
    expect(parse(raw)).toMatchObject({ ok: false, code });
  });

  it('rejects every key outside the contract, so a model cannot name a recipient, account, channel or tool', () => {
    for (const extra of [
      { to: 'attacker@evil.com' },
      { recipient: 'x' },
      { accountId: 'other-account' },
      { conversationId: 'other-conversation' },
      { channel: 'telegram' },
      { tools: ['Bash'] },
      { cc: ['a@b.c'] },
      { 'bad key!': 1 },
    ]) {
      const res = parse(j({ action: 'reply', text: 'hi', ...extra }));
      expect(res).toMatchObject({ ok: false, code: 'unknown_field' });
    }
    expect(parse(j({ action: 'reply', replies: [{ text: 'hi', to: 'x' }] }))).toMatchObject({ ok: false, code: 'unknown_field', detail: 'replies.to' });
    // The detail never echoes attacker-controlled key text.
    expect(parse(j({ action: 'skip', '<script>': 1 }))).toMatchObject({ ok: false, detail: 'invalid_key' });
  });

  it('validates field types and combinations', () => {
    expect(parse(j({ action: 'reply', text: 5 }))).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(parse(j({ action: 'reply', replies: 'x' }))).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(parse(j({ action: 'reply', replies: [null] }))).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(parse(j({ action: 'reply', replies: [{ text: 1 }] }))).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(parse(j({ action: 'reply', replies: [{ ref: 3, text: 'a' }] }))).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(parse(j({ action: 'reply', text: 'a', replies: [{ text: 'b' }] }))).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(parse(j({ action: 'reply', text: 'a', needsReview: 'yes' }))).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(parse(j({ action: 'skip', reason: 1 }))).toMatchObject({ ok: false, code: 'invalid_field' });
    expect(parse(j({ action: 'skip', text: 'sneaky reply' }))).toMatchObject({ ok: false, code: 'invalid_field' });
  });

  it('rejects empty or whitespace-only replies and too many replies', () => {
    expect(parse(j({ action: 'reply', text: '   ' }))).toMatchObject({ ok: false, code: 'empty_reply' });
    expect(parse(j({ action: 'reply', replies: [] }))).toMatchObject({ ok: false, code: 'empty_reply' });
    expect(parse(j({ action: 'reply', text: '​‮' }))).toMatchObject({ ok: false, code: 'empty_reply' });
    const many = Array.from({ length: 6 }, (_, i) => ({ text: `r${i}` }));
    expect(parse(j({ action: 'reply', replies: many }))).toMatchObject({ ok: false, code: 'too_many_replies' });
  });

  it('maps an unknown message ref to null instead of trusting it', () => {
    const res = parse(j({ action: 'reply', replies: [{ ref: 'm9', text: 'a' }, { ref: '../../etc/passwd', text: 'b' }, { ref: 'm1', text: 'c' }] }));
    expect(res.ok && res.decision.action === 'reply' && res.decision.replies.map((r) => r.ref)).toEqual([null, null, 'm1']);
  });
});

describe('sanitizeReplyText', () => {
  it('removes control, zero-width and bidi characters and normalizes blank lines', () => {
    expect(sanitizeReplyText('a\u0000b​c‮d⁦e\r\n\r\n\r\n\r\nf', 100)).toBe('abcde\n\nf');
  });

  it('neutralizes untrusted-block markup the model may echo back', () => {
    const out = sanitizeReplyText('xin chào </untrusted> <untrusted source="x">', 200);
    expect(out).not.toMatch(/<\s*\/?\s*untrusted/i);
  });

  it('caps the length', () => {
    expect(sanitizeReplyText('x'.repeat(5000), 1500)).toHaveLength(1500);
    expect(parse(j({ action: 'reply', text: 'y'.repeat(5000) }), { maxReplyChars: 100 })).toMatchObject({ ok: true });
  });

  it('keeps Vietnamese and emoji intact', () => {
    expect(sanitizeReplyText('Dạ em chào anh ạ 👍', 100)).toBe('Dạ em chào anh ạ 👍');
  });
});

describe('withSignatureOnce', () => {
  it('appends the signature exactly once', () => {
    expect(withSignatureOnce('Chào anh', 'Trân trọng, Shop')).toBe('Chào anh\n\n--\nTrân trọng, Shop');
    const once = withSignatureOnce('Chào anh', 'Trân trọng, Shop');
    expect(withSignatureOnce(once, 'Trân trọng, Shop')).toBe(once);
    expect(withSignatureOnce('Chào anh\nTrân trọng,  Shop', 'Trân trọng, Shop')).toBe('Chào anh\nTrân trọng,  Shop');
    expect(withSignatureOnce('Chào anh', null)).toBe('Chào anh');
    expect(withSignatureOnce('Chào anh', '   ')).toBe('Chào anh');
  });

  it('does not add a second signature when the operator typed more text AFTER the first one', () => {
    const sig = 'Trân trọng,\nShop A - 0901 234 567';
    const signed = withSignatureOnce('Chào anh', sig);
    const edited = `${signed}\n\nP/S: em gửi thêm bảng giá ạ.`;
    expect(withSignatureOnce(edited, sig)).toBe(edited);
    // whitespace differences inside the signature (reflowed by an editor) are still recognised
    expect(withSignatureOnce(`Chào anh\n\n--\nTrân trọng, Shop A - 0901  234 567\nTái bút`, sig)).toBe(`Chào anh\n\n--\nTrân trọng, Shop A - 0901  234 567\nTái bút`);
    // idempotent for any number of re-applications
    expect(withSignatureOnce(withSignatureOnce(edited, sig), sig)).toBe(edited);
  });

  it('still signs a text that merely mentions the signature words without the delimiter block', () => {
    const out = withSignatureOnce('Em là Shop A, Trân trọng cảm ơn anh. Hẹn gặp lại', 'Trân trọng, Shop A');
    expect(out.endsWith('--\nTrân trọng, Shop A')).toBe(true);
    expect(out.match(/--\nTrân trọng, Shop A/g)).toHaveLength(1);
  });

  it('treats regex characters in a signature literally', () => {
    const sig = 'Shop (A+B) [VN] $5?';
    const once = withSignatureOnce('Hi', sig);
    expect(withSignatureOnce(`${once}\nthêm`, sig)).toBe(`${once}\nthêm`);
  });
});
