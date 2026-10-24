import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockSnapshotFor, captureScreenText, currentScreenContext, screenTitle } from './page-context';

// The dock and Jarvis (`read_screen`) both read the page through captureScreenText: for the old Zalo / Email UI
// (/legacy/*), the shared inbox (/care) and the chat it must return nothing, whatever the page shows.
const SECRET = 'Khách A: 0900000000 muốn đặt cọc 5 triệu';

function pageShowing(text: string): void {
  vi.stubGlobal('document', { querySelector: (sel: string) => (sel === 'main' ? { innerText: text } : null) });
}
blockSnapshotFor('/m/care');
afterEach(() => vi.unstubAllGlobals());

describe('captureScreenText', () => {
  it.each(['/chat', '/chat/3', '/m/care/inbox', '/m/care/inbox/abc'])(
    'never reads %s',
    (path) => {
      pageShowing(SECRET);
      expect(captureScreenText(path)).toBeUndefined();
    },
  );

  it('still reads an ordinary screen (so the block above is not a blanket failure)', () => {
    pageShowing('Doanh thu hôm nay 12 triệu');
    expect(captureScreenText('/usage')).toContain('Doanh thu');
  });
});

describe('screen context payload', () => {
  it('never forwards the access token', () => {
    const ctx = currentScreenContext('/tasks', '?status=review&token=s3cret');
    expect(ctx.query).toBe('status=review');
    expect(JSON.stringify(ctx)).not.toContain('s3cret');
  });

  it('titles core screens by section and label', () => {
    expect(screenTitle('/agents/main')).toBe('Agents');
    expect(screenTitle('/tasks/12')).toBe('Công việc');
    expect(screenTitle('/nowhere')).toBeUndefined();
  });
});
