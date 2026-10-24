import { expect, test, type Page } from '@playwright/test';

// Core flows on the real app with the `mock` runtime (agent `demo`). No CLI or API key needed.

const CORE_PAGES = ['/', '/agents', '/tasks', '/schedules', '/chat', '/brain', '/memory', '/skills', '/modules', '/connections', '/audit', '/settings', '/usage', '/budgets', '/teams', '/agent-market', '/recos'];

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('every core page renders without script errors', async ({ page }) => {
  const errors = trackErrors(page);
  for (const path of CORE_PAGES) {
    await page.goto(path);
    await expect(page.locator('#app')).not.toBeEmpty();
    await page.waitForTimeout(400);
  }
  expect(errors).toEqual([]);
});

test('a task given to the demo agent runs to "done" and shows its result', async ({ page, request }) => {
  const res = await request.post('/api/tasks', { data: { agentId: 'demo', title: 'E2E: kiểm tra', prompt: 'Viết một câu chào đội.' } });
  expect(res.ok()).toBeTruthy();
  const task = await res.json();
  await expect
    .poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).task.status, { timeout: 30_000 })
    .toBe('done');
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText('Đã xử lý').first()).toBeVisible();
});

test('delegation: demo hands work to another mock agent and summarises when it is done', async ({ request }) => {
  // The sample `main` runs on Claude, so create a throw-away mock helper (the e2e agents dir is a temp copy).
  const created = await request.post('/api/agents', { data: { id: 'e2e-helper', name: 'Trợ lý e2e', runtime: 'mock', description: 'Agent mock cho e2e' } });
  expect(created.status()).toBe(201);
  const res = await request.post('/api/tasks', { data: { agentId: 'demo', prompt: 'Chia việc. #delegate:e2e-helper' } });
  const task = await res.json();
  await expect
    .poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).task.status, { timeout: 30_000 })
    .toBe('done');
  const detail = await (await request.get(`/api/tasks/${task.id}`)).json();
  expect(detail.children).toHaveLength(1);
  expect(detail.children[0]).toMatchObject({ agentId: 'e2e-helper', status: 'done' });
  expect(detail.runs.length).toBe(2); // assigned run + children_done summary run
});

test('modules: add care from the UI, its menu appears, remove hides it and keeps data', async ({ page, request }) => {
  const errors = trackErrors(page);
  await page.goto('/modules');
  // nearest ancestor of the card title that contains a button = the module card
  const card = page.getByText('Chăm sóc khách hàng', { exact: true }).first().locator('xpath=ancestor::*[.//button][1]');
  await card.getByRole('button', { name: /Thêm/ }).click();
  await page.getByRole('button', { name: 'Thêm module' }).click();
  await expect.poll(async () => (await (await request.get('/api/modules/care')).json()).state.enabled, { timeout: 20_000 }).toBe(true);
  await page.goto('/m/care/inbox');
  await expect(page.getByText('Hộp thư').first()).toBeVisible();

  const removed = await request.post('/api/modules/care/remove');
  expect(removed.ok()).toBeTruthy();
  expect((await (await request.get('/api/modules/care')).json()).state.enabled).toBe(false);
  expect((await request.get('/api/m/care/accounts')).status()).toBe(404);
  expect(errors).toEqual([]);
});

test('agent detail shows the access tab with enforcement badges', async ({ page }) => {
  await page.goto('/agents/main');
  await page.getByRole('button', { name: /Quyền/ }).or(page.getByRole('tab', { name: /Quyền/ })).first().click();
  await expect(page.getByText(/Chặn cứng|Chỉ dặn trong prompt/).first()).toBeVisible();
});

test('P5 modules: add finance, radar, video and kol, their pages render without script errors', async ({ page, request }) => {
  const errors = trackErrors(page);
  const pages: Record<string, string[]> = {
    finance: ['/m/finance/pnl', '/m/finance/business-model', '/m/finance/ledger', '/m/finance/erp'],
    radar: ['/m/radar'],
    video: ['/m/video'],
    kol: ['/m/kol'],
  };
  for (const [id, paths] of Object.entries(pages)) {
    const added = await request.post(`/api/modules/${id}/add`, { data: { installAgents: false } });
    // kol needs a Composio connection; a machine without one can't add it
    if (!added.ok() && id === 'kol') continue;
    expect(added.ok(), `add ${id}`).toBeTruthy();
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator('#app')).not.toBeEmpty();
      await expect(page.getByText('Không tìm thấy trang')).toHaveCount(0);
      await page.waitForTimeout(400);
    }
    await request.post(`/api/modules/${id}/remove`);
  }
  expect(errors).toEqual([]);
});
