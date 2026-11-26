import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CareInlineDraftDto } from '@modules/care/web/lib/care/dto';
import { InlineDraftCard } from './InlineDraftCard';

const host = document.createElement('div'); document.body.append(host);
afterEach(() => { act(() => render(null, host)); });

const draft = (over: Partial<CareInlineDraftDto> = {}): CareInlineDraftDto => ({
  id: 'd1', conversationId: 'c1', accountId: 'a1', channel: 'zalo', source: 'core', agentId: 'cskh', text: 'Ô long sen giá sỉ 260 nghìn một hộp chị ạ.', email: null,
  reviewReason: null, status: 'draft', createdAtMs: 1_700_000_000_000, payloadRevision: 2, stop: { codes: ['review_keyword'], detail: 'giảm giá' }, sources: [], ...over,
});
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
function show(d: CareInlineDraftDto, h: Partial<Parameters<typeof InlineDraftCard>[0]> = {}) {
  const onSend = vi.fn(); const onSendEdited = vi.fn(); const onDiscard = vi.fn();
  act(() => render(<InlineDraftCard draft={d} more={0} agents={[{ id: 'cskh', name: 'Bot CSKH' }]} busy={null} onSend={onSend} onSendEdited={onSendEdited} onDiscard={onDiscard} {...h} />, host));
  return { onSend, onSendEdited, onDiscard };
}

describe('the bot draft above the composer', () => {
  it('shows who drafted it, the stop reason, and the three buttons Gửi / Sửa rồi gửi / Bỏ', () => {
    show(draft());
    expect(host.textContent).toContain('Bot CSKH soạn sẵn, chưa gửi');
    expect(q('care-draft-why')?.textContent).toBe('Bot dừng lại vì câu có từ khoá cần duyệt “giảm giá”');
    expect([q('care-draft-send'), q('care-draft-edit'), q('care-draft-discard')].map((b) => b?.textContent?.trim())).toEqual(['Gửi', 'Sửa rồi gửi', 'Bỏ']);
  });

  it('lists the brain sources when the run recorded some, and says plainly when none was', () => {
    show(draft({ sources: ['danh-muc-tra-sen.md', 'chinh-sach-dai-ly.md'] }));
    expect(q('care-draft-sources')?.textContent).toBe('Lấy từ brain: danh-muc-tra-sen.md · chinh-sach-dai-ly.md');
    expect(q('care-draft-nosources')).toBeNull();
    show(draft({ sources: [] }));
    expect(q('care-draft-nosources')?.textContent).toBe('Chưa ghi nguồn brain cho nháp này.');
  });

  it('Gửi sends the draft as it is; Bỏ discards it', () => {
    const h = show(draft());
    act(() => q('care-draft-send')!.click());
    expect(h.onSend).toHaveBeenCalledTimes(1);
    act(() => q('care-draft-discard')!.click());
    expect(h.onDiscard).toHaveBeenCalledTimes(1);
  });

  it('Sửa rồi gửi opens the text in place and sends the edit (only once it changed)', () => {
    const h = show(draft());
    act(() => q('care-draft-edit')!.click());
    const ta = q('care-draft-edit-text') as HTMLTextAreaElement;
    expect(ta.value).toContain('260 nghìn');
    expect((q('care-draft-send-edited') as HTMLButtonElement).disabled).toBe(true);
    act(() => { ta.value = 'Giá sỉ 250 nghìn một hộp chị ạ.'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => q('care-draft-send-edited')!.click());
    expect(h.onSendEdited).toHaveBeenCalledWith('Giá sỉ 250 nghìn một hộp chị ạ.');
    expect(h.onSend).not.toHaveBeenCalled();
    act(() => q('care-draft-cancel-edit')!.click());
    expect(q('care-draft-send')).not.toBeNull();
  });

  it('blocks sending while the draft still has [..] blanks', () => {
    show(draft({ text: 'Giá [..] một hộp' }));
    expect((q('care-draft-send') as HTMLButtonElement).disabled).toBe(true);
  });
});
