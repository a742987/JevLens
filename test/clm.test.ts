import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { applyCredentialFlags, applyFlags } from '../src/cli.ts';
import { loadConfig, type JevLensConfig } from '../src/config.ts';
import { ClmJevProvider, createProvider, decide, DEFAULT_CLM_BASE_URL } from '../src/jev.ts';
import type { Questions } from '../src/types.ts';
import { cliEntry, tempWorkspace } from './helpers.ts';

const run = promisify(execFile);

/** Invoke the real CLI the way a developer would, and capture what it printed. */
async function jevlens(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cliEntry, ...args], {
      cwd: options.cwd,
      env: { ...process.env, TYPESAFE_API_KEY: '', CLM_BASE_URL: '', ...options.env },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

const questions: Questions = {
  go: { type: 'noul', instructions: 'is it safe to proceed?' },
  pick: { type: 'choice', instructions: 'which route?', criteria: { a: 'alpha', b: 'beta' } },
};

/** CLM-shaped replies: `noul` carries p_true, choice/score carry confidence + probabilities. */
const CLM_ANSWERS = {
  go: { noul: 0.93 },
  pick: { choice: 'b', confidence: 0.81, probabilities: { a: 0.19, b: 0.81 } },
};

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, fn: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(url);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

test('ClmJevProvider speaks the /v1/systemone wire format and normalises the answers', async () => {
  let seenBody: Record<string, unknown> | null = null;
  let seenPath = '';
  let seenAuth = 'absent';
  await withServer(
    (req, res) => {
      seenPath = req.url ?? '';
      seenAuth = String(req.headers.authorization ?? 'absent');
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: 'clm-8b', answers: CLM_ANSWERS, usage: { input_tokens: 42, billing_units: 1 } }));
      });
    },
    async (url) => {
      const provider = new ClmJevProvider({ baseURL: url, apiKey: 'clm-secret-token-1', model: 'clm-8b' });
      const outcome = await decide(provider, { state: { task: 'deploy' }, questions }, { timeoutMs: 5000 });

      assert.equal(outcome.status, 'answered');
      assert.equal(outcome.provider, 'clm');
      assert.equal(outcome.model, 'clm-8b');
      assert.equal(outcome.usage?.input_tokens, 42, 'CLM token accounting lands in the trace');
      assert.equal(seenPath, '/v1/systemone');
      assert.equal(seenAuth, 'Bearer clm-secret-token-1');
      assert.deepEqual(seenBody?.state, { task: 'deploy' });
      assert.deepEqual((seenBody?.questions as Record<string, unknown>).go, questions.go, 'questions pass through unmodified');
      assert.equal((seenBody as { model?: string } | null)?.model, 'clm-8b');

      const go = outcome.answers.go;
      assert.equal(go?.type, 'noul');
      assert.ok(go?.type === 'noul' && go.noul === 0.93, 'p_true maps straight onto noul');
      const pick = outcome.answers.pick;
      assert.ok(pick?.type === 'choice' && pick.choice === 'b' && pick.confidence === 0.81);
    },
  );
});

test('a CLM outage is fail-open: undecided, with the HTTP status recorded', async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 502;
      res.end('upstream gone');
    },
    async (url) => {
      const outcome = await decide(new ClmJevProvider({ baseURL: url }), { state: 'x', questions });
      assert.equal(outcome.status, 'undecided');
      assert.equal(outcome.error?.status, 502);
      assert.match(outcome.error?.message ?? '', /502/);
      assert.equal(Object.keys(outcome.answers).length, Object.keys(questions).length);
    },
  );
});

test('provider selection: explicit, via CLM_BASE_URL, and the mock fallback', () => {
  const base = (): JevLensConfig => ({ ...loadConfig(process.cwd(), {}), storageDir: 'x', mock: false, port: 0 });

  assert.equal(DEFAULT_CLM_BASE_URL, 'http://127.0.0.1:8700', 'clm-serve default address');
  assert.equal(createProvider(base(), { JEVLENS_PROVIDER: 'clm' }).kind, 'clm', '--provider clm needs no API key');
  assert.equal(createProvider(base(), { CLM_BASE_URL: 'http://127.0.0.1:9999' }).kind, 'clm', 'an explicit CLM_BASE_URL is a choice too');
  assert.equal(createProvider(base(), {}).kind, 'mock', 'auto without a key or CLM server still mocks');
  assert.equal(createProvider(base(), { TYPESAFE_API_KEY: 'tsk_live_whatever123' }).kind, 'live');
  assert.equal(
    createProvider({ ...base(), provider: 'live' }, { JEVLENS_PROVIDER: 'clm' }).kind,
    'clm',
    'the environment beats the config file',
  );
  const pinned = createProvider(base(), { JEVLENS_PROVIDER: 'clm' }) as ClmJevProvider;
  assert.match(pinned.note, /clm-latest @ http:\/\/127\.0\.0\.1:8700/);
});

