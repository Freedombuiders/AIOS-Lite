import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toasts } from '@/lib/toasts';
import { snoozeOptions } from '@modules/care/web/lib/care/snooze';
import { DETAIL_LAN, fakeApi, NOW, STATUS_NONE } from '../lib/fixtures.test-util';
import { fire, mount, q, qa, settle } from '../lib/mount.test-util';
import { CrmCustomer } from './CrmCustomer';

const now = () => NOW;
let cleanup: (() => void) | null = null;
beforeEach(() => { toasts.value = []; });
afterEach(() => { cleanup?.(); cleanup = null; });
const open = async (api = fakeApi()) => {
  const m = await mount(<CrmCustomer api={api} id="lan" now={now} />);
  cleanup = m.unmount;
  return { ...m, api };
};

describe('CrmCustomer (Hồ sơ)', () => {
  it('shows the fields, needs, activity and the note path', async () => {
    const { host } = await open();
    expect(q(host, '[data-testid="crm-customer-name"]')!.textContent).toBe('Chị Lan');
    expect(q(host, '[data-testid="crm-note-path"]')!.textContent).toBe('ban-hang/khach-hang/lan.md');
    const props = q(host, '[data-testid="crm-props"]')!.textContent ?? '';
    for (const s of ['dang-tu-van', '0901234567', 'hỏi sỉ, ô long sen', 'Gửi báo giá', '28/11/2026']) expect(props).toContain(s);
    expect(qa(host, '[data-testid="crm-need"]').map((n) => n.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Trà ô long sen'), expect.stringContaining('60 hộp')]));
    expect(host.textContent).toContain('Hay nhắn buổi tối');
    expect(qa(host, '[data-testid="crm-log"]').map((l) => l.textContent)).toEqual([expect.stringContaining('Đổi giai đoạn: Mới → Đang tư vấn'), expect.stringContaining('Tạo khách')]);
    // nothing about ranking, orders or "giống khách tốt nhất"
    expect(host.textContent).not.toMatch(/Đơn hàng|giống khách tốt nhất|xếp hạng/i);
  });

  it('"File gốc" reads the real markdown through the brain file route, only when asked', async () => {
    const { host, api } = await open();
    expect(api.noteFile).not.toHaveBeenCalled();
    await fire(q(host, '[data-testid="crm-file-toggle"]')!, 'click');
    await settle();
    expect(api.noteFile).toHaveBeenCalledWith('ban-hang', 'khach-hang/lan.md');
    expect(q(host, '[data-testid="crm-file"]')!.textContent).toContain('loai: khach-hang');
    await fire(qa(host, '[role="group"] button').find((b) => b.textContent === 'Thuộc tính')!, 'click');
    expect(q(host, '[data-testid="crm-props"]')).not.toBeNull();
  });

  it('says so when the file cannot be read', async () => {
    const { host } = await open(fakeApi({ noteFile: (async () => { throw new Error('Không đọc được tệp này.'); }) as never }));
    await fire(q(host, '[data-testid="crm-file-toggle"]')!, 'click');
    await settle();
    expect(host.textContent).toContain('Không đọc được file khach-hang/lan.md');
  });

  it('opens the chat of the conversation that is this customer\'s, and Obsidian with a path built from the folder', async () => {
    const { host } = await open();
    expect(q(host, '[data-testid="crm-open-chat"]')!.getAttribute('href')).toBe('/m/care/inbox/conv-lan');
    expect(q(host, '[data-testid="crm-obsidian"]')!.getAttribute('href')).toBe(`obsidian://open?path=${encodeURIComponent('/Users/me/Brain/ban-hang/khach-hang/lan.md')}`);
  });

  it('marks a follow-up done with its revision, then reloads', async () => {
    const { host, api } = await open();
    await fire(q(host, '[data-testid="crm-task-done"]')!, 'click');
    await settle();
    expect(api.patchTask).toHaveBeenCalledWith('t-lan', { expectedRevision: 4, done: true });
    expect(api.careCustomer.mock.calls.length).toBeGreaterThan(1);
    expect(toasts.value.some((t) => t.tone === 'success')).toBe(true);
  });

  it('lists only open follow-ups and postpones one to the chosen time', async () => {
    const { host, api } = await open();
    expect(qa(host, '[data-testid="crm-task"]')).toHaveLength(1); // the done one is not listed
    const sel = q<HTMLSelectElement>(host, '[data-testid="crm-task-postpone"]')!;
    sel.value = 'tomorrow9';
    await fire(sel, 'change');
    await settle();
    const tomorrow = snoozeOptions(Date.now()).find((o) => o.id === 'tomorrow9')!;
    const call = api.patchTask.mock.calls[0]!;
    expect(call[0]).toBe('t-lan');
    expect(call[1].expectedRevision).toBe(4);
    expect(Math.abs(call[1].dueAtMs - tomorrow.untilMs)).toBeLessThan(5_000);
    expect(call[1].done).toBeUndefined();
  });

  it('shows why a follow-up could not change instead of failing silently', async () => {
    const { host } = await open(fakeApi({ patchTask: (async () => { throw new Error('Việc vừa được sửa ở nơi khác.'); }) as never }));
    await fire(q(host, '[data-testid="crm-task-done"]')!, 'click');
    await settle();
    expect(toasts.value.find((t) => t.tone === 'error')?.description).toContain('sửa ở nơi khác');
  });

  it('with no notes folder: the profile works from the database, File gốc explains, Obsidian is off, banner points at the setting', async () => {
    const noNote = { ...DETAIL_LAN, folderId: null, notePath: null, exportedAt: null, trangThai: 'chua-xuat' as const };
    const { host, api } = await open(fakeApi({ status: (async () => STATUS_NONE) as never, customer: (async () => noNote) as never }));
    expect(q(host, '[data-testid="crm-not-configured"]')!.textContent).toContain('Chưa chọn thư mục Second Brain');
    expect(q(host, '[data-testid="crm-customer-name"]')!.textContent).toBe('Chị Lan');
    expect(q<HTMLButtonElement>(host, '[data-testid="crm-obsidian"]')!.disabled).toBe(true);
    await fire(q(host, '[data-testid="crm-file-toggle"]')!, 'click');
    expect(q(host, '[data-testid="crm-file-none"]')!.textContent).toContain('Chưa chọn thư mục Second Brain');
    expect(api.noteFile).not.toHaveBeenCalled();
    expect(qa(host, '[data-testid="crm-task"]')).toHaveLength(1);
  });

  it('still shows the profile when care\'s own record cannot be read; chat and tasks fall back', async () => {
    const { host } = await open(fakeApi({ careCustomer: (async () => { throw new Error('x'); }) as never }));
    expect(q(host, '[data-testid="crm-customer-name"]')!.textContent).toBe('Chị Lan');
    expect(q<HTMLButtonElement>(host, '[data-testid="crm-open-chat"]')!.disabled).toBe(true);
  });

  it('shows an error for a customer that does not exist', async () => {
    const { host } = await open(fakeApi({ customer: (async () => { throw new Error('Không tìm thấy khách này.'); }) as never }));
    expect(host.textContent).toContain('Không tìm thấy khách này.');
  });
});
