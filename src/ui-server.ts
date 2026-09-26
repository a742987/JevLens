import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportsDir, isLoopbackHost, saveConfig, type JevLensConfig } from './config.ts';
import { uiUrl } from './decision.ts';
import { reportFileName, toCsv, toMarkdown } from './export.ts';
import type { JevLensContext } from './decision.ts';
import { VERSION } from './version.ts';

const MAX_LIMIT = 2000;

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const cleaned = address.replace(/^::ffff:/, '');
  return cleaned === '127.0.0.1' || cleaned === '::1' || cleaned.startsWith('127.');
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(body);
}

function json(res: ServerResponse, payload: unknown, status = 200): void {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function num(value: string | null, max: number): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(max, parsed));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64_000) break;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface UIServerHandle {
  server: Server;
  url: string;
  listen(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Local debug panel: one HTML file plus a JSON API over the same JSONL trace the
 * MCP server writes. The two processes are decoupled and share no state.
 * Binds to localhost and serves no authenticated routes by design.
 */
export function createUIServer(ctx: JevLensContext, config: JevLensConfig = ctx.config): UIServerHandle {
  if (!isLoopbackHost(config.host)) {
    throw new RangeError(
      `JevLens refuses to bind the panel to "${config.host}": it has no authentication, so it is ` +
        'loopback-only. Use 127.0.0.1 (the default) and reach it over an SSH tunnel if you need it remotely.',
    );
  }

  const htmlPath = process.env.JEVLENS_UI_HTML
    ? process.env.JEVLENS_UI_HTML
    : join(import.meta.dirname, '..', 'ui', 'index.html');

  const server = createServer((req, res) => {
    void handle(ctx, config, htmlPath, req, res);
  });

  return {
    server,
    url: uiUrl(config),
    async listen(): Promise<string> {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(config.port, config.host, () => resolveListen());
      });
      const address = server.address();
      if (address && typeof address === 'object') {
        const host = config.host.includes(':') ? `[${config.host}]` : config.host;
        return `http://${host}:${address.port}`;
      }
      return uiUrl(config);
    },
    close(): Promise<void> {
      return new Promise((resolveClose) => {
        server.close(() => resolveClose());
        // Browsers and fetch clients keep sockets alive; without this the
        // process would sit waiting for connections that never close.
        server.closeAllConnections?.();
      });
    },
  };
}

async function handle(
  ctx: JevLensContext,
  config: JevLensConfig,
  htmlPath: string,
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const remote = req.socket.remoteAddress;

  if (!isLoopback(remote)) {
    send(res, 403, 'JevLens binds to localhost only.', 'text/plain; charset=utf-8');
    return;
  }
  const hostHeader = String(req.headers.host ?? '');
  if (!/^(\d{1,3}(\.\d{1,3}){3}|\[?::1\]?|localhost)(:\d+)?$/.test(hostHeader)) {
    send(res, 403, 'Unexpected Host header.', 'text/plain; charset=utf-8');
    return;
  }

  const path = url.pathname;
  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await readFile(htmlPath, 'utf8').catch(() => null);
      if (html === null) {
        send(res, 500, `UI file not found at ${htmlPath}`, 'text/plain; charset=utf-8');
        return;
      }
      send(res, 200, html, 'text/html; charset=utf-8');
      return;
    }

    if (path === '/api/health') {
      const stats = await ctx.store.stats();
      json(res, {
        ok: true,
        version: VERSION,
        provider: ctx.provider.note,
        api_key_present: Boolean(process.env.TYPESAFE_API_KEY),
        threshold: config.confidenceThreshold,
        ...stats,
      });
      return;
    }

    if (path === '/api/trace') {
      const limit = num(url.searchParams.get('limit'), MAX_LIMIT) ?? 50;
      const records = await ctx.store.read({
        limit,
        offset: num(url.searchParams.get('offset'), 100_000) ?? 0,
        label: url.searchParams.get('label') ?? undefined,
        runId: url.searchParams.get('run') ?? undefined,
        id: url.searchParams.get('id') ?? undefined,
        belowThreshold: num(url.searchParams.get('below'), 1),
        since: url.searchParams.get('since') ?? undefined,
        until: url.searchParams.get('until') ?? undefined,
      });
      json(res, { count: records.length, threshold: config.confidenceThreshold, records });
      return;
    }

    if (path === '/api/labels') {
      json(res, { labels: await ctx.store.labels(config.confidenceThreshold) });
      return;
    }

    if (path === '/api/overview') {
      json(res, await ctx.store.overview(config.confidenceThreshold));
      return;
    }

    if (path === '/api/config' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'POST') {
        // A cross-origin page can only fire a "simple request" with a text/plain
        // body; requiring application/json forces a preflight this server never
        // answers, which blocks the request in the browser.
        const contentType = String(req.headers['content-type'] ?? '');
        if (!contentType.toLowerCase().startsWith('application/json')) {
          json(res, { error: 'content-type must be application/json' }, 415);
          return;
        }
        const raw = await readBody(req);
        let patch: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) patch = parsed as Record<string, unknown>;
        } catch {
          json(res, { error: 'body must be JSON' }, 400);
          return;
        }
        const allowed: Record<string, unknown> = {};
        if (typeof patch.confidenceThreshold === 'number' && patch.confidenceThreshold >= 0 && patch.confidenceThreshold <= 1) {
          allowed.confidenceThreshold = patch.confidenceThreshold;
          config.confidenceThreshold = patch.confidenceThreshold;
        }
        if (allowed.confidenceThreshold === undefined) {
          json(res, { error: 'nothing to update; only confidenceThreshold is writable here' }, 400);
          return;
        }
        saveConfig(config.storageDir, allowed);
      }
      json(res, {
        confidenceThreshold: config.confidenceThreshold,
        storageDir: config.storageDir,
        host: config.host,
        port: config.port,
        maxRecordsPerFile: config.maxRecordsPerFile,
        mock: config.mock,
        model: config.model ?? null,
        version: VERSION,
      });
      return;
    }

    if (path === '/api/export') {
      const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'markdown';
      const limit = num(url.searchParams.get('limit'), MAX_LIMIT) ?? 500;
      const records = await ctx.store.read({
        limit,
        label: url.searchParams.get('label') ?? undefined,
        runId: url.searchParams.get('run') ?? undefined,
      });
      const body =
        format === 'csv'
          ? toCsv(records)
          : toMarkdown(records, { threshold: config.confidenceThreshold, providerNote: ctx.provider.note });
      const name = reportFileName(format);
      send(
        res,
        200,
        format === 'csv' ? `\uFEFF${body}` : body,
        format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8',
        { 'content-disposition': `attachment; filename="${name}"` },
      );
      return;
    }

    if (path === '/api/exports-dir') {
      json(res, { dir: exportsDir(config.storageDir) });
      return;
    }

    json(res, { error: 'not found', path }, 404);
  } catch (error) {
    json(res, { error: String(error) }, 500);
  }
}
