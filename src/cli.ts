#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, DEFAULTS, type JevLensConfig } from './config.ts';
import { createContext, uiUrl } from './decision.ts';
import { startMcpServer } from './mcp-server.ts';
import { createUIServer } from './ui-server.ts';
import { VERSION } from './version.ts';

const OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  dir: { type: 'string' },
  threshold: { type: 'string' },
  'inspector-port': { type: 'string' },
  mock: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

const HELP = `JevLens v${VERSION} — Jev decision recorder and debug panel

Usage
  jevlens mcp         start the MCP server on stdio (register this with your coding agent)
  jevlens ui          start the local decision timeline at http://127.0.0.1:${DEFAULTS.port}
  jevlens inspector   start the UI plus MCP Inspector for hands-on tool debugging

Options
  --port <n>          UI port (default ${DEFAULTS.port}, config key "port")
  --host <addr>       UI bind address (default 127.0.0.1; keep it local, there is no auth)
  --dir <path>        trace directory (default ./.jevlens)
  --threshold <0..1>  confidence alert threshold (default ${DEFAULTS.confidenceThreshold})
  --mock              never call the Jev API; answer deterministically offline
  -h, --help          show this help
  -v, --version       print the version

Environment
  TYPESAFE_API_KEY          Jev API key (read from the environment only, never stored)
  TYPESAFE_BASE_URL         override the Jev endpoint
  TYPESAFE_DEFAULT_MODEL    model to request
  JEVLENS_MOCK=1            force the offline mock provider
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
  if (typeof values.host === 'string' && values.host) config.host = values.host;
  if (threshold !== undefined) config.confidenceThreshold = Math.min(1, Math.max(0, threshold));
  if (values.mock === true) config.mock = true;
  return config;
}

function logStartup(config: JevLensConfig, extra: string[]): void {
  const lines = [
    `[jevlens ${VERSION}]`,
    ...extra,
    `  trace:   ${config.storageDir}`,
    `  panel:   ${uiUrl(config)}`,
    `  alerts:  confidence < ${config.confidenceThreshold}`,
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
  if (config.host === '0.0.0.0' || config.host === '::') {
    process.stderr.write('[jevlens] warning: binding every interface on an unauthenticated panel\n');
  }
  await new Promise<void>((resolveClose) => {
    const close = () => {
      void ui.close().then(() => resolveClose());
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  });
  return 0;
}

async function commandInspector(config: JevLensConfig): Promise<number> {
  const entry = fileURLToPath(import.meta.url);
  const port = (toNumber(process.env.JEVLENS_INSPECTOR_PORT as string | undefined) ?? 6274).toString();
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
    case 'inspector':
      return commandInspector(config);
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
