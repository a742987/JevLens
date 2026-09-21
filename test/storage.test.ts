import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS, loadConfig, saveConfig } from '../src/config.ts';
import { TraceStore, dateKey } from '../src/storage.ts';
import { scrub, secretValues } from '../src/sanitize.ts';
import type { Questions, TraceRecord } from '../src/types.ts';
import { tempWorkspace, triageQuestions } from './helpers.ts';

function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: `rec-${Math.random().toString(36).slice(2, 10)}`,
    ts: new Date().toISOString(),
    label: 'support',
    status: 'answered',
    provider: 'live',
    latencyMs: 420,
    request: { state: { subject: 'charged twice' }, questions: triageQuestions as Questions },
    response: {
      model: 'jev-1',
      answers: {
        category: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, technical: 0.08, other: 0.02 } },
      },
      usage: { input_tokens: 100, output_tokens: 5 },
    },
    confidence: { min: 0.9, mean: 0.9, perQuestion: { category: 0.9 }, belowThreshold: [] },
    hints: [],
    error: null,
    agent: 'claude-code',
    ...overrides,
  };
}

test('appends one JSON line per decision and reads newest first', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 100);
  const now = Date.now();
  const first = makeRecord({ id: 'a', ts: new Date(now - 5000).toISOString() });
  const second = makeRecord({ id: 'b', ts: new Date(now - 1000).toISOString() });
  await store.append(first);
  await store.append(second);

  const raw = await readFile(join(workspace.config.storageDir, `trace-${dateKey()}.jsonl`), 'utf8');
  assert.equal(raw.trimEnd().split('\n').length, 2, 'one line per record');

  const records = await store.read({ limit: 10 });
  assert.deepEqual(records.map((r) => r.id), ['b', 'a'], 'newest first');
  assert.equal(records[0]?.file, `trace-${dateKey()}.jsonl`);
  assert.equal(records[0]?.request.questions.category?.type, 'choice', 'questions round-trip');
  await workspace.cleanup();
});

test('splits files by day so a trace file stays greppable', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 100);
  await store.append(makeRecord({ id: 'jan1', ts: '2026-01-01T09:00:00.000Z' }));
  await store.append(makeRecord({ id: 'jan2', ts: '2026-01-02T09:00:00.000Z' }));
  const names = (await store.files()).map((file) => file.name);
  assert.equal(names.length, 2, `one file per day, got ${names.join(', ')}`);
  assert.deepEqual((await store.read({ limit: 10 })).map((r) => r.id), ['jan2', 'jan1']);
  await workspace.cleanup();
});

test('filters by label, offset and threshold', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 100);
  await store.append(makeRecord({ id: 'x', label: 'support', ts: '2026-01-01T00:00:01Z' }));
  await store.append(makeRecord({ id: 'y', label: 'router', ts: '2026-01-01T00:00:02Z' }));
  await store.append(
    makeRecord({ id: 'z', label: 'support', ts: '2026-01-01T00:00:03Z', status: 'undecided', confidence: { min: 0, mean: 0, perQuestion: {}, belowThreshold: ['category'] } }),
  );

  assert.deepEqual((await store.read({ label: 'support' })).map((r) => r.id), ['z', 'x']);
  assert.deepEqual((await store.read({ offset: 1, limit: 1 })).map((r) => r.id), ['y']);
  assert.deepEqual((await store.read({ belowThreshold: 0.7 })).map((r) => r.id), ['z']);
  assert.deepEqual((await store.read({ since: '2026-01-01T00:00:02.000Z' })).map((r) => r.id), ['z', 'y']);

  const stripped = await store.read({ limit: 1, includePayload: false });
  assert.deepEqual(stripped[0]?.request.state, { _omitted: true, keys: ['subject'] });
  assert.equal(stripped[0]?.request.questions.category.type, 'choice', 'question definitions stay available');

  const labels = await store.labels(0.7);
  const support = labels.find((entry) => entry.label === 'support');
  assert.equal(support?.count, 2);
  assert.equal(support?.undecided, 1);
  await workspace.cleanup();
});

