/**
 * Test-only builders for Composio GMAIL_FETCH_EMAILS items (live shape,
 * probed 2026-10-07) and the normalized GmailMessage used by sync/sender tests.
 */

import type { GmailMessage } from './parse.js';

export function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export interface RawOpts {
  id: string;
  threadId: string;
  labels?: string[];
  from?: string;
  to?: string;
  cc?: string;
  replyTo?: string;
  subject?: string;
  timestamp?: string;
  plain?: string;
  html?: string;
  headers?: Array<{ name: string; value: string }>;
  attachments?: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
}

/** A message as Composio returns it with include_payload + verbose. */
export function rawMessage(o: RawOpts): Record<string, unknown> {
  const headers = [
    { name: 'From', value: o.from ?? 'Khách Hàng <khach@example.com>' },
    { name: 'To', value: o.to ?? 'Shop <shop@gmail.com>' },
    { name: 'Subject', value: o.subject ?? 'Hỏi giá' },
    { name: 'Message-ID', value: `<${o.id}@mail.example.com>` },
    { name: 'Date', value: 'Wed, 07 Oct 2026 13:58:51 +0000' },
    ...(o.cc ? [{ name: 'Cc', value: o.cc }] : []),
    ...(o.replyTo ? [{ name: 'Reply-To', value: o.replyTo }] : []),
    ...(o.headers ?? []),
  ];
  const parts: unknown[] = [];
  if (o.plain !== undefined) parts.push({ mimeType: 'text/plain', body: { data: b64url(o.plain), size: o.plain.length } });
  if (o.html !== undefined) parts.push({ mimeType: 'text/html', body: { data: b64url(o.html), size: o.html.length } });
  for (const a of o.attachments ?? []) {
    parts.push({ mimeType: a.mimeType, filename: a.filename, body: { attachmentId: a.attachmentId, size: a.size } });
  }
  return {
    messageId: o.id,
    threadId: o.threadId,
    labelIds: o.labels ?? ['UNREAD', 'INBOX', 'CATEGORY_PERSONAL'],
    messageText: o.plain ? o.plain.replace(/\n/g, '\r\n') : '',
    messageTimestamp: o.timestamp ?? '2026-10-07T13:58:51Z',
    sender: o.from ?? 'Khách Hàng <khach@example.com>',
    to: o.to ?? 'Shop <shop@gmail.com>',
    subject: o.subject ?? 'Hỏi giá',
    preview: { body: (o.plain ?? '').slice(0, 100), subject: o.subject ?? 'Hỏi giá' },
    attachmentList: [],
    display_url: 'https://mail.google.com/mail/u/0/#inbox/x',
    payload: {
      mimeType: parts.length > 1 ? 'multipart/alternative' : 'text/plain',
      headers,
      parts,
      body: { size: 0 },
    },
  };
}

export function gmailMessage(over: Partial<GmailMessage> & { gmailMessageId: string; gmailThreadId: string }): GmailMessage {
  return {
    labelIds: ['UNREAD', 'INBOX', 'CATEGORY_PERSONAL'],
    fromEmail: 'khach@example.com',
    fromName: 'Khách Hàng',
    replyTo: '',
    to: ['shop@gmail.com'],
    cc: [],
    subject: 'Hỏi giá',
    bodyText: 'Cho mình hỏi giá sản phẩm A nhé.',
    bodyHtml: '',
    snippet: 'Cho mình hỏi giá sản phẩm A nhé.',
    headers: {},
    attachments: [],
    sentAtMs: Date.parse('2026-10-07T13:58:51Z'),
    ...over,
  };
}
