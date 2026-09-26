#!/usr/bin/env node
import { createClient } from '@agentos/sdk';
import { startStdioServer } from './server.js';

const baseUrl = process.env['AGENTOS_URL'] ?? 'http://127.0.0.1:8787';
const apiKey = process.env['AGENTOS_API_KEY'];

if (!apiKey) {
  process.stderr.write('AGENTOS_API_KEY is required\n');
  process.exit(1);
}

startStdioServer(createClient({ baseUrl, apiKey })).catch((error: unknown) => {
  process.stderr.write(`agentos mcp server failed: ${String(error)}\n`);
  process.exit(1);
});