test('rotates to a new file once the record cap is reached', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 2);
  const today = dateKey();
  const base = Date.now() - 60_000;
  for (let i = 0; i < 5; i += 1) await store.append(makeRecord({ id: `r${i}`, ts: new Date(base + i * 1000).toISOString() }));

  const names = (await store.files()).map((file) => file.name);
  assert.ok(names.includes(`trace-${today}.jsonl`), 'first file');
  assert.ok(names.includes(`trace-${today}-2.jsonl`), 'second file');
  assert.equal((await store.read({ limit: 50 })).length, 5, 'rotation loses nothing');
  assert.equal((await store.read({ limit: 1 }))[0]?.id, 'r4', 'still newest first across files');
  await workspace.cleanup();
});

test('tolerates a torn line left by a killed process', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 100);
  await store.append(makeRecord({ id: 'good' }));
  const file = join(workspace.config.storageDir, `trace-${dateKey()}.jsonl`);
  await appendFile(file, '{"id":"half-reco', 'utf8');
  const records = await store.read({ limit: 10 });
  assert.deepEqual(records.map((r) => r.id), ['good']);
  await workspace.cleanup();
});

test('reading an empty or missing directory is not an error', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(join(workspace.root, 'nope'));
  assert.deepEqual(await store.read({ limit: 5 }), []);
  assert.deepEqual(await store.files(), []);
  assert.deepEqual(await store.labels(), []);
  await workspace.cleanup();
});

test('config: defaults, file, then environment win', async () => {
  const workspace = await tempWorkspace();
  const defaults = loadConfig(workspace.root, {});
  assert.equal(defaults.confidenceThreshold, DEFAULTS.confidenceThreshold);
  assert.equal(defaults.storageDir, join(workspace.root, '.jevlens'));

  saveConfig(defaults.storageDir, { confidenceThreshold: 0.42, maxRecordsPerFile: 10 });
  assert.equal(loadConfig(workspace.root, {}).confidenceThreshold, 0.42);
  assert.equal(loadConfig(workspace.root, {}).maxRecordsPerFile, 10);
  assert.equal(loadConfig(workspace.root, { JEVLENS_CONFIDENCE_THRESHOLD: '0.9' }).confidenceThreshold, 0.9);
  assert.equal(loadConfig(workspace.root, { JEVLENS_MOCK: '1' }).mock, true);
  assert.equal(loadConfig(workspace.root, { JEVLENS_PORT: '9000' }).port, 9000);
  assert.equal(loadConfig(workspace.root, { JEVLENS_CONFIDENCE_THRESHOLD: 'nonsense' }).confidenceThreshold, 0.42);
  assert.equal(loadConfig(workspace.root, {}).storageDir.includes('config.json'), false);
  await workspace.cleanup();
});

test('scrub keeps credentials out of traces', () => {
  const secrets = ['tsk_live_1234567890abcdef'];
  const scrubbed = scrub(
    {
      api_key: 'tsk_live_1234567890abcdef',
      note: 'key is tsk_live_1234567890abcdef',
      tokenLike: 'sk-abcdefghijklmnop1234',
      nested: { Authorization: 'Bearer abcdefghijklmnop', keep: 'fine' },
      list: [{ password: 'hunter2please' }],
    },
    secrets,
  ) as Record<string, unknown>;

  assert.equal(scrubbed.api_key, '[redacted]');
  assert.ok(!JSON.stringify(scrubbed).includes('tsk_live_1234567890abcdef'), 'secret value never survives');
  assert.ok(!JSON.stringify(scrubbed).includes('abcdefghijklmnop1234'));
  assert.equal((scrubbed.nested as Record<string, unknown>).keep, 'fine');
  assert.equal((scrubbed.nested as Record<string, unknown>).Authorization, '[redacted]');
  assert.ok(secretValues({ TYPESAFE_API_KEY: 'tsk_live_1234567890abcdef' }).length === 1);
  assert.ok(secretValues({ PATH: '/usr/bin', HOME: '/home/dev' }).length === 0, 'innocuous env vars are not treated as secrets');
});
