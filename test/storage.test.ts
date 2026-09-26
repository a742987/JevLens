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

test('a credential-shaped string is masked by its shape alone, without knowing the value', () => {
  // TypeSafe keys are `tsk_live_…`. The `\b` anchor means a bare `sk` branch can
  // never match inside `tsk`, so `tsk` has to be listed in its own right —
  // otherwise the one key this tool actually handles is the one that leaks.
  const scrubbed = scrub({ note: 'pasted tsk_live_abcdef1234567890 into the prompt' }, []) as { note: string };
  assert.ok(!scrubbed.note.includes('tsk_live_abcdef1234567890'), `got: ${scrubbed.note}`);
  assert.match(scrubbed.note, /\[redacted\]/);

  // Quality hints quote the user's own option text, so they are a second path to
  // disk that a payload-only scrub would miss.
  const hinted = scrub(
    { hints: [{ code: 'choice.overlap', message: 'options "a" and "tsk_live_abcdef1234567890" overlap' }], label: 'triage' },
    [],
  ) as { hints: { message: string }[]; label: string };
  assert.ok(!JSON.stringify(hinted).includes('tsk_live_abcdef1234567890'), 'hint messages are scrubbed too');
  assert.equal(hinted.label, 'triage', 'non-secret fields survive');
});

test('token counters survive the credential scrub', async () => {
  // `input_tokens` matches the credential-key pattern. Scrubbing a whole record
  // without carving out the usage block turns every token figure into
  // "[redacted]", which reads as a legitimate zero in the aggregates.
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 100);
  await store.append(makeRecord({ id: 'counted' }));
  const [stored] = await store.read({ limit: 1 });
  assert.deepEqual(stored?.response?.usage, { input_tokens: 100, output_tokens: 5 });
  assert.equal((await store.overview(0.7)).inputTokens, 100);

  // The exemption is for numbers, not for anything sharing the name.
  const spoofed = scrub({ input_tokens: 'tsk_live_abcdef1234567890' }, []) as Record<string, unknown>;
  assert.equal(spoofed.input_tokens, '[redacted]', 'a string at a metric key is still a credential');
  await workspace.cleanup();
});

test('jevlens stats and overview agree about what is on disk', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 100);
  for (let i = 0; i < 3; i += 1) await store.append(makeRecord({ id: `x${i}`, label: 'triage' }));
  const stats = await store.stats();
  const overview = await store.overview(0.7);
  assert.equal(overview.records, stats.records, 'the two aggregate views cannot disagree');
  assert.equal(overview.inputTokens, 300);
  assert.equal(overview.latency.p50, 420);
  await workspace.cleanup();
});

test('labels and stats still see records that were rotated out of the newest file', async () => {
  const workspace = await tempWorkspace();
  // A cap of 2 forces rotation, so the nine records land in five files.
  const store = new TraceStore(workspace.config.storageDir, 2);
  for (let i = 0; i < 9; i += 1) {
    await store.append(
      makeRecord({
        id: `old-${i}`,
        label: 'legacy-label',
        ts: `2026-01-01T00:00:0${i}Z`,
        status: i % 3 === 0 ? 'undecided' : 'answered',
        confidence: { min: i % 3 === 0 ? 0 : 0.95, mean: 0.5, perQuestion: {}, belowThreshold: [] },
      }),
    );
  }
  await store.append(makeRecord({ id: 'new', label: 'current-label', ts: '2026-09-20T00:00:00Z' }));

  const labels = await store.labels(0.7);
  const legacy = labels.find((entry) => entry.label === 'legacy-label');
  assert.ok(legacy, 'a label that only appears in rotated-away files is still listed');
  assert.equal(legacy?.count, 9, 'counts are totals, not a truncated page');
  assert.equal(legacy?.undecided, 3);
  assert.equal(labels.find((entry) => entry.label === 'current-label')?.count, 1);

  const stats = await store.stats();
  assert.equal(stats.records, 10);
  assert.equal(stats.files, 6, 'five rotated files for the old day, plus the newest');
  assert.equal(stats.oldest, '2026-01-01T00:00:00Z');
  assert.equal(stats.newest, '2026-09-20T00:00:00Z');
  assert.ok(stats.bytes > 0, 'byte totals come from the files on disk');
  await workspace.cleanup();
});

