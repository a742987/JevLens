import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cliEntry } from './helpers.ts';

async function withServer(): Promise<{ client: Client; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'jevlens-stdio-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, 'mcp'],
    cwd: dir,
    env: { ...process.env, JEVLENS_DIR: join(dir, '.jevlens'), TYPESAFE_API_KEY: '', JEVLENS_MOCK: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, dir, cleanup: async () => { await client.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('the CLI entry resolves to a file that can actually be spawned', () => {
  assert.ok(existsSync(cliEntry), `missing CLI entry: ${cliEntry}`);
});

test('a real MCP client over stdio can list, call and read back', async () => {
  const { client, dir, cleanup } = await withServer();
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['jev_ask', 'jev_export', 'jev_trace']);
    const info = await client.getServerVersion();
    assert.equal(info?.name, 'jevlens');
    assert.ok((info?.version ?? '').length > 3, 'the server reports its package version');

    const ask = await client.callTool({
      name: 'jev_ask',
      arguments: {
        label: 'triage',
        state: { message: 'I was charged twice, please fix this today' },
        questions: {
          category: { type: 'choice', instructions: 'What is this about?', criteria: { billing: 'money', technical: 'broken', other: null } },
          urgency: { type: 'score', instructions: 'How urgent?', criteria: ['routine', 'soon', 'right now'] },
        },
      },
    });
    const text = ((ask as { content?: { text?: string }[] }).content ?? [])[0]?.text ?? '{}';
    const payload = JSON.parse(text) as { status: string; answers: Record<string, unknown>; confidence: { min: number } };
    assert.equal(payload.status, 'answered');
    assert.ok(payload.answers.category, 'answers come back to the agent');

    const trace = await client.callTool({ name: 'jev_trace', arguments: { limit: 3 } });
    const records = JSON.parse(((trace as { content: { text: string }[] }).content[0]?.text ?? '{}')).records as { label: string }[];
    assert.equal(records.length, 1);
    assert.equal(records[0]?.label, 'triage');

    const listing = await import('node:fs/promises').then((fs) => fs.readdir(join(dir, '.jevlens')));
    assert.ok(listing.some((name) => /^trace-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)), `JSONL written next to the project: ${listing.join(', ')}`);
    const line = await readFile(join(dir, '.jevlens', listing.find((name) => name.endsWith('.jsonl')) ?? ''), 'utf8');
    assert.match(line, /"label":"triage"/);
  } finally {
    await cleanup();
  }
});

test('the stdio server exits cleanly when the client disconnects', async () => {
  const { client, cleanup } = await withServer();
  const closed = client.close();
  await closed;
  await cleanup();
  assert.ok(true, 'no dangling process or unhandled rejection');
});
