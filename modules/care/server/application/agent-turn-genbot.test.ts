/**
 * T06: what a text-only, tool-less runtime (GenBot) needs from the agent turn: image-only / PDF-only messages go to the
 * owner instead of a blind answer, and the prompt is fitted into the runtime's character limit (or the turn is skipped).
 */
import { describe, expect, it } from 'vitest';
import { buildAgentContext, createSqliteConversationReader } from './agent-context.js';
import { seed, T0, type Seeded } from './agent-test-support.js';
import { NO_TURN_MEDIA, type TurnMediaSource } from './turn-media.js';
import { OWNER_SKIP_REASONS } from './agent-turn.js';

const req = (s: Seeded) => ({ conversationId: s.conversationId, triggerMessageId: s.triggerId });
const image = { id: 'img-1', mimeType: 'image/jpeg', fileName: 'anh.jpg' };
const pdf = { id: 'pdf-1', mimeType: 'application/octet-stream', fileName: 'bao-gia.pdf' };
const chat = (attachments: unknown[], text = '') => ({ text, metadata: { type: 'chat' as const, attachments: attachments as never } });

/** A runtime that reads nothing (GenBot): turn media never attaches anything. */
const textOnly: TurnMediaSource = async () => NO_TURN_MEDIA;
/** A vision runtime: every customer attachment travels with the prompt. */
const vision: TurnMediaSource = async ({ messages }) => {
  const attached = new Map<string, string>();
  messages.forEach((m) => (m.metadata.attachments ?? []).forEach((_, i) => attached.set(`${m.id}:${i}`, `anh-${attached.size + 1}.jpg`)));
  return { attached, images: [...attached.values()].map((n) => `/tmp/${n}`), documents: [], cleanup: () => {} };
};

describe('image-only and PDF-only messages with a text-only runtime (T06)', () => {
  it('an image with no text goes to the owner: skipped run, no model call', async () => {
    const s = seed({ assignment: { mode: 'auto' }, messages: [chat([image])] });
    const out = await s.turn({ turnMedia: textOnly }).run(req(s));
    expect(out).toMatchObject({ status: 'skipped', reason: 'media_needs_owner' });
    expect(out.run.decision).toMatchObject({ detail: { attachments: 1 } });
    expect(s.runner.requests).toHaveLength(0);
    expect(s.sink.proposals).toHaveLength(0);
    expect(OWNER_SKIP_REASONS.has('media_needs_owner')).toBe(true); // the module raises owner attention for it
    s.close();
  });

  it('a PDF with no text passes the gate and goes to the owner too', async () => {
    const s = seed({ assignment: { mode: 'draft' }, messages: [chat([pdf])] });
    const out = await s.turn({ turnMedia: textOnly }).run(req(s));
    expect(out).toMatchObject({ status: 'skipped', reason: 'media_needs_owner' });
    expect(s.runner.requests).toHaveLength(0);
    s.close();
  });

  it('without any media source (nothing can be read) the image is not answered blind either', async () => {
    const s = seed({ messages: [chat([image])] });
    expect(await s.turn().run(req(s))).toMatchObject({ status: 'skipped', reason: 'media_needs_owner' });
    expect(s.runner.requests).toHaveLength(0);
    s.close();
  });

  it('a vision runtime still gets the image; text next to an image still gets an answer from a text-only runtime', async () => {
    const v = seed({ assignment: { mode: 'draft' }, messages: [chat([image])] });
    expect((await v.turn({ turnMedia: vision }).run(req(v))).status).toBe('drafted');
    expect(v.runner.requests[0]!.images).toHaveLength(1);
    v.close();

    const t = seed({ assignment: { mode: 'draft' }, messages: [chat([image], 'áo trong ảnh còn size M không?')] });
    expect((await t.turn({ turnMedia: textOnly }).run(req(t))).status).toBe('drafted');
    expect(t.runner.requests[0]!.prompt).toContain('content not available to you');
    t.close();
  });

  it('only the current burst counts: an image the shop already answered is not counted again', async () => {
    const s = seed({
      assignment: { mode: 'draft', policyExt: { humanPauseMinutes: 0 } },
      messages: [chat([image]), { text: 'Dạ shop xem rồi ạ', direction: 'out', senderRole: 'operator', senderIdentityKey: null }, chat([image])],
    });
    const out = await s.turn({ turnMedia: textOnly }).run(req(s));
    expect(out).toMatchObject({ status: 'skipped', reason: 'media_needs_owner' });
    expect(out.run.decision).toMatchObject({ detail: { attachments: 1 } });
    s.close();
  });
});