test('--provider validates its argument', () => {
  const base = loadConfig(process.cwd(), {});
  assert.equal(applyFlags({ ...base }, { provider: 'clm' }).provider, 'clm');
  assert.equal(applyFlags({ ...base }, { provider: 'LIVE' }).provider, 'live', 'case-insensitive');
  assert.throws(() => applyFlags({ ...base }, { provider: 'claude' }), /auto, live or clm/);
});

test('config-file baseUrl is the endpoint fallback; the env var outranks it', () => {
  const base = (): JevLensConfig => ({ ...loadConfig(process.cwd(), {}), storageDir: 'x', mock: false, port: 0 });
  const withBase = { ...base(), baseUrl: 'http://10.0.0.8:9100' };
  assert.match(
    (createProvider({ ...withBase, provider: 'clm' }, {}) as ClmJevProvider).note,
    /10\.0\.0\.8:9100/,
    'the config-file baseUrl reaches the provider',
  );
  assert.match(
    (createProvider({ ...withBase, provider: 'clm' }, { CLM_BASE_URL: 'http://127.0.0.1:1' }) as ClmJevProvider).note,
    /127\.0\.0\.1:1/,
    'the dedicated env var outranks the config file',
  );
});

test('applyCredentialFlags routes the key to the backend that will actually be called', () => {
  const config = loadConfig(process.cwd(), {});

  const clmEnv: NodeJS.ProcessEnv = {};
  applyCredentialFlags({ ...config, provider: 'clm' }, { 'api-key': 'k-clm-1234567890', 'base-url': 'http://10.9.9.9:8700' }, clmEnv);
  assert.equal(clmEnv.CLM_API_KEY, 'k-clm-1234567890');
  assert.equal(clmEnv.TYPESAFE_API_KEY, undefined, 'the key is not handed to the other backend');
  assert.equal(clmEnv.CLM_BASE_URL, 'http://10.9.9.9:8700');
  assert.equal(clmEnv.TYPESAFE_BASE_URL, 'http://10.9.9.9:8700', 'the URL override reaches both backend names');

  const liveEnv: NodeJS.ProcessEnv = {};
  applyCredentialFlags({ ...config, provider: 'live' }, { 'api-key': 'k-live-1234567890' }, liveEnv);
  assert.equal(liveEnv.TYPESAFE_API_KEY, 'k-live-1234567890');
  assert.equal(liveEnv.CLM_API_KEY, undefined);

  // auto + CLM_BASE_URL resolves to the CLM server, so the key goes to it.
  const autoEnv: NodeJS.ProcessEnv = { CLM_BASE_URL: 'http://127.0.0.1:8700' };
  applyCredentialFlags(config, { 'api-key': 'k-auto-1234567890' }, autoEnv);
  assert.equal(autoEnv.CLM_API_KEY, 'k-auto-1234567890');
  assert.equal(autoEnv.TYPESAFE_API_KEY, undefined);
});

test('e2e: --base-url and --api-key flags reach the CLM server from the real CLI', async () => {
  let seenAuth = 'absent';
  await withServer(
    (req, res) => {
      seenAuth = String(req.headers.authorization ?? 'absent');
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { questions?: Record<string, unknown> };
        const answers: Record<string, unknown> = {};
        for (const name of Object.keys(body.questions ?? {})) answers[name] = { noul: 0.9 };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: 'clm-8b', answers, usage: { input_tokens: 1 } }));
      });
    },
    async (url) => {
      const workspace = await tempWorkspace();
      try {
        const result = await jevlens(
          ['doctor', '--provider', 'clm', '--base-url', url, '--api-key', 'e2e-key-123', '--dir', workspace.config.storageDir],
          { cwd: workspace.root },
        );
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /\[ok\s+\]\s+jev call\s+answered by clm-8b/);
        assert.equal(seenAuth, 'Bearer e2e-key-123', 'the flag-fed key rides the Authorization header');
      } finally {
        await workspace.cleanup();
      }
    },
  );
});
