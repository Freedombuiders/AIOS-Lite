import { expect, test } from '@playwright/test';

// T07: the Zalo inbox on the care inbox page, with a fake connector (e2e/support/care-fake-server.ts):
//   a customer message arrives -> the bot drafts -> the draft shows above the composer -> Gửi -> the reply appears on the right.

const CONTROL = `http://127.0.0.1:${Number(process.env.AIOS_CARE_E2E_PORT ?? 4398) + 1}`;
const API = `http://127.0.0.1:${Number(process.env.AIOS_CARE_E2E_PORT ?? 4398)}`;

test.use({ baseURL: API });

test('message arrives, draft shows, Gửi, the reply appears on the right', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/m/care/inbox');
  await expect(page.getByTestId('care-inbox')).toBeVisible();
  // the command bar is hidden on this page: it has its own composer
  await expect(page.locator('.cmdbar')).toHaveCount(0);

  // the customer writes (the fake connector hands the message to care exactly like a real channel would)
  const arrived = await request.post(`${CONTROL}/inbound`, { data: { text: 'Shop có bán sỉ không em? #json' } });
  expect(arrived.ok()).toBeTruthy();
  expect((await arrived.json()).outcome).toBe('stored');

  // the row appears with the server-computed label: the bot drafted, so it waits for the owner
  const row = page.locator('.care-row.care-conv', { hasText: 'Chị Lan' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId('care-state-chip')).toHaveText('Chờ bạn duyệt', { timeout: 30_000 });

  await row.click();
  // history on the left of the bubble: the customer's message
  await expect(page.locator('.care-msg.is-incoming', { hasText: 'Shop có bán sỉ không em?' })).toBeVisible();

  // the draft sits above the composer with why it stopped, and the three actions
  const draft = page.getByTestId('care-inline-draft');
  await expect(draft).toBeVisible({ timeout: 30_000 });
  await expect(draft).toContainText('Dạ, em đã nhận được tin nhắn ạ.');
  await expect(page.getByTestId('care-draft-why')).toContainText('Bot dừng lại vì');
  await expect(page.getByTestId('care-draft-send')).toHaveText('Gửi');
  await expect(page.getByTestId('care-draft-edit')).toHaveText('Sửa rồi gửi');
  await expect(page.getByTestId('care-draft-discard')).toHaveText('Bỏ');

  // the bot column: draft mode on the whole nick, the rules, the run that made the draft
  await expect(page.getByTestId('care-bot-panel')).toBeVisible();
  await expect(page.getByTestId('care-bot-mode-draft')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('care-run-log')).toContainText('Soạn nháp, chờ bạn duyệt');

  // Gửi: the exact revision is approved, the fake provider is asked to send once
  await page.getByTestId('care-draft-send').click();
  await expect.poll(async () => (await (await request.get(`${CONTROL}/state`)).json()).providerSendCount, { timeout: 30_000 }).toBe(1);

  // the sent reply shows on the right (outgoing side) and the draft is gone
  await expect(page.locator('.care-msg.is-outgoing', { hasText: 'Dạ, em đã nhận được tin nhắn ạ.' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('care-inline-draft')).toHaveCount(0);
  await expect(row.getByTestId('care-state-chip')).not.toHaveText('Chờ bạn duyệt');

  expect(errors).toEqual([]);
});
