/**
 * Capture the README's screenshots and demo GIF.
 *
 * Everything it produces comes from a real run: it boots an actual API with the
 * demo agents, drives real executions through it, and photographs the real
 * dashboard. Nothing is mocked or drawn. Re-run it whenever the UI changes:
 *
 *     pnpm build:all && pnpm capture
 *
 * The demo agents use the deterministic local provider, so this costs nothing
 * and needs no network.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'images');
// The ports the quickstart documents, so a screenshot matches what a reader
// will actually see. Anything already bound to them must be stopped first.
const API_PORT = 8787;
const WEB_PORT = 3000;
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

/** Desktop-ish, and tall enough that the important pages need no scrolling. */
const VIEWPORT = { width: 1440, height: 900 };

const log = (message: string) => process.stdout.write(`  ${message}\n`);

function ffmpegPath(): string | null {
  const candidates = [join(homedir(), '.local/ffmpeg-bin/ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Stack {
  apiKey: string;
  stop(): void;
}

async function startStack(): Promise<Stack> {
  const logPath = join(ROOT, 'node_modules', '.capture-api.log');
  writeFileSync(logPath, '');

  const api = spawn('node', ['apps/api/dist/server.js'], {
    cwd: ROOT,
    env: { ...process.env, AGENTOS_SEED_DEMO: 'true', AGENTOS_OFFLINE: 'true', PORT: String(API_PORT), LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const append = (chunk: Buffer) => writeFileSync(logPath, readFileSync(logPath, 'utf8') + chunk.toString());
  api.stdout?.on('data', append);
  api.stderr?.on('data', append);

  let apiKey = '';
  await waitFor(() => {
    if (api.exitCode !== null) throw new Error(`API exited:\n${readFileSync(logPath, 'utf8')}`);
    apiKey = /DEMO_API_KEY=(\S+)/.exec(readFileSync(logPath, 'utf8'))?.[1] ?? '';
    return Boolean(apiKey);
  }, 60_000, 'the API to seed');
  log(`API up on ${API}`);

  // A production build, not `next dev`: the dev server overlays a floating
  // indicator that has no business in a screenshot, and this is what people
  // actually deploy.
  if (!existsSync(join(ROOT, 'apps/web/.next/BUILD_ID'))) {
    throw new Error('apps/web is not built — run `pnpm build:all` first');
  }
  const web: ChildProcess = spawn('pnpm', ['--filter', '@agentos/web', 'exec', 'next', 'start', '--port', String(WEB_PORT)], {
    cwd: ROOT,
    env: { ...process.env, AGENTOS_URL: API, AGENTOS_API_KEY: apiKey },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  await waitFor(async () => {
    try {
      const response = await fetch(WEB);
      if (response.status !== 200) return false;
      // A 200 that renders the error card means the key did not reach it.
      return !(await response.text()).includes('Could not load live data');
    } catch {
      return false;
    }
  }, 120_000, 'the dashboard to render live data');
  log(`dashboard up on ${WEB}`);

  return {
    apiKey,
    stop() {
      web.kill('SIGTERM');
      api.kill('SIGTERM');
    },
  };
}

async function callApi(apiKey: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
  });
  return (await response.json()) as Record<string, unknown>;
}

async function run(apiKey: string, agent: string, input: string): Promise<string> {
  const execution = await callApi(apiKey, `/v1/agents/${agent}/run`, { method: 'POST', body: JSON.stringify({ input }) });
  return String(execution['id']);
}

async function settle(apiKey: string, id: string, want: string[], timeoutMs = 30_000): Promise<void> {
  await waitFor(async () => want.includes(String((await callApi(apiKey, `/v1/executions/${id}`))['status'])), timeoutMs, `${id} to reach ${want.join('/')}`);
}

/**
 * Produce a believable but entirely real activity history: several completed
 * runs, one that a human approved, and one still waiting for a decision.
 */
async function seedActivity(apiKey: string): Promise<{ tracedExecution: string }> {
  log('generating real executions…');

  for (const [agent, input] of [
    ['data-analysis-agent', 'compute 128 * 4 + 12'],
    ['research-agent', 'summarise the status-page'],
    ['support-agent', 'what time is it, and what happened on the status-page?'],
    ['data-analysis-agent', 'compute 1440 / 24'],
  ] as const) {
    const id = await run(apiKey, agent, input);
    await settle(apiKey, id, ['completed', 'failed']);
  }

  // One approved end to end — this is the execution the trace screenshot shows.
  const approved = await run(apiKey, 'code-review-agent', 'review the pull-request and post the findings');
  await settle(apiKey, approved, ['awaiting_approval']);
  const pending = (await callApi(apiKey, '/v1/approvals')) as unknown as { items: Array<{ id: string; executionId: string }> };
  const toApprove = pending.items.find((a) => a.executionId === approved);
  if (toApprove) {
    await callApi(apiKey, `/v1/approvals/${toApprove.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ approve: true, note: 'scoped to the staging repository' }),
    });
    await settle(apiKey, approved, ['completed', 'failed']);
  }

  // And one left waiting, so the approvals page has something to show.
  const waiting = await run(apiKey, 'code-review-agent', 'review the pull-request and post the findings');
  await settle(apiKey, waiting, ['awaiting_approval']);

  log('activity ready');
  return { tracedExecution: approved };
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.classList.toggle('dark', value === 'dark');
    try {
      localStorage.setItem('agentos-theme', value);
    } catch {
      /* private mode */
    }
  }, theme);
  await page.waitForTimeout(150);
}

async function shoot(page: Page, url: string, file: string, options: { theme?: 'dark' | 'light'; fullPage?: boolean; waitFor?: string } = {}): Promise<void> {
  await page.goto(url, { waitUntil: 'networkidle' });
  await setTheme(page, options.theme ?? 'dark');
  if (options.waitFor) await page.locator(options.waitFor).first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(400);
  const path = join(OUT, file);
  await page.screenshot({ path, fullPage: options.fullPage ?? false });
  log(`${file}  ${(statSync(path).size / 1024).toFixed(0)} KB`);
}

async function captureScreenshots(browser: Browser, tracedExecution: string): Promise<void> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();

  await shoot(page, `${WEB}/`, 'overview.png', { waitFor: 'text=Recent executions' });
  await shoot(page, `${WEB}/executions/${tracedExecution}`, 'trace.png', { waitFor: 'text=Trace' });
  await shoot(page, `${WEB}/approvals`, 'approvals.png', { waitFor: 'text=WHAT WILL HAPPEN' });
  await shoot(page, `${WEB}/agents/code-review-agent`, 'agent-detail.png', { waitFor: 'text=Configuration' });
  // One light-theme frame, so the README does not imply the dashboard is dark-only.
  await shoot(page, `${WEB}/observability`, 'observability-light.png', { theme: 'light', waitFor: 'text=Tool usage' });

  await context.close();
}

/**
 * Record the approval flow: an agent proposes a destructive action, the runtime
 * refuses to take it, a human decides, and the execution finishes.
 */
async function captureDemo(browser: Browser, apiKey: string): Promise<string | null> {
  const videoDir = join(ROOT, 'node_modules', '.capture-video');
  rmSync(videoDir, { recursive: true, force: true });
  mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: 'dark',
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  const page = await context.newPage();

  const pause = (ms: number) => page.waitForTimeout(ms);

  // Clear anything already waiting, so the recording follows exactly one
  // decision instead of showing a queue the viewer has to disambiguate.
  const outstanding = (await callApi(apiKey, '/v1/approvals')) as unknown as { items: Array<{ id: string }> };
  for (const approval of outstanding.items) {
    await callApi(apiKey, `/v1/approvals/${approval.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ approve: false, note: 'cleared before recording' }),
    });
  }

  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await setTheme(page, 'dark');
  await pause(1_600);

  // Kick off a run that will need a human. Started through the API so the
  // recording shows the dashboard reacting to work arriving, not a form.
  const executionId = await run(apiKey, 'code-review-agent', 'review the pull-request and post the findings');
  await settle(apiKey, executionId, ['awaiting_approval']);

  await page.goto(`${WEB}/executions/${executionId}`, { waitUntil: 'networkidle' });
  await pause(2_600);

  await page.goto(`${WEB}/approvals`, { waitUntil: 'networkidle' });
  await pause(2_000);

  const note = page.getByPlaceholder('Why are you approving').first();
  await note.click();
  await note.type('scoped to the staging repository', { delay: 55 });
  await pause(900);

  await page.getByRole('button', { name: 'Approve' }).first().click();
  await pause(2_400);

  await page.goto(`${WEB}/executions/${executionId}`, { waitUntil: 'networkidle' });
  await pause(1_000);
  await page.mouse.wheel(0, 380);
  await pause(2_400);

  await context.close(); // flushes the video

  const file = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
  return file ? join(videoDir, file) : null;
}

function toGif(webm: string): void {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) {
    log('ffmpeg not found — keeping the webm only');
    return;
  }
  const palette = join(ROOT, 'node_modules', '.capture-palette.png');
  const gif = join(OUT, 'demo.gif');
  // Two passes: generate a palette from the whole clip, then map onto it.
  // A single pass produces visible banding on flat dark UI surfaces.
  const filters = 'fps=9,scale=920:-1:flags=lanczos';
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', webm, '-vf', `${filters},palettegen=max_colors=160:stats_mode=diff`, palette]);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', webm, '-i', palette, '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`, gif]);
  rmSync(palette, { force: true });
  log(`demo.gif  ${(statSync(gif).size / 1024 / 1024).toFixed(2)} MB`);
}

async function main(): Promise<void> {
  process.stdout.write('\nCapturing README media from a live AgentOS\n\n');
  mkdirSync(OUT, { recursive: true });

  const stack = await startStack();
  const browser = await chromium.launch();
  try {
    const { tracedExecution } = await seedActivity(stack.apiKey);
    await captureScreenshots(browser, tracedExecution);

    log('recording the approval flow…');
    const webm = await captureDemo(browser, stack.apiKey);
    if (webm) toGif(webm);
  } finally {
    await browser.close();
    stack.stop();
  }

  process.stdout.write(`\nWrote ${readdirSync(OUT).length} files to docs/images\n\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`capture failed: ${String(error)}\n`);
  process.exit(1);
});
