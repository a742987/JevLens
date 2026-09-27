import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { applyFlags } from '../src/cli.ts';
import { loadConfig, type JevLensConfig } from '../src/config.ts';
import { TraceStore } from '../src/storage.ts';
import type { TraceRecord } from '../src/types.ts';
import { cliEntry } from './helpers.ts';

const run = promisify(execFile);

/** Invoke the real CLI the way a developer would, and capture what it printed. */
async function jevlens(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cliEntry, ...args], {
      cwd: options.cwd,
      env: { ...process.env, TYPESAFE_API_KEY: '', ...options.env },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    label: 'support',
    status: 'answered',
    provider: 'mock',
    latencyMs: 250,
    request: { state: { subject: 'charged twice' }, questions: { mood: { type: 'noul', instructions: 'is the user angry?' } } },
    response: { model: 'jev-mock-1', answers: { mood: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 100, output_tokens: 10 } },
    confidence: { min: 0.8, mean: 0.8, perQuestion: { mood: 0.8 }, belowThreshold: [] },
    hints: [],
    error: null,
    agent: null,
    runId: 'run-cli',
    ...overrides,
  };
}

async function seededWorkspace(): Promise<{ dir: string; config: JevLensConfig; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'jevlens-cli-'));
  const config = loadConfig(dir, {});
  const store = new TraceStore(config.storageDir, 100);
  await store.append(record());
  await store.append(record({ label: 'router', status: 'undecided', confidence: { min: 0, mean: 0, perQuestion: {}, belowThreshold: ['mood'] } }));
  await store.flush();
  return { dir, config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('--host refuses anything that is not loopback', () => {
  const base = (): JevLensConfig => ({ ...loadConfig(process.cwd(), {}), host: '127.0.0.1' });
  for (const host of ['127.0.0.1', 'localhost', '::1', '127.4.5.6']) {
    assert.equal(applyFlags(base(), { host }).host, host, `${host} is a loopback address`);
  }
  // Binding every interface used to print a warning and then answer 403 to
  // everyone who connected, which is the worst of both behaviours.
  for (const host of ['0.0.0.0', '192.168.1.20', '::']) {
    assert.throws(() => applyFlags(base(), { host }), /loopback/, `${host} must be rejected`);
  }
});

test('the panel will not start on a non-loopback host from any source', async () => {
  const workspace = await seededWorkspace();
  try {
    const viaFlag = await jevlens(['ui', '--host', '0.0.0.0', '--dir', workspace.config.storageDir], { cwd: workspace.dir });
    assert.equal(viaFlag.code, 2);
    assert.match(viaFlag.stderr, /loopback/);

    const viaEnv = await jevlens(['ui'], { cwd: workspace.dir, env: { JEVLENS_HOST: '0.0.0.0', JEVLENS_PORT: '0' } });
    assert.equal(viaEnv.code, 2, 'the environment cannot smuggle past the check either');
    assert.match(viaEnv.stderr, /loopback-only|refusing to bind/);
  } finally {
    await workspace.cleanup();
  }
});

test('jevlens stats aggregates the trace and can emit JSON', async () => {
  const workspace = await seededWorkspace();
  try {
    const json = await jevlens(['stats', '--json', '--dir', workspace.config.storageDir, '--threshold', '0.7'], { cwd: workspace.dir });
    assert.equal(json.code, 0, json.stderr);
    const payload = JSON.parse(json.stdout) as {
      records: number;
      undecided: number;
      flagged: number;
      tokens: { total: number };
      latency_ms: { p50: number };
      by_label: { label: string; count: number }[];
      files: number;
      bytes: number;
    };
    assert.equal(payload.records, 2);
    assert.equal(payload.undecided, 1);
    assert.equal(payload.flagged, 1);
    assert.equal(payload.tokens.total, 220, 'tokens recorded but never reported before');
    assert.equal(payload.latency_ms.p50, 250);
    assert.deepEqual(payload.by_label.map((entry) => entry.label).sort(), ['router', 'support']);
    assert.equal(payload.files, 1);
    assert.ok(payload.bytes > 0);

    const human = await jevlens(['stats', '--dir', workspace.config.storageDir], { cwd: workspace.dir });
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /records:\s+2/);
    assert.match(human.stdout, /latency:\s+p50 250 ms/);
    assert.match(human.stdout, /label\s+count\s+undecided\s+flagged/);

    const filtered = await jevlens(['stats', '--json', '--label', 'router', '--dir', workspace.config.storageDir], { cwd: workspace.dir });
    const onlyRouter = JSON.parse(filtered.stdout) as { by_label: { label: string }[] };
    assert.deepEqual(onlyRouter.by_label.map((entry) => entry.label), ['router']);
  } finally {
    await workspace.cleanup();
  }
});