test('the aggregate index picks up records appended after it was built', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 100);
  await store.append(makeRecord({ id: 'first', label: 'a' }));
  assert.equal((await store.stats()).records, 1);

  await store.append(makeRecord({ id: 'second', label: 'a' }));
  const stats = await store.stats();
  assert.equal(stats.records, 2, 'a cached summary is extended, not frozen');
  assert.equal((await store.labels(0.7)).find((entry) => entry.label === 'a')?.count, 2);

  // A third label arriving after the aggregates were already built and cached.
  await store.append(makeRecord({ id: 'third', label: 'b' }));
  const overview = await store.overview(0.7);
  assert.equal(overview.records, 3);
  assert.deepEqual(overview.byLabel.map((entry) => entry.label).sort(), ['a', 'b']);
  await workspace.cleanup();
});

test('a torn trailing line is retried once the write completes', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 100);
  await store.append(makeRecord({ id: 'good' }));
  const file = join(workspace.config.storageDir, `trace-${dateKey()}.jsonl`);
  const complete = JSON.stringify(makeRecord({ id: 'late' }));
  await appendFile(file, complete.slice(0, 20), 'utf8');
  assert.equal((await store.stats()).records, 1, 'a partial line does not count');
  await appendFile(file, `${complete.slice(20)}\n`, 'utf8');
  assert.equal((await store.stats()).records, 2, 'the same line is recognised once it is whole');
  assert.deepEqual((await store.read({ limit: 10 })).map((r) => r.id).sort(), ['good', 'late']);
  await workspace.cleanup();
});

test('records can be filtered by run id and by exact trace id', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 100);
  await store.append(makeRecord({ id: 'r1', runId: 'run-a', ts: '2026-01-01T00:00:01Z' }));
  await store.append(makeRecord({ id: 'r2', runId: 'run-a', ts: '2026-01-01T00:00:02Z' }));
  await store.append(makeRecord({ id: 'r3', runId: 'run-b', ts: '2026-01-01T00:00:03Z' }));
  await store.append(makeRecord({ id: 'r4', ts: '2026-01-01T00:00:04Z' }));

  assert.deepEqual((await store.read({ runId: 'run-a' })).map((r) => r.id), ['r2', 'r1'], 'newest first within a run');
  assert.deepEqual((await store.read({ runId: 'run-b' })).map((r) => r.id), ['r3']);
  assert.deepEqual((await store.read({ id: 'r4' })).map((r) => r.id), ['r4']);
  assert.equal((await store.read({ runId: 'run-a', until: '2026-01-01T00:00:01Z' })).length, 1);
  await workspace.cleanup();
});

test('overview aggregates tokens, latency and the undecided rate', async () => {
  const workspace = await tempWorkspace();
  const store = new TraceStore(workspace.config.storageDir, 100);
  await store.append(makeRecord({ id: 'a', label: 'triage', latencyMs: 100, ts: '2026-03-01T00:00:00Z' }));
  await store.append(
    makeRecord({
      id: 'b',
      label: 'triage',
      latencyMs: 300,
      ts: '2026-03-01T00:00:01Z',
      status: 'undecided',
      confidence: { min: 0, mean: 0, perQuestion: {}, belowThreshold: ['category'] },
      response: { model: 'jev-1', answers: {}, usage: { input_tokens: 50, output_tokens: 5 } },
    }),
  );
  await store.append(makeRecord({ id: 'c', label: 'router', latencyMs: 200, ts: '2026-03-02T00:00:00Z' }));

  const overview = await store.overview(0.7);
  assert.equal(overview.records, 3);
  assert.equal(overview.undecided, 1);
  assert.equal(overview.flagged, 1);
  assert.equal(overview.undecidedRate, 0.333);
  assert.equal(overview.inputTokens, 250, 'two default records at 100 plus the override at 50');
  assert.equal(overview.latency.p50, 200);
  assert.equal(overview.latency.max, 300);
  assert.deepEqual(overview.byDay.map((day) => day.day), ['2026-03-02', '2026-03-01'], 'newest day first');
  assert.equal(overview.byLabel.find((entry) => entry.label === 'triage')?.count, 2);
  await workspace.cleanup();
});
