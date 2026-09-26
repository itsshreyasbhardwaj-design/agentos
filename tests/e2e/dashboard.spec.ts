import { expect, test } from '@playwright/test';

const API = () => process.env['AGENTOS_URL'] ?? 'http://127.0.0.1:8788';
const KEY = () => process.env['AGENTOS_API_KEY'] ?? '';

async function apiFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY()}`,
      ...(init.headers ?? {}),
    },
  });
  return response.json() as Promise<Record<string, never>>;
}

test.describe('dashboard', () => {
  test('overview shows real data and navigates', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await expect(page.getByText('No sample data')).toBeVisible();

    await page.getByRole('link', { name: 'Agents' }).first().click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole('link', { name: 'Research Agent' })).toBeVisible();
  });

  test('agent detail shows the enforced configuration', async ({ page }) => {
    await page.goto('/agents/code-review-agent');
    await expect(page.getByRole('heading', { name: 'Code Review Agent' })).toBeVisible();
    await expect(page.getByText('Configuration')).toBeVisible();
    // The permissions the runtime will actually enforce.
    await expect(page.getByText('demo.post_review').first()).toBeVisible();
    await expect(page.getByText('published v1')).toBeVisible();
  });

  test('an execution appears with a trace built from its events', async ({ page }) => {
    const execution = await apiFetch('/v1/agents/data-analysis-agent/run', {
      method: 'POST',
      body: JSON.stringify({ input: 'compute 12 * 12' }),
    });
    const id = execution['id'] as unknown as string;

    await expect
      .poll(async () => (await apiFetch(`/v1/executions/${id}`))['status'], { timeout: 30_000 })
      .toBe('completed');

    await page.goto(`/executions/${id}`);
    await expect(page.getByText('completed').first()).toBeVisible();
    await expect(page.getByText('Trace')).toBeVisible();
    await expect(page.getByText('reconstructed from')).toBeVisible();
    await expect(page.getByText('math.evaluate').first()).toBeVisible();
  });

  test('approving from the dashboard resumes a paused execution', async ({ page }) => {
    const execution = await apiFetch('/v1/agents/code-review-agent/run', {
      method: 'POST',
      body: JSON.stringify({ input: 'review the pull-request and post the findings' }),
    });
    const id = execution['id'] as unknown as string;

    await expect
      .poll(async () => (await apiFetch(`/v1/executions/${id}`))['status'], { timeout: 30_000 })
      .toBe('awaiting_approval');

    await page.goto('/approvals');
    await expect(page.getByText('demo.post_review').first()).toBeVisible();
    await expect(page.getByText('destructive').first()).toBeVisible();
    // The operator is told what will happen before deciding.
    await expect(page.getByText('WHAT WILL HAPPEN')).toBeVisible();

    await page.getByPlaceholder('Why are you approving').first().fill('approved by the e2e test');
    await page.getByRole('button', { name: 'Approve' }).first().click();

    await expect
      .poll(async () => (await apiFetch(`/v1/executions/${id}`))['status'], { timeout: 30_000 })
      .toBe('completed');

    const finished = await apiFetch(`/v1/executions/${id}`);
    expect((finished['usage'] as unknown as { approvals: number }).approvals).toBe(1);
  });

  test('theme toggle switches and persists', async ({ page }) => {
    await page.goto('/');
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
    const before = await isDark();

    await page.getByRole('button', { name: /Switch to (light|dark) theme/ }).click();
    expect(await isDark()).toBe(!before);

    await page.reload();
    expect(await isDark()).toBe(!before);
  });

  test('command palette opens and jumps', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    await page.getByLabel('Search commands').fill('executions');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/executions$/);
  });

  test('an unknown execution renders the not-found state', async ({ page }) => {
    await page.goto('/executions/exec_does_not_exist');
    await expect(page.getByText('Not found')).toBeVisible();
  });

  test('the tools page marks destructive tools', async ({ page }) => {
    await page.goto('/tools');
    const row = page.locator('tr', { hasText: 'http.delete' });
    // `exact` matters: the tool's own description also contains the word.
    await expect(row.getByText('destructive', { exact: true })).toBeVisible();
    await expect(row.getByText('delete', { exact: true })).toBeVisible();
  });
});
