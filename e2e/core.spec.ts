import { expect, test, type Page } from '@playwright/test';

// Core flows on the real app with the `mock` runtime (AIOS_MOCK=1; agent `e2e-demo`, created below). No GenBot needed.

const CORE_PAGES = ['/', '/bots', '/tasks', '/schedules', '/chat', '/brain', '/memory', '/skills', '/modules', '/connections', '/audit', '/settings', '/usage', '/budgets', '/teams', '/recos'];

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

// The shipped agents are GenBot bots with no key; tasks here run on a throw-away mock agent (the agents dir is a temp copy).
test.beforeAll(async ({ request }) => {
  const res = await request.post('/api/agents', { data: { id: 'e2e-demo', name: 'Agent e2e', runtime: 'mock', description: 'Agent mock cho e2e', canDelegate: true } });
  expect([201, 409]).toContain(res.status());
});

test('/agents and the old /agent-market lead to Đội AI · Bot', async ({ page }) => {
  for (const path of ['/agents', '/agent-market']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/bots$/);
  }
});

test('every core page renders without script errors', async ({ page }) => {
  const errors = trackErrors(page);
  for (const path of CORE_PAGES) {
    await page.goto(path);
    await expect(page.locator('#app')).not.toBeEmpty();
    await page.waitForTimeout(400);
  }
  expect(errors).toEqual([]);
});

test('a task given to the e2e-demo agent runs to "done" and shows its result', async ({ page, request }) => {
  const res = await request.post('/api/tasks', { data: { agentId: 'e2e-demo', title: 'E2E: kiểm tra', prompt: 'Viết một câu chào đội.' } });
  expect(res.ok()).toBeTruthy();
  const task = await res.json();
  await expect
    .poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).task.status, { timeout: 30_000 })
    .toBe('done');
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByText('Đã xử lý').first()).toBeVisible();
});

test('delegation: e2e-demo hands work to another mock agent and summarises when it is done', async ({ request }) => {
  const created = await request.post('/api/agents', { data: { id: 'e2e-helper', name: 'Trợ lý e2e', runtime: 'mock', description: 'Agent mock cho e2e' } });
  expect(created.status()).toBe(201);
  const res = await request.post('/api/tasks', { data: { agentId: 'e2e-demo', prompt: 'Chia việc. #delegate:e2e-helper' } });
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
  await page.goto('/agents/e2e-demo');
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

test('Tổng quan: period switch and business sections from enabled modules, no agent list', async ({ page, request }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await expect(page.getByRole('radio', { name: '30 ngày' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Chưa có số liệu kinh doanh')).toBeVisible();
  await expect(page.getByText('Agents & công việc')).toHaveCount(0);

  expect((await request.post('/api/modules/marketing/add', { data: { installAgents: false } })).ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('heading', { name: /Hiệu quả nội dung/ })).toBeVisible();
  await page.getByRole('radio', { name: '7 ngày' }).click();
  await expect(page.getByRole('radio', { name: '7 ngày' })).toHaveAttribute('aria-checked', 'true');
  await request.post('/api/modules/marketing/remove');
  expect(errors).toEqual([]);
});
