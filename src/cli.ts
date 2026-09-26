#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isLoopbackHost, loadConfig, DEFAULTS, type JevLensConfig } from './config.ts';
import { createContext, uiUrl } from './decision.ts';
import { decide, timeoutFromEnv } from './jev.ts';
import { startMcpServer } from './mcp-server.ts';
import { createUIServer } from './ui-server.ts';
import { VERSION } from './version.ts';

const OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  dir: { type: 'string' },
  threshold: { type: 'string' },
  'inspector-port': { type: 'string' },
  label: { type: 'string' },
  json: { type: 'boolean' },
  mock: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

const HELP = `JevLens v${VERSION} — Jev decision recorder and debug panel

Usage
  jevlens mcp         start the MCP server on stdio (register this with your coding agent)
  jevlens ui          start the local decision timeline at http://127.0.0.1:${DEFAULTS.port}
  jevlens stats       aggregate the trace: tokens, latency, undecided rate, per label
  jevlens doctor      check the install: Node version, API key, trace dir, live Jev call
  jevlens inspector   start the official MCP Inspector against "jevlens mcp"

Options
  --port <n>          UI port (default ${DEFAULTS.port}, config key "port")
  --host <addr>       UI bind address (loopback only: 127.0.0.1, 127.x.x.x, ::1, localhost)
  --dir <path>        trace directory (default ./.jevlens)
  --threshold <0..1>  confidence alert threshold (default ${DEFAULTS.confidenceThreshold})
  --label <name>      stats: only this label
  --json              stats: emit machine-readable JSON
  --mock              never call the Jev API; answer deterministically offline
  --inspector-port <n>  port for "jevlens inspector" (default 6274)
  -h, --help          show this help
  -v, --version       print the version

Environment
  TYPESAFE_API_KEY          Jev API key (read from the environment only, never stored)
  TYPESAFE_BASE_URL         override the Jev endpoint
  TYPESAFE_DEFAULT_MODEL    model to request
  JEVLENS_MOCK=1            force the offline mock provider
  JEVLENS_RUN_ID            run id recorded with every decision from this process
  JEVLENS_DIR, JEVLENS_PORT, JEVLENS_HOST, JEVLENS_CONFIDENCE_THRESHOLD,
  JEVLENS_TIMEOUT_MS, JEVLENS_MAX_RECORDS

MCP registration (any MCP-capable agent):
  { "mcpServers": { "jevlens": { "command": "npx", "args": ["-y", "jevlens", "mcp"],
    "env": { "TYPESAFE_API_KEY": "..." } } } }
`;

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function applyFlags(config: JevLensConfig, values: Record<string, string | boolean | undefined>): JevLensConfig {
  const port = toNumber(values.port as string | undefined);
  const threshold = toNumber(values.threshold as string | undefined);
  if (typeof values.dir === 'string' && values.dir) {
    config.storageDir = loadConfig(process.cwd(), { ...process.env, JEVLENS_DIR: values.dir }).storageDir;
  }
  if (port !== undefined) {
    const normalized = Math.trunc(port);
    if (normalized < 0 || normalized > 65535) {
      throw new RangeError(`--port must be between 0 and 65535, got "${values.port}"`);
    }
    config.port = normalized;
  }
  if (typeof values.host === 'string' && values.host) {
    if (!isLoopbackHost(values.host)) {
      throw new RangeError(
        `--host must be a loopback address, got "${values.host}". The panel has no authentication, ` +
          'so it refuses to listen on a reachable interface. Use 127.0.0.1 and an SSH tunnel instead.',
      );
    }
    config.host = values.host;
  }
  if (threshold !== undefined) config.confidenceThreshold = Math.min(1, Math.max(0, threshold));
  if (values.mock === true) config.mock = true;
  return config;
}

