import { describe, expect, it } from 'vitest';
import { composeAgentMessage } from './agent-message';

describe('composeAgentMessage', () => {
  it('returns the plain text when nothing is selected', () => {
    expect(composeAgentMessage('  Ý tưởng tuần này?  ', [])).toBe('Ý tưởng tuần này?');
  });

  it('puts a context block for the selected posts before the text', () => {
    const msg = composeAgentMessage('Viết lại hook giúp mình', [
      { id: 7, pageName: 'Page p1', format: 'video', status: 'review', title: 'Hook mới', caption: 'Dòng một\nDòng hai' },
    ]);
    expect(msg).toContain('#7');
    expect(msg).toContain('Page p1');
    expect(msg).toContain('Dòng một Dòng hai');
    expect(msg.endsWith('Viết lại hook giúp mình')).toBe(true);
  });
});
