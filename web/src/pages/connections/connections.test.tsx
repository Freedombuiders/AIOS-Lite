import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { GrantControl } from '@/components/agents/GrantControl';
import { IntegrationGrants } from '@/components/agents/IntegrationGrants';
import { mockRequest } from '@/lib/mock';
import { approvalIdFromKey, grantLevel, withGrant } from '@/lib/integrations';
import { ApprovalsTab } from './ApprovalsTab';
import { IntegrationsTab } from './IntegrationsTab';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(root: HTMLElement, ok: () => boolean) {
  for (let i = 0; i < 40 && !ok(); i++) await act(async () => { await wait(50); });
}
async function mount(vnode: preact.VNode, ready?: (root: HTMLElement) => boolean) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  await act(async () => { render(<Router>{vnode}</Router>, root); await wait(100); });
  if (ready) await until(root, () => ready(root));
  return root;
}

describe('integrations web', () => {
  beforeEach(() => { sessionStorage.setItem('aios.mock', '1'); document.body.innerHTML = ''; });

  it('grant helpers keep per-command lists', () => {
    expect(grantLevel(undefined)).toBe('off');
    expect(grantLevel({ grant: 'ask', ask: ['x'] })).toBe('ask');
    expect(withGrant({ grant: 'ask', ask: ['x'] }, 'write')).toEqual({ grant: 'write', ask: ['x'] });
    expect(withGrant('read', 'ask')).toBe('ask');
    expect(approvalIdFromKey('integration:approval:7')).toBe('7');
    expect(approvalIdFromKey('task:7')).toBeNull();
  });

  it('GrantControl selects a level', async () => {
    const onChange = vi.fn();
    const root = await mount(<GrantControl label="Quyền" value="read" onChange={onChange} />);
    const radios = [...root.querySelectorAll('[role=radio]')] as HTMLButtonElement[];
    expect(radios.map((r) => r.textContent)).toEqual(['Tắt', 'Chỉ đọc', 'Hỏi trước', 'Đọc & ghi']);
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    await act(async () => radios[3]!.click());
    expect(onChange).toHaveBeenCalledWith('write');
  });

  it('agent section lists every integration and persists a change', async () => {
    const root = await mount(<IntegrationGrants agentId="demo" />, (r) => r.querySelectorAll('[role=radio]:not([disabled])').length > 0);
    expect(root.textContent).toContain('Pancake');
    expect(root.textContent).toContain('Botcake');
    const pancake = [...root.querySelectorAll('[role=radiogroup]')].find((g) => g.getAttribute('aria-label') === 'Quyền Pancake')!;
    await act(async () => { ([...pancake.querySelectorAll('[role=radio]')][3] as HTMLButtonElement).click(); await wait(400); });
    expect((await mockRequest<{ grants: Record<string, string> }>('GET', '/agents/demo/integrations')).grants.pancake).toBe('write');
    expect(root.textContent).toContain('ghi trực tiếp');
  });

  it('approvals tab approves a pending command', async () => {
    const root = await mount(<ApprovalsTab />, (r) => r.querySelectorAll('[data-testid=pending-approval]').length > 0);
    expect(root.querySelectorAll('[data-testid=pending-approval]').length).toBe(1);
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Duyệt') && !b.textContent.includes('luôn'))!;
    await act(async () => { btn.click(); await wait(500); });
    const list = await mockRequest<{ items: { status: string }[] }>('GET', '/integrations/approvals?status=pending');
    expect(list.items.length).toBe(0);
  });

  it('catalog groups cards by category with status', async () => {
    const root = await mount(<IntegrationsTab />, (r) => r.textContent!.includes('Pancake'));
    expect(root.textContent).toContain('Bán hàng & chat');
    expect(root.textContent).toContain('Đã kết nối · Shop Hoa Sen');
    expect(root.textContent).toContain('Chưa kết nối');
  });
});
