import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { convWithBot } from '@modules/care/web/lib/care/bot.test-util';
import { conv } from '@modules/care/web/lib/care/fixtures.test-util';
import { ConversationRow } from './ConversationRow';

const host = document.createElement('div'); document.body.append(host);
afterEach(() => { act(() => render(null, host)); });

function show(c: ReturnType<typeof conv>) {
  act(() => render(<ConversationRow conversation={c} account={undefined} agents={[]} waitThresholdMin={10} nowMs={5000} active={false} showAccount={false} onSelect={() => undefined} />, host));
  return { chip: host.querySelector('[data-testid="care-state-chip"]'), row: host.querySelector('.care-row') };
}

describe('conversation row state label (server-computed)', () => {
  it('a conversation with a bot draft waiting says "Chờ bạn duyệt"', () => {
    const { chip, row } = show(convWithBot('review'));
    expect(chip?.textContent).toBe('Chờ bạn duyệt');
    expect(chip?.getAttribute('data-state')).toBe('review');
    expect(row?.getAttribute('data-bot-state')).toBe('review');
  });

  it.each([
    ['active', 'Bot đang chăm'],
    ['yielded', 'Bot nhường bạn'],
    ['handoff', 'Chuyển cho bạn'],
    ['none', 'Chưa gán bot'],
  ] as const)('%s reads "%s"', (label, text) => {
    expect(show(convWithBot(label)).chip?.textContent).toBe(text);
  });

  it('shows exactly one state label, whatever else the row carries (no owner or AI chips any more)', () => {
    show(convWithBot('active', { waitingSinceMs: 1000 }));
    expect(host.querySelectorAll('.care-state')).toHaveLength(1);
    expect(host.querySelector('[data-testid="care-owner-chip"]')).toBeNull();
    expect(host.querySelector('[data-testid="care-ai-chip"]')).toBeNull();
  });

  it('computes nothing in the browser: a row without the server label shows no state chip', () => {
    const c = convWithBot('review');
    delete c.workflow!.bot;
    expect(show(c).chip).toBeNull();
  });
});
