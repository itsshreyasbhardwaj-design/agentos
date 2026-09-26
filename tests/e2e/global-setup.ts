import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_PORT = 8788;
const WEB_PORT = 3100;

/**
 * Start the API, then the dashboard pointed at it.
 *
 * Both are launched here rather than through Playwright's `webServer` because
 * the dashboard needs the API's key in its environment at startup, and the API
 * only prints that key once it has finished seeding — an ordering `webServer`
 * cannot express, since it starts before global setup runs.
 */
function tail(child: ChildProcess, logPath: string): void {
  child.stdout?.on('data', (chunk: Buffer) => appendFileSync(logPath, chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => appendFileSync(logPath, chunk.toString()));
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const logDir = mkdtempSync(join(tmpdir(), 'agentos-e2e-'));
  const apiLog = join(logDir, 'api.log');
  const webLog = join(logDir, 'web.log');
  writeFileSync(apiLog, '');
  writeFileSync(webLog, '');

  const api = spawn('node', ['apps/api/dist/server.js'], {
    env: {
      ...process.env,
      AGENTOS_SEED_DEMO: 'true',
      AGENTOS_OFFLINE: 'true',
      PORT: String(API_PORT),
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tail(api, apiLog);

  let apiKey = '';
  await waitFor(
    () => {
      if (api.exitCode !== null) throw new Error(`API exited early:\n${readFileSync(apiLog, 'utf8')}`);
      const match = /DEMO_API_KEY=(\S+)/.exec(readFileSync(apiLog, 'utf8'));
      if (match?.[1]) apiKey = match[1];
      return Boolean(apiKey);
    },
    60_000,
    `the API to seed and print its key (${apiLog})`,
  );

  const apiUrl = `http://127.0.0.1:${API_PORT}`;
  process.env['AGENTOS_URL'] = apiUrl;
  process.env['AGENTOS_API_KEY'] = apiKey;

  const web = spawn('pnpm', ['--filter', '@agentos/web', 'exec', 'next', 'dev', '--port', String(WEB_PORT)], {
    env: { ...process.env, AGENTOS_URL: apiUrl, AGENTOS_API_KEY: apiKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tail(web, webLog);

  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${WEB_PORT}/`);
        // Wait for a real render, not just a listening socket: a 500 here means
        // the dashboard started without its key.
        return response.status === 200;
      } catch {
        return false;
      }
    },
    120_000,
    `the dashboard to serve a page (${webLog})`,
  );

  return async () => {
    web.kill('SIGTERM');
    api.kill('SIGTERM');
  };
}
