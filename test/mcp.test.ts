import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp-server.ts';
import { captureDecision, createContext } from '../src/decision.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { contextFor, FakeProvider, tempWorkspace, ticketState, triageQuestions } from './helpers.ts';

interface Session {
  client: Client;
  text: (result: unknown) => Record<string, unknown>;
}

async function connect(): Promise<{ session: Session; cleanup: () => Promise<void>; ctx: ReturnType<typeof contextFor> }> {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  const server = buildServer(ctx, { agent: 'test-harness@1.0' });
  const client = new Client({ name: 'unit-test-client', version: '0.0.0' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return {
    ctx,
    session: {
      client,
      text: (result) => {
        const content = (result as { content?: { text?: string }[] }).content ?? [];
        return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
      },
    },
    cleanup: workspace.cleanup,
  };
}

test('the MCP server advertises exactly the three documented tools', async () => {
  const { session, cleanup } = await connect();
  const tools = await session.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['jev_ask', 'jev_export', 'jev_trace']);
  const ask = tools.tools.find((tool) => tool.name === 'jev_ask');
  assert.ok(ask && ask.description && ask.description.length > 40, 'each tool is documented for the agent');
  assert.ok(ask && 'state' in (ask.inputSchema.properties ?? {}), 'zod v4 schemas reach the client as JSON Schema');
  assert.ok(ask && 'questions' in (ask.inputSchema.properties ?? {}));
  const info = await session.client.getServerVersion();
  assert.equal(info?.name, 'jevlens');
  await cleanup();
});

test('jev_ask answers and records in one call', async () => {
  const { session, ctx, cleanup } = await connect();
  const result = await session.client.callTool({
    name: 'jev_ask',
    arguments: { state: ticketState, questions: triageQuestions, label: 'triage' },
  });
  const payload = session.text(result);
  assert.equal(payload.status, 'answered');
  assert.equal(payload.label, 'triage');
  assert.equal(payload.model, 'jev-fake-1');
  assert.equal((payload.answers as Record<string, unknown>).category ? 'choice' : '', 'choice');
  assert.ok((payload.confidence as { min: number }).min > 0.7);
  assert.ok(typeof payload.id === 'string');
  assert.equal(payload.error, null);
  assert.match(String(ctx.provider.note), /fake/);

  const trace = await session.client.callTool({ name: 'jev_trace', arguments: { limit: 5 } });
  const records = session.text(trace).records as { label: string; agent: string; answers: unknown }[];
  assert.equal(records.length, 1);
  assert.equal(records[0]?.label, 'triage');
  assert.equal(records[0]?.agent, 'test-harness@1.0', 'the calling harness is attributed');
  await cleanup();
});

test('jev_ask is fail-open over the wire and jev_trace can surface only flagged records', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  const { BrokenProvider } = await import('./helpers.ts');
  const server = buildServer(ctx, { agent: 'test-harness' });
  const client = new Client({ name: 'unit-test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);

  ctx.provider = new BrokenProvider('simulated outage');
  const outage = await client.callTool({
    name: 'jev_ask',
    arguments: { state: 'anything', questions: { mood: { type: 'noul', instructions: 'is the user angry?' } }, label: 'outage' },
  });
  const payload = JSON.parse((outage.content as { text: string }[])[0]?.text ?? '{}') as Record<string, unknown>;
  assert.notEqual(outage.isError, true, 'an outage is a normal answer shape, not a tool error');
  assert.equal(payload.status, 'undecided');
  assert.equal((payload.error as { message: string }).message.includes('simulated'), false);
  assert.match((payload.error as { message: string }).message, /ECONNREFUSED/);
  assert.ok(payload.answers, 'the agent still receives an answer for every question');

  const flagged = await client.callTool({ name: 'jev_trace', arguments: { below_threshold: 0.7 } });
  const flaggedRecords = (JSON.parse((flagged.content as { text: string }[])[0]?.text ?? '{}').records ?? []) as { label: string }[];
  assert.deepEqual(flaggedRecords.map((r) => r.label), ['outage']);
  await workspace.cleanup();
});

test('jev_ask rejects malformed questions before spending an API call', async () => {
  const { session, ctx, cleanup } = await connect();
  const callsBefore = (ctx.provider as unknown as { calls: unknown[] }).calls.length;
  const bad = await session.client.callTool({
    name: 'jev_ask',
    arguments: { state: {}, questions: { oops: { type: 'multiple-choice', criteria: {} } } },
  });
  assert.equal(bad.isError, true, 'schema violations are reported to the agent');
  assert.equal((ctx.provider as unknown as { calls: unknown[] }).calls.length, callsBefore, 'no Jev call was made');

  const empty = await session.client.callTool({ name: 'jev_ask', arguments: { state: {}, questions: {} } });
  assert.equal(empty.isError, true, 'an empty question map is refused');
  await cleanup();
});

test('question quality hints come back with the answer', async () => {
  const { session, cleanup } = await connect();
  const result = await session.client.callTool({
    name: 'jev_ask',
    arguments: {
      state: 'user is upset',
      questions: {
        bucket: {
          type: 'choice',
          instructions: 'Which bucket?',
          criteria: { bug_report: 'report a bug', bug_reports: 'report bugs found in the product' },
        },
        heat: { type: 'score', instructions: 'how hot', criteria: ['cold', 'hot'] },
      },
    },
  });
  const hints = session.text(result).hints as { code: string }[];
  const codes = hints.map((hint) => hint.code);
  assert.ok(codes.includes('choice.overlap'), `overlap reported, got ${codes.join(',')}`);
  assert.ok(codes.includes('score.range_narrow'));
  await cleanup();
});

test('jev_export writes a report and returns its path', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  const server = buildServer(ctx);
  const client = new Client({ name: 'unit-test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);

  await client.callTool({ name: 'jev_ask', arguments: { state: ticketState, questions: triageQuestions, label: 'support' } });
  const exported = await client.callTool({ name: 'jev_export', arguments: { format: 'markdown' } });
  const payload = JSON.parse((exported.content as { text: string }[])[0]?.text ?? '{}') as { path: string; records: number; format: string };
  assert.equal(payload.format, 'markdown');
  assert.equal(payload.records, 1);
  assert.match(payload.path, /jevlens-.*\.md$/);
  const body = await readFile(payload.path, 'utf8');
  assert.match(body, /# JevLens decision report/);
  assert.match(body, /## 1\. `support`/);
  assert.ok(body.includes('charged twice'), 'the report is self-contained for a bug report');

  const csv = await client.callTool({ name: 'jev_export', arguments: { format: 'csv', label: 'support' } });
  const csvPayload = JSON.parse((csv.content as { text: string }[])[0]?.text ?? '{}') as { path: string };
  const csvBody = await readFile(csvPayload.path, 'utf8');
  assert.match(csvBody, /^id,ts,label,status/);
  await workspace.cleanup();
});

test('jev_export refuses to write outside the workspace', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  const server = buildServer(ctx);
  const client = new Client({ name: 'unit-test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);

  await client.callTool({ name: 'jev_ask', arguments: { state: ticketState, questions: triageQuestions, label: 'support' } });

  // The tool is callable by a model that has just read untrusted text, so an
  // arbitrary absolute path would be an arbitrary file overwrite.
  const outside = join(workspace.root, '..', 'jevlens-escape.md');
  const refused = await client.callTool({ name: 'jev_export', arguments: { path: outside } });
  assert.equal(refused.isError, true, 'a path above the workspace is refused');
  const message = (JSON.parse((refused.content as { text: string }[])[0]?.text ?? '{}') as { error: string }).error;
  assert.match(message, /refusing to write outside the workspace/);
  assert.equal(existsSync(outside), false, 'nothing was created');

  const target = join(workspace.config.storageDir, 'exports', 'bug-report.md');
  const allowed = await client.callTool({ name: 'jev_export', arguments: { path: target } });
  assert.notEqual(allowed.isError, true, 'the trace directory stays writable');
  assert.ok(existsSync(target));
  await workspace.cleanup();
});

test('run ids group the decisions belonging to one agent run', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  const server = buildServer(ctx, { agent: 'test-harness', runId: 'session-fallback' });
  const client = new Client({ name: 'unit-test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);

  const first = await client.callTool({
    name: 'jev_ask',
    arguments: { state: ticketState, questions: triageQuestions, label: 'support', run_id: 'run-42' },
  });
  const explicit = JSON.parse((first.content as { text: string }[])[0]?.text ?? '{}') as { run_id: string; id: string };
  assert.equal(explicit.run_id, 'run-42', 'an explicit run id is echoed back to the agent');

  const second = await client.callTool({ name: 'jev_ask', arguments: { state: 'next step', questions: triageQuestions } });
  const inherited = JSON.parse((second.content as { text: string }[])[0]?.text ?? '{}') as { run_id: string; id: string };
  assert.equal(inherited.run_id, 'session-fallback', 'without one, the session is used');

  const byRun = await client.callTool({ name: 'jev_trace', arguments: { run_id: 'run-42' } });
  const runRecords = (JSON.parse((byRun.content as { text: string }[])[0]?.text ?? '{}').records ?? []) as { id: string }[];
  assert.deepEqual(runRecords.map((record) => record.id), [explicit.id]);

  const byId = await client.callTool({ name: 'jev_trace', arguments: { id: inherited.id } });
  const single = (JSON.parse((byId.content as { text: string }[])[0]?.text ?? '{}').records ?? []) as { id: string }[];
  assert.deepEqual(single.map((record) => record.id), [inherited.id], 'one decision can be fetched by trace id');
  await workspace.cleanup();
});

test('JEVLENS_RUN_ID from the environment labels every decision', async () => {
  const workspace = await tempWorkspace();
  const ctx = createContext(workspace.config, { JEVLENS_RUN_ID: 'from-env' }, new FakeProvider());
  assert.equal((await captureDecision(ctx, { state: 'x', questions: triageQuestions })).record.runId, 'from-env');
  const overridden = await captureDecision(ctx, { state: 'x', questions: triageQuestions, runId: 'explicit' });
  assert.equal(overridden.record.runId, 'explicit', 'the call wins over the environment');
  assert.equal((await captureDecision(ctx, { state: 'x', questions: triageQuestions, runId: '  ' })).record.runId, 'from-env', 'blank is not a run id');
  await workspace.cleanup();
});