test('jevlens doctor reports a usable offline install', async () => {
  const workspace = await seededWorkspace();
  try {
    const mock = await jevlens(['doctor', '--mock', '--dir', workspace.config.storageDir], { cwd: workspace.dir });
    assert.equal(mock.code, 0, mock.stdout + mock.stderr);
    assert.match(mock.stdout, /\[ok\s+\]\s+version\s+jevlens /);
    assert.match(mock.stdout, /\[ok\s+\]\s+jev call\s+answered/);
    assert.doesNotMatch(mock.stdout, /\[FAIL\]/);
    assert.match(mock.stdout, /never writes to the trace/);

    const files = await readdir(workspace.config.storageDir);
    const jsonl = files.filter((name) => name.endsWith('.jsonl'));
    const text = await Promise.all(jsonl.map((name) => readFile(join(workspace.config.storageDir, name), 'utf8')));
    const lines = text.join('').split('\n').filter((line) => line.trim()).length;
    assert.equal(lines, 2, 'the probe must not add a record to the user trace');
  } finally {
    await workspace.cleanup();
  }
});

test('jevlens doctor fails loudly when no key is configured and live calls were intended', async () => {
  const workspace = await seededWorkspace();
  try {
    const result = await jevlens(['doctor', '--dir', workspace.config.storageDir], { cwd: workspace.dir, env: { TYPESAFE_API_KEY: '' } });
    assert.notEqual(result.code, 0, 'a silent mock fallback is a real failure worth reporting');
    assert.match(result.stdout, /\[FAIL\]\s+api key/);
    assert.match(result.stdout, /silently falls back/);
  } finally {
    await workspace.cleanup();
  }
});

test('unknown commands still print usage and exit non-zero', async () => {
  const result = await jevlens(['nonsense']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown command "nonsense"/);
  assert.match(result.stderr, /jevlens doctor/);
  assert.match(result.stderr, /jevlens stats/);
});

/** Poll a predicate until it holds or the budget runs out, with what we saw so far on failure. */
async function waitFor(predicate: () => boolean, timeoutMs: number, context: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs} ms\n--- stdout ---\n${context()}`);
}

/**
 * Windows releases a killed child's directory handles asynchronously, so an
 * immediate rmdir races the 'exit' event and fails with EBUSY. Retry briefly.
 */
async function cleanupWorkspace(workspace: { cleanup: () => Promise<void> }): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await workspace.cleanup();
      return;
    } catch (error) {
      if (attempt >= 10 || !(error as NodeJS.ErrnoException).code?.startsWith('E')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

test('jevlens watch alerts on low-confidence decisions appended while it runs', async () => {
  const workspace = await seededWorkspace();
  const child = spawn(
    process.execPath,
    [cliEntry, 'watch', '--dir', workspace.config.storageDir, '--interval', '0.2'],
    { cwd: workspace.dir, env: { ...process.env, TYPESAFE_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await waitFor(() => /watching for low-confidence/.test(stderr), 15_000, () => stdout + stderr);

    // A decision lands in the trace from another process — the MCP server in
    // real usage — while the watcher is only reading.
    const store = new TraceStore(workspace.config.storageDir, 100);
    await store.append(
      record({ label: 'router', status: 'undecided', confidence: { min: 0, mean: 0, perQuestion: {}, belowThreshold: ['mood'] } }),
    );
    await store.flush();
    await waitFor(() => /\[ALERT\]/.test(stdout), 15_000, () => stdout + stderr);
    assert.match(stdout, /label=router/);
    assert.match(stdout, /UNDECIDED/);
    assert.match(stdout, /\x07/, 'the terminal bell is rung');

    // Records that were already in the trace before the watcher started are
    // history, not alerts — only the appended decision above may appear.
    assert.equal((stdout.match(/\[ALERT\]/g) ?? []).length, 1);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await cleanupWorkspace(workspace);
  }
});
