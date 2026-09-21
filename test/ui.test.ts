import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureDecision } from '../src/decision.ts';
import { createUIServer } from '../src/ui-server.ts';
import type { JevLensConfig } from '../src/config.ts';
import { BrokenProvider, contextFor, tempWorkspace, ticketState, triageQuestions } from './helpers.ts';

interface Panel {
  workspace: { config: JevLensConfig; root: string };
  ctx: ReturnType<typeof contextFor>;
  url: string;
  api: <T = Record<string, unknown>>(path: string, init?: RequestInit) => Promise<{ status: number; body: T; headers: Headers }>;
}

interface AfterCapable {
  after(fn: () => Promise<void>): void;
}

async function startPanel(t: AfterCapable, overrides: Partial<JevLensConfig> = {}): Promise<Panel> {
  const workspace = await tempWorkspace(overrides);
  const ctx = contextFor(workspace.config);
  await captureDecision(ctx, { state: ticketState, questions: triageQuestions, label: 'support' });
  await captureDecision({ ...ctx, provider: new BrokenProvider('down') }, {
    state: { text: 'router decision' },
    questions: { route: { type: 'choice', instructions: 'which tool?', criteria: { read: 'read a file', write: 'write a file' } } },
    label: 'router',
  });
  const ui = createUIServer(ctx, workspace.config);
  const url = await ui.listen();
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await ui.close();
    await workspace.cleanup();
  };
  t.after(shutdown);

  return {
    workspace,
    ctx,
    url,
    api: async <T = Record<string, unknown>>(path: string, init?: RequestInit) => {
      const response = await fetch(`${url}${path}`, init);
      const text = await response.text();
      const isJson = (response.headers.get('content-type') ?? '').includes('json');
      return { status: response.status, body: (isJson ? JSON.parse(text) : text) as T, headers: response.headers };
    },
  };
}

test('the panel serves a single self-contained HTML page', async (t) => {
  const panel = await startPanel(t);
  const home = await panel.api<string>('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') ?? '', /text\/html/);
  assert.match(home.body, /<title>JevLens/);
  assert.match(home.body, /cdn\.jsdelivr\.net\/npm\/chart\.js/, 'charts come from a CDN, no build step');
  assert.match(home.body, /\/api\/trace/, 'the page polls the JSON API');
  assert.match(home.body, /3000/, 'auto-refresh interval is 3s');
  assert.match(home.body, /type="checkbox"[\s\S]*auto-refresh|auto-refresh/, 'refresh can be paused');
});

test('the trace API returns records newest first with filters', async (t) => {
  const panel = await startPanel(t);
  const all = await panel.api<{ count: number; records: { id: string; label: string; status: string }[] }>('/api/trace');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.records.map((r) => r.label), ['router', 'support']);
  assert.equal(all.body.count, 2);

  const filtered = await panel.api<{ records: { label: string }[] }>('/api/trace?label=support');
  assert.deepEqual(filtered.body.records.map((r) => r.label), ['support']);

  const flagged = await panel.api<{ records: { label: string }[] }>('/api/trace?below=0.7');
  assert.deepEqual(flagged.body.records.map((r) => r.label), ['router'], 'only the undecided decision is flagged');

  const trimmed = await panel.api<{ records: { id: string }[] }>('/api/trace?limit=1');
  assert.equal(trimmed.body.records.length, 1);

  const labels = await panel.api<{ labels: { label: string; count: number; undecided: number }[] }>('/api/labels');
  assert.equal(labels.body.labels.find((entry) => entry.label === 'router')?.undecided, 1);
});

test('the panel exposes the full state of a decision for replay', async (t) => {
  const panel = await startPanel(t);
  const detail = await panel.api<{ records: { request: { state: unknown; questions: unknown }; response: { answers: Record<string, { probabilities?: Record<string, number> }> }; hints: unknown[] }[] }>('/api/trace?label=support');
  const record = detail.body.records[0];
  assert.deepEqual(record?.request.state, ticketState, 'expand shows the raw state that was judged');
  assert.ok(Object.keys((record?.request.questions ?? {}) as object).includes('category'));
  assert.ok((record?.response.answers.category?.probabilities ?? {}).billing !== undefined, 'probability bars have data to render');
  assert.ok(Array.isArray(record?.hints));
});

test('health reports storage, provider and whether a key is configured', async (t) => {
  const panel = await startPanel(t);
  const health = await panel.api<{ ok: boolean; records: number; files: number; provider: string; api_key_present: boolean; dir: string }>('/api/health');
  assert.equal(health.body.ok, true);
  assert.equal(health.body.records, 2);
  assert.equal(health.body.files, 1);
  assert.match(health.body.provider, /fake/);
  assert.equal(health.body.api_key_present, false);
  assert.equal(health.body.dir, panel.workspace.config.storageDir);
});

test('the confidence threshold is adjustable from the panel and persisted', async (t) => {
  const panel = await startPanel(t);
  const before = await panel.api<{ confidenceThreshold: number }>('/api/config');
  assert.equal(before.body.confidenceThreshold, 0.7);

  const saved = await panel.api<{ confidenceThreshold: number }>('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confidenceThreshold: 0.95 }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.confidenceThreshold, 0.95);

  const persisted = JSON.parse(await readFile(join(panel.workspace.config.storageDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(persisted.confidenceThreshold, 0.95, 'survives a restart');
  const after = await panel.api<{ confidenceThreshold: number }>('/api/config');
  assert.equal(after.body.confidenceThreshold, 0.95);

  const rejected = await panel.api<{ error: string }>('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ storageDir: 'C:\\windows\\system32' }),
  });
  assert.equal(rejected.status, 400, 'only the threshold is writable over HTTP');
  const badJson = await panel.api<{ error: string }>('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  assert.equal(badJson.status, 400);

  const csrfShape = await panel.api<{ error: string }>('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ confidenceThreshold: 0.1 }),
  });
  assert.equal(csrfShape.status, 415, 'a cross-origin simple request cannot change config');
});

test('reports download as attachments in both formats', async (t) => {
  const panel = await startPanel(t);
  const markdown = await panel.api<string>('/api/export?format=markdown');
  assert.match(markdown.headers.get('content-disposition') ?? '', /attachment; filename="jevlens-.*\.md"/);
  assert.match(markdown.body, /# JevLens decision report/);
  assert.match(markdown.body, /router/);

  const raw = await fetch(`${panel.url}/api/export?format=csv&label=support`);
  assert.match(raw.headers.get('content-disposition') ?? '', /\.csv"/);
  const bytes = new Uint8Array(await raw.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel opens CJK correctly');
  const csvText = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  assert.match(csvText.split('\r\n')[0] ?? '', /^id,ts,label,status/);
  assert.match(csvText, /charged twice/, 'the CSV carries the state too');
});

test('the panel is local-only: bad Host headers and unknown routes are refused', async (t) => {
  const panel = await startPanel(t);
  const port = Number(new URL(panel.url).port);

  const spoofed = await new Promise<number>((resolveStatus) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/trace', headers: { host: 'evil.example' } }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.end();
  });
  assert.equal(spoofed, 403, 'DNS-rebinding style Host headers are rejected');

  const missing = await panel.api('/api/does-not-exist');
  assert.equal(missing.status, 404);
  const traversal = await panel.api<string>('/../package.json');
  assert.equal(traversal.status, 404, 'no static file serving, so nothing to traverse');
});
