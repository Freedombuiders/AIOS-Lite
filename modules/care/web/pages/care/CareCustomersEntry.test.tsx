import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { memoryLocation } from 'wouter-preact/memory-location';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./CareCustomers', () => ({ CareCustomers: () => <div data-testid="old-customers">old</div> }));
import { CareCustomersEntry, CRM_CUSTOMERS_PATH } from './CareCustomersEntry';

afterEach(() => vi.unstubAllGlobals());
const wait = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function visit(crmStatus: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(crmStatus === 200 ? { state: 'san-sang' } : { error: { code: 'not_found', message: 'x' } }), { status: crmStatus })));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const loc = memoryLocation({ path: '/m/care/customers', record: true });
  await act(async () => { render(<Router hook={loc.hook}><CareCustomersEntry /></Router>, host); });
  await wait();
  return { host, loc };
}

describe('/m/care/customers', () => {
  it('redirects to the crm customer screens while crm is on', async () => {
    const { host, loc } = await visit(200);
    expect(loc.history).toContain(CRM_CUSTOMERS_PATH);
    expect(host.querySelector('[data-testid="old-customers"]')).toBeNull();
  });
  it('keeps showing the old list when crm is off, so the page never goes dark', async () => {
    const { host, loc } = await visit(404);
    expect(loc.history).not.toContain(CRM_CUSTOMERS_PATH);
    expect(host.querySelector('[data-testid="old-customers"]')).not.toBeNull();
  });
});