function logStartup(config: JevLensConfig, extra: string[]): void {
  const runId = process.env.JEVLENS_RUN_ID?.trim();
  const lines = [
    `[jevlens ${VERSION}]`,
    ...extra,
    `  trace:   ${config.storageDir}`,
    `  panel:   ${uiUrl(config)}`,
    `  alerts:  confidence < ${config.confidenceThreshold}`,
    ...(runId ? [`  run:     ${runId}`] : []),
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}

async function commandMcp(config: JevLensConfig): Promise<number> {
  const { server, ctx } = await startMcpServer(config);
  const shutdown = () => {
    void server
      .close()
      .catch(() => {})
      .then(() => ctx.store.flush())
      .then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise<number>(() => {
    /* stdio keeps the event loop alive */
  });
}

async function commandUi(config: JevLensConfig): Promise<number> {
  if (!isLoopbackHost(config.host)) {
    process.stderr.write(
      `[jevlens] refusing to bind "${config.host}": the panel has no authentication and is loopback-only.\n` +
        '[jevlens] use 127.0.0.1 (the default) and reach it over an SSH tunnel if you need it remotely.\n',
    );
    return 2;
  }
  const ctx = createContext(config);
  const ui = createUIServer(ctx, config);
  let url: string;
  try {
    url = await ui.listen();
  } catch (error) {
    const message = String(error);
    if (message.includes('EADDRINUSE')) {
      process.stderr.write(`[jevlens] port ${config.port} is in use — retry with --port <n>\n`);
      return 1;
    }
    throw error;
  }
  logStartup(config, [`  serve:   ${url}`, `  records: ${ctx.provider.note}`]);
  await new Promise<void>((resolveClose) => {
    const close = () => {
      void ui.close().then(() => resolveClose());
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  });
  return 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Aggregate what is already on disk: no new state, no extra writes. */
async function commandStats(config: JevLensConfig, values: Record<string, string | boolean | undefined>): Promise<number> {
  const ctx = createContext(config);
  const stats = await ctx.store.stats();
  const overview = await ctx.store.overview(config.confidenceThreshold);
  const labelFilter = typeof values.label === 'string' && values.label ? values.label : null;

  const byLabel = labelFilter ? overview.byLabel.filter((entry) => entry.label === labelFilter) : overview.byLabel;
  const payload = {
    dir: stats.dir,
    files: stats.files,
    bytes: stats.bytes,
    oldest: stats.oldest,
    newest: stats.newest,
    threshold: overview.threshold,
    records: overview.records,
    undecided: overview.undecided,
    flagged: overview.flagged,
    undecided_rate: overview.undecidedRate,
    tokens: { input: overview.inputTokens, output: overview.outputTokens, total: overview.inputTokens + overview.outputTokens },
    latency_ms: overview.latency,
    by_label: byLabel,
    by_day: overview.byDay,
  };

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  if (labelFilter && byLabel.length === 0) {
    process.stderr.write(`[jevlens] no records with label "${labelFilter}" in ${stats.dir}\n`);
    return 1;
  }

  const lines = [
    `trace:      ${stats.dir}`,
    `files:      ${stats.files} (${formatBytes(stats.bytes)})`,
    `span:       ${stats.oldest ?? '—'} → ${stats.newest ?? '—'}`,
    '',
    `records:    ${overview.records}`,
    `undecided:  ${overview.undecided} (${(overview.undecidedRate * 100).toFixed(1)}%)`,
    `flagged:    ${overview.flagged} (undecided or min confidence < ${overview.threshold})`,
    `tokens:     ${payload.tokens.total.toLocaleString('en-US')} total (${overview.inputTokens.toLocaleString('en-US')} in / ${overview.outputTokens.toLocaleString('en-US')} out)`,
    `latency:    p50 ${overview.latency.p50} ms · p95 ${overview.latency.p95} ms · max ${overview.latency.max} ms`,
  ];

  if (byLabel.length) {
    lines.push('', 'label                        count  undecided  flagged');
    for (const entry of byLabel.slice(0, 20)) {
      lines.push(
        `${entry.label.slice(0, 28).padEnd(28)} ${String(entry.count).padStart(6)} ${String(entry.undecided).padStart(10)} ${String(entry.flagged).padStart(8)}`,
      );
    }
  } else {
    lines.push('', 'no records yet — run your agent, then look at the trace again.');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * Answers "why is everything coming back mock?" without reading the source:
 * reports the runtime, the key, the trace directory and one real Jev round trip.
 */
async function commandDoctor(config: JevLensConfig): Promise<number> {
  const ctx = createContext(config);
  const stats = await ctx.store.stats();
  const hasKey = Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim());
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;

  const checks: { label: string; ok: boolean | 'warn'; detail: string }[] = [
    { label: 'node', ok: nodeOk, detail: `${process.versions.node} (>= 22.18 needed to run the TypeScript tests)` },
    { label: 'version', ok: true, detail: `jevlens ${VERSION}` },
    {
      label: 'trace dir',
      ok: stats.files > 0 ? true : 'warn',
      detail: `${config.storageDir} — ${stats.records} record(s) in ${stats.files} file(s)`,
    },
    {
      // A missing key is only a problem when live calls were intended. The
      // silent fallback to the mock provider is the confusing case worth flagging.
      label: 'api key',
      ok: hasKey || config.mock ? true : false,
      detail: hasKey
        ? 'TYPESAFE_API_KEY is set'
        : config.mock
          ? 'not set, but --mock was requested so the offline provider is intended'
          : 'TYPESAFE_API_KEY is not set — every call silently falls back to the offline mock provider',
    },
    { label: 'provider', ok: ctx.provider.kind === 'live' ? true : 'warn', detail: ctx.provider.note },
  ];

  // `decide` never writes to the store, so this probe leaves no trace behind.
  const outcome = await decide(
    ctx.provider,
    { state: { probe: 'jevlens doctor' }, questions: { reachable: { type: 'noul', instructions: 'Is this trace reachable?' } } },
    { timeoutMs: Math.min(timeoutFromEnv(), 15_000) },
  );
  checks.push({
    label: 'jev call',
    ok: outcome.status === 'answered',
    detail:
      outcome.status === 'answered'
        ? `answered by ${outcome.model} in ${outcome.latencyMs} ms`
        : `${outcome.error?.name ?? 'Error'}: ${outcome.error?.message ?? 'unknown'} (after ${outcome.latencyMs} ms)`,
  });

  const width = Math.max(...checks.map((check) => check.label.length));
  for (const check of checks) {
    const mark = check.ok === true ? 'ok  ' : check.ok === 'warn' ? 'warn' : 'FAIL';
    process.stdout.write(`[${mark}] ${check.label.padEnd(width)}  ${check.detail}\n`);
  }
  const failed = checks.some((check) => check.ok === false);
  process.stdout.write(
    failed
      ? '\nSomething above is failing. `warn` lines are expected on a fresh install or with --mock.\n'
      : '\nAll checks passed. The probe was not recorded — `jevlens doctor` never writes to the trace.\n',
  );
  return failed ? 1 : 0;
}

async function commandInspector(config: JevLensConfig, values: Record<string, string | boolean | undefined>): Promise<number> {
  const entry = fileURLToPath(import.meta.url);
  const port = (
    toNumber(values['inspector-port'] as string | undefined) ??
    toNumber(process.env.JEVLENS_INSPECTOR_PORT as string | undefined) ??
    6274
  ).toString();
  const args = ['-y', '@modelcontextprotocol/inspector', process.execPath, entry, 'mcp'];
  const env: NodeJS.ProcessEnv = { ...process.env, JEVLENS_DIR: config.storageDir, MCP_INSPECTOR_UI_PORT: port };
  process.stderr.write(`[jevlens] launching MCP Inspector on http://127.0.0.1:${port} against "${entry} mcp"\n`);
  const child = spawn('npx', args, { stdio: 'inherit', shell: process.platform === 'win32', env });
  return new Promise<number>((resolveCode) => {
    child.on('close', (code) => resolveCode(code ?? 1));
    child.on('error', (error) => {
      process.stderr.write(`[jevlens] could not start the inspector: ${String(error)}\n`);
      resolveCode(1);
    });
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    const result = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    parsed = { values: result.values as Record<string, string | boolean | undefined>, positionals: result.positionals };
  } catch (error) {
    process.stderr.write(`[jevlens] ${String(error)}\n\n${HELP}`);
    return 2;
  }

  const command = parsed.positionals[0] ?? 'help';
  if (parsed.values.version === true || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.values.help === true || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const config = applyFlags(loadConfig(), parsed.values);
  switch (command) {
    case 'mcp':
      return commandMcp(config);
    case 'ui':
      return commandUi(config);
    case 'stats':
      return commandStats(config, parsed.values);
    case 'doctor':
      return commandDoctor(config);
    case 'inspector':
      return commandInspector(config, parsed.values);
    default:
      process.stderr.write(`[jevlens] unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[jevlens] ${String(error)}\n\n${HELP}`);
      process.exitCode = 2;
    });
}