describe('prompt budget for a runtime with a character limit (T06)', () => {
  const long = (i: number) => `Tin ${i}: ${'nội dung dài '.repeat(170)}`.slice(0, 2_000);
  const thirty = () => Array.from({ length: 30 }, (_, i) => ({ text: i === 29 ? `CÂU HỎI MỚI NHẤT ${'chi tiết '.repeat(150)}` : long(i) }));

  it('30 messages of 2,000 characters: the prompt stays under 20,000 and keeps the newest customer message whole', async () => {
    const s = seed({ assignment: { mode: 'draft' }, messages: thirty() });
    const trigger = s.stores.messages.getMessage(s.triggerId)!;
    const out = await s.turn({ promptLimit: () => 20_000 }).run(req(s));
    expect(out.status).toBe('drafted');
    const prompt = s.runner.requests[0]!.prompt;
    expect(prompt.length).toBeLessThanOrEqual(20_000);
    expect(prompt).toContain(trigger.text.trim());
    expect(prompt).toContain('Tin 28'); // the newest history is kept, the oldest is dropped first
    expect(prompt).not.toContain('Tin 0:');
    s.close();
  });

  it('a limit too small for even the fixed instructions skips the turn with prompt_too_long, nothing is sent to the model', async () => {
    const s = seed({ assignment: { mode: 'auto' } });
    const out = await s.turn({ promptLimit: () => 1_500 }).run(req(s));
    expect(out).toMatchObject({ status: 'skipped', reason: 'prompt_too_long' });
    expect(s.runner.requests).toHaveLength(0);
    expect(OWNER_SKIP_REASONS.has('prompt_too_long')).toBe(true);
    s.close();
  });

  it('no known limit (older runtime contract) keeps the previous behaviour', async () => {
    const s = seed({ assignment: { mode: 'draft' }, messages: thirty() });
    expect((await s.turn({ promptLimit: () => null }).run(req(s))).status).toBe('drafted');
    expect((await s.turn({ promptLimit: () => 10_000 }).run({ ...req(s), trigger: 'manual' })).status).toBe('drafted');
    const [free, limited] = s.runner.requests.map((r) => r.prompt.length);
    expect(free).toBeGreaterThan(limited!); // only the token cap applied without a limit
    expect(limited).toBeLessThanOrEqual(10_000);
    s.close();
  });

  it('buildAgentContext honours a caller-supplied character budget', () => {
    const s = seed({ assignment: { mode: 'draft' }, messages: thirty() });
    const conversation = s.stores.conversations.getConversation(s.conversationId)!;
    const trigger = s.stores.messages.getMessage(s.triggerId)!;
    const reader = createSqliteConversationReader(s.raw, s.stores);
    const c = buildAgentContext({ conversation, account: s.account, trigger, reader, limits: { maxChars: 8_000 } });
    expect(c.transcript.length).toBeLessThanOrEqual(8_000);
    expect(c.truncated).toBe(true);
    expect(c.messages.at(-1)!.messageId).toBe(trigger.id);
    expect(c.messages.at(-1)!.text).toBe(trigger.text.trim());

    // a newest message larger than the whole budget is shortened, never dropped
    const tiny = buildAgentContext({ conversation, account: s.account, trigger, reader, limits: { maxChars: 600 } });
    expect(tiny.messages).toHaveLength(1);
    expect(tiny.messages[0]!.text).toContain('[truncated]');
    expect(tiny.transcript.length).toBeLessThanOrEqual(600);
    expect(T0).toBeGreaterThan(0);
    s.close();
  });
});
