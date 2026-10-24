import { describe, expect, it } from 'vitest';

import {
  detectAutomated,
  gmailCategory,
  htmlToText,
  normalizeGmailMessage,
  parseAddress,
  parseAddressList,
  stripQuotedReply,
} from './parse.js';
import { b64url, rawMessage } from './test-fixtures.js';

describe('parseAddress / parseAddressList', () => {
  it('parses name + address, bare address and angle-only forms', () => {
    expect(parseAddress('Khách Hàng <Khach@Example.com>')).toEqual({ email: 'khach@example.com', name: 'Khách Hàng' });
    expect(parseAddress('a@b.com')).toEqual({ email: 'a@b.com', name: '' });
    expect(parseAddress('<A@B.com>')).toEqual({ email: 'a@b.com', name: '' });
    expect(parseAddress('')).toEqual({ email: '', name: '' });
  });

  it('keeps commas inside quoted names', () => {
    expect(parseAddress('"Nguyễn, Văn A" <a@b.com>')).toEqual({ email: 'a@b.com', name: 'Nguyễn, Văn A' });
    expect(parseAddressList('"Nguyễn, Văn A" <a@b.com>, c@d.com, Eve <E@F.com>')).toEqual(['a@b.com', 'c@d.com', 'e@f.com']);
  });

  it('drops duplicates and junk', () => {
    expect(parseAddressList('a@b.com, A@B.com, undisclosed-recipients:;')).toEqual(['a@b.com']);
    expect(parseAddressList('')).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('turns block tags into newlines, drops scripts/styles and decodes entities', () => {
    const html = '<html><head><title>x</title><style>p{color:red}</style></head><body><p>Xin chào&nbsp;anh</p><div>A &amp; B &lt;3 &#39;ok&#39; &#x41;</div><script>alert(1)</script><ul><li>một</li><li>hai</li></ul><br><br><br><br>Hết</body></html>';
    expect(htmlToText(html)).toBe("Xin chào anh\nA & B <3 'ok' A\nmột\nhai\n\nHết");
  });

  it('does not double-decode entities', () => {
    expect(htmlToText('<p>&amp;lt;</p>')).toBe('&lt;');
  });
});

describe('stripQuotedReply', () => {
  it('cuts an English "On … wrote:" block', () => {
    const text = 'Cảm ơn shop, mình đồng ý.\r\n\r\nOn Wed, 7 Oct 2026 at 13:58, Shop <shop@gmail.com> wrote:\r\n> Giá là 100k\r\n> Cảm ơn';
    expect(stripQuotedReply(text)).toBe('Cảm ơn shop, mình đồng ý.');
  });

  it('cuts a wrapped "On … wrote:" header', () => {
    const text = 'OK nhé\n\nOn Wed, 7 Oct 2026 at 13:58, Shop Name\n<shop@gmail.com> wrote:\n> hi';
    expect(stripQuotedReply(text)).toBe('OK nhé');
  });

  it('cuts a Vietnamese "Vào … đã viết:" block', () => {
    const text = 'Mình cần thêm thông tin.\n\nVào Th 4, 7 thg 10, 2026 vào lúc 13:58 Shop <shop@gmail.com> đã viết:\n> Giá là 100k';
    expect(stripQuotedReply(text)).toBe('Mình cần thêm thông tin.');
  });

  it('cuts a Gmail-style "<date> <name> <email> đã viết:" line', () => {
    const text = 'Ok bạn\n\n2026-10-07 13:58 GMT+07:00 Shop <shop@gmail.com> đã viết:\n> hi';
    expect(stripQuotedReply(text)).toBe('Ok bạn');
  });

  it('cuts Original Message and Outlook header blocks', () => {
    expect(stripQuotedReply('Trả lời ngắn\n\n-----Original Message-----\nFrom: a@b.com\nSent: x\nhello')).toBe('Trả lời ngắn');
    expect(stripQuotedReply('Trả lời ngắn\n________________________________\nFrom: Shop <s@g.com>\nSent: Wednesday\nTo: x\nSubject: y\n\nbody')).toBe('Trả lời ngắn');
    expect(stripQuotedReply('Trả lời ngắn\n\nFrom: Shop <s@g.com>\nSent: Wednesday\nTo: x\n\nbody')).toBe('Trả lời ngắn');
  });

  it('drops trailing quoted lines and keeps plain text intact', () => {
    expect(stripQuotedReply('Mới\n> cũ\n> cũ nữa')).toBe('Mới');
    expect(stripQuotedReply('Một dòng thường.\nDòng hai.')).toBe('Một dòng thường.\nDòng hai.');
    expect(stripQuotedReply('From: tôi\nxin chào')).toBe('From: tôi\nxin chào');
  });

  it('returns the original when nothing would be left', () => {
    const text = 'On Wed, 7 Oct 2026, Shop <s@g.com> wrote:\n> only quote';
    expect(stripQuotedReply(text)).toBe(text);
  });
});

describe('gmailCategory', () => {
  it('maps CATEGORY_* labels', () => {
    expect(gmailCategory(['CATEGORY_PROMOTIONS', 'UNREAD', 'INBOX'])).toBe('promotions');
    expect(gmailCategory(['CATEGORY_SOCIAL'])).toBe('social');
    expect(gmailCategory(['CATEGORY_UPDATES', 'INBOX'])).toBe('updates');
    expect(gmailCategory(['CATEGORY_FORUMS'])).toBe('forums');
    expect(gmailCategory(['CATEGORY_PERSONAL', 'INBOX'])).toBe('primary');
    expect(gmailCategory(['CATEGORY_PRIMARY'])).toBe('primary');
  });

  it('treats a plain INBOX mail as primary and SENT as uncategorised', () => {
    expect(gmailCategory(['INBOX', 'UNREAD'])).toBe('primary');
    expect(gmailCategory(['SENT'])).toBe('');
    expect(gmailCategory([])).toBe('');
  });
});

describe('detectAutomated', () => {
  const base = { fromEmail: 'khach@example.com', subject: 'Hỏi giá', headers: {} as Record<string, string> };

  it('returns null for a normal customer mail', () => {
    expect(detectAutomated(base, [])).toBeNull();
    expect(detectAutomated({ ...base, fromEmail: 'info@shop.vn' }, [])).toBeNull();
  });

  it('flags list headers, precedence and auto-submitted', () => {
    expect(detectAutomated({ ...base, headers: { 'list-unsubscribe': '<mailto:u@x.com>' } }, [])).toBe('Thư hàng loạt (List-Unsubscribe)');
    expect(detectAutomated({ ...base, headers: { 'list-id': '<l.x.com>' } }, [])).toBe('Thư hàng loạt (List-Id)');
    expect(detectAutomated({ ...base, headers: { precedence: 'bulk' } }, [])).toBe('Thư hàng loạt (Precedence)');
    expect(detectAutomated({ ...base, headers: { 'auto-submitted': 'auto-replied' } }, [])).toBe('Trả lời tự động (Auto-Submitted)');
    expect(detectAutomated({ ...base, headers: { 'auto-submitted': 'no' } }, [])).toBeNull();
    expect(detectAutomated({ ...base, headers: { 'x-autoreply': 'yes' } }, [])).toBe('Trả lời tự động (X-Autoreply)');
  });

  it('flags auto-reply subjects in English and Vietnamese', () => {
    for (const subject of ['Automatic reply: Hỏi giá', 'Auto: Out', 'Out of Office', 'Trả lời tự động: Hỏi giá']) {
      expect(detectAutomated({ ...base, subject }, [])).toBe('Thư báo nghỉ / trả lời tự động');
    }
  });

  it('flags no-reply local parts and extra patterns', () => {
    const NO_REPLY = 'Địa chỉ no-reply / thông báo tự động';
    for (const fromEmail of [
      'no-reply@x.com', 'noreply@x.com', 'mailer-daemon@x.com', 'notifications@x.com',
      // Seen in a real mailbox: prefixed / suffixed forms.
      'acb-notification@acb.com.vn', 'updates-noreply@linkedin.com', 'do-not-reply@hello.stackoverflow.com', 'billing.alerts@x.com',
    ]) {
      expect(detectAutomated({ ...base, fromEmail }, []), fromEmail).toBe(NO_REPLY);
    }
    expect(detectAutomated({ ...base, fromEmail: 'bot@zapier.com' }, ['zapier'])).toContain('zapier');
  });

  it('leaves ordinary customer addresses alone', () => {
    for (const fromEmail of ['an.nguyen@gmail.com', 'info@congty.vn', 'sales@acme.com', 'notion.fan@gmail.com', 'replyguy@x.com']) {
      expect(detectAutomated({ ...base, fromEmail }, []), fromEmail).toBeNull();
    }
  });

  it('flags bank transaction notices and one-time codes, not a customer sending a receipt', () => {
    expect(detectAutomated({ ...base, subject: 'THONG BAO GIAO DICH THE /CARD TRANSACTION NOTIFICATION' }, [])).toBe('Thông báo giao dịch / mã xác thực');
    expect(detectAutomated({ ...base, subject: 'Mã xác thực của bạn là 123456' }, [])).toBe('Thông báo giao dịch / mã xác thực');
    expect(detectAutomated({ ...base, subject: 'Biên lai chuyển khoản đặt cọc' }, [])).toBeNull();
  });
});

describe('normalizeGmailMessage', () => {
  it('normalizes a Primary customer mail', () => {
    const msg = normalizeGmailMessage(rawMessage({
      id: 'm1', threadId: 't1', plain: 'Cho mình hỏi giá nhé.\nCảm ơn!', cc: 'Boss <boss@shop.vn>, x@y.com', replyTo: 'Support <support@example.com>',
      headers: [{ name: 'X-Mailer', value: 'ignored' }, { name: 'LIST-ID', value: '<l.example.com>' }],
    }));
    expect(msg).not.toBeNull();
    expect(msg!.gmailMessageId).toBe('m1');
    expect(msg!.gmailThreadId).toBe('t1');
    expect(msg!.fromEmail).toBe('khach@example.com');
    expect(msg!.fromName).toBe('Khách Hàng');
    expect(msg!.replyTo).toBe('support@example.com');
    expect(msg!.to).toEqual(['shop@gmail.com']);
    expect(msg!.cc).toEqual(['boss@shop.vn', 'x@y.com']);
    expect(msg!.subject).toBe('Hỏi giá');
    expect(msg!.bodyText).toBe('Cho mình hỏi giá nhé.\nCảm ơn!');
    expect(msg!.sentAtMs).toBe(Date.parse('2026-10-07T13:58:51Z'));
    expect(msg!.labelIds).toContain('CATEGORY_PERSONAL');
    expect(msg!.headers['message-id']).toBe('<m1@mail.example.com>');
    expect(msg!.headers['list-id']).toBe('<l.example.com>');
    expect(msg!.headers['x-mailer']).toBeUndefined();
    expect(msg!.snippet).toBe('Cho mình hỏi giá nhé. Cảm ơn!');
  });

  it('keeps the List-Unsubscribe header of a promotions newsletter', () => {
    const msg = normalizeGmailMessage(rawMessage({
      id: 'm2', threadId: 't2', labels: ['CATEGORY_PROMOTIONS', 'UNREAD', 'INBOX'], from: 'Deals <deals@promo.com>',
      plain: 'Giảm 50%', headers: [{ name: 'List-Unsubscribe', value: '<mailto:u@promo.com>' }, { name: 'Precedence', value: 'bulk' }],
    }))!;
    expect(msg.headers['list-unsubscribe']).toBe('<mailto:u@promo.com>');
    expect(detectAutomated(msg, [])).toBe('Thư hàng loạt (List-Unsubscribe)');
  });

  it('reads a SENT message', () => {
    const msg = normalizeGmailMessage(rawMessage({
      id: 'm3', threadId: 't1', labels: ['SENT'], from: 'Shop <shop@gmail.com>', to: 'Khách <khach@example.com>', plain: 'Dạ shop gửi giá.',
    }))!;
    expect(msg.labelIds).toEqual(['SENT']);
    expect(msg.fromEmail).toBe('shop@gmail.com');
    expect(msg.to).toEqual(['khach@example.com']);
  });

  it('derives text from an HTML-only message and keeps the html', () => {
    const html = '<div>Xin chào <b>shop</b></div><p>Mình cần tư vấn&nbsp;ạ</p>';
    const raw = rawMessage({ id: 'm4', threadId: 't4', html });
    (raw as { messageText: string }).messageText = '';
    const msg = normalizeGmailMessage(raw)!;
    expect(msg.bodyText).toBe('Xin chào shop\nMình cần tư vấn ạ');
    expect(msg.bodyHtml).toBe(html);
  });

  it('prefers the plain part and falls back to messageText', () => {
    const both = normalizeGmailMessage(rawMessage({ id: 'm5', threadId: 't5', plain: 'plain wins', html: '<p>html loses</p>' }))!;
    expect(both.bodyText).toBe('plain wins');
    expect(both.bodyHtml).toBe('<p>html loses</p>');
    const raw = { messageId: 'm6', threadId: 't6', messageText: 'only text\r\nline2', sender: 'A <a@b.com>', subject: 's', messageTimestamp: '2026-10-07T00:00:00Z' };
    const msg = normalizeGmailMessage(raw)!;
    expect(msg.bodyText).toBe('only text\nline2');
    expect(msg.fromEmail).toBe('a@b.com');
    expect(msg.subject).toBe('s');
  });

  it('finds nested parts and attachments', () => {
    const raw = {
      messageId: 'm7', threadId: 't7', labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: 'File' }],
        parts: [
          { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64url('nội dung') } }] },
          { mimeType: 'application/pdf', filename: 'bao-gia.pdf', body: { attachmentId: 'att1', size: 1234 } },
        ],
      },
    };
    const msg = normalizeGmailMessage(raw)!;
    expect(msg.bodyText).toBe('nội dung');
    expect(msg.attachments).toEqual([{ filename: 'bao-gia.pdf', mimeType: 'application/pdf', size: 1234, attachmentId: 'att1' }]);
  });

  it('uses internalDate and the Date header when messageTimestamp is missing', () => {
    expect(normalizeGmailMessage({ messageId: 'a', threadId: 'b', internalDate: '1790000000000' })!.sentAtMs).toBe(1790000000000);
    const withDate = { messageId: 'a', threadId: 'b', payload: { headers: [{ name: 'Date', value: 'Wed, 07 Oct 2026 13:58:51 +0000' }] } };
    expect(normalizeGmailMessage(withDate)!.sentAtMs).toBe(Date.parse('2026-10-07T13:58:51Z'));
  });

  it('caps huge bodies and rejects unusable items', () => {
    const msg = normalizeGmailMessage({ messageId: 'a', threadId: 'b', messageText: 'x'.repeat(300_000) })!;
    expect(msg.bodyText.length).toBe(200_000);
    expect(normalizeGmailMessage({ threadId: 'b' })).toBeNull();
    expect(normalizeGmailMessage({ messageId: 'a' })).toBeNull();
    expect(normalizeGmailMessage(null)).toBeNull();
    expect(normalizeGmailMessage('x')).toBeNull();
  });
});
