import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { exportsDir } from './config.ts';
import { captureDecision, createContext, type JevLensContext } from './decision.ts';
import { reportFileName, toCsv, toMarkdown } from './export.ts';
import { VERSION } from './version.ts';
import type { JevLensConfig } from './config.ts';
import { jsonValueSchema, questionsSchema, type TraceRecord } from './types.ts';

export const TOOL_NAMES = ['jev_ask', 'jev_trace', 'jev_export'] as const;

function json(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function failure(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }],
    isError: true,
  };
}

interface ClientInfoLike {
  name?: string;
  version?: string;
}

interface McpServerInternals {
  server?: {
    getClientInfo?: () => ClientInfoLike | undefined;
    _clientInfo?: ClientInfoLike | undefined;
  };
}

/** Best-effort name of the harness that connected, for trace labelling. */
function agentName(server: McpServer): string | null {
  try {
    const inner = (server as unknown as McpServerInternals).server;
    const info = inner?.getClientInfo?.() ?? inner?._clientInfo;
    if (!info?.name) return null;
    return info.version ? `${info.name}@${info.version}` : info.name;
  } catch {
    return null;
  }
}

export interface BuildOptions {
  /** Overrides the connected-client detection; used by tests. */
  agent?: string | null;
}

export function buildServer(ctx: JevLensContext, options: BuildOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'jevlens', version: VERSION },
    {
      instructions: [
        'JevLens records Jev decisions for debugging; it never changes them.',
        'Call jev_ask exactly as you would call Jev: pass state plus a questions map of',
        "{ type: 'choice'|'score'|'noul', instructions, criteria } entries. It returns",
        'the decision plus per-question probability and confidence, and appends the whole',
        'exchange to a local JSONL trace you can replay in the panel.',
        'jev_ask is fail-open: if Jev cannot be reached it returns status "undecided" and',
        'your run continues. jev_trace reads recent records, jev_export writes a report.',
      ].join(' '),
    },
  );

  server.registerTool(
    'jev_ask',
    {
      title: 'Ask Jev (recorded)',
      description:
        'Send state and questions to Jev, return the structured decision, and append the full exchange — probabilities, confidence, latency and question-quality hints — to the local trace. Never throws: an unreachable Jev returns { status: "undecided" } with zero-confidence answers so the agent can proceed.',
      inputSchema: {
        state: jsonValueSchema.describe('The situation Jev should judge: any JSON object/string, e.g. the user request or tool output.'),
        questions: questionsSchema.describe('Map of question name to { type: "choice"|"score"|"noul", instructions, criteria }.'),
        label: z.string().max(60).optional().describe('Grouping tag shown in the timeline and usable as a trace filter. Defaults to "default".'),
        model: z.string().max(80).optional().describe('Optional Jev model override for this call.'),
        threshold: z.number().min(0).max(1).optional().describe('Confidence threshold for alerting this record (default comes from .jevlens/config.json).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const result = await captureDecision(ctx, input, { agent: options.agent ?? agentName(server) });
        const record = result.record;
        return json({
          id: record.id,
          label: record.label,
          status: record.status,
          provider: record.provider,
          model: record.response?.model,
          latency_ms: record.latencyMs,
          confidence: record.confidence,
          answers: record.response?.answers,
          hints: record.hints,
          error: record.error,
          trace: result.file ?? null,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'jev_trace',
    {
      title: 'Read recent decisions',
      description:
        'Return the most recent Jev decisions from the local JSONL trace, newest first, optionally filtered by label or by low confidence. Use it to check what Jev actually answered before changing a prompt.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('How many records to return (default 20).'),
        label: z.string().max(60).optional().describe('Only return records with this label.'),
        below_threshold: z.number().min(0).max(1).optional().describe('Only return undecided records or records whose minimum confidence is below this value.'),
        include_payload: z.boolean().optional().describe('Set false to omit the full state payload and keep the response small (default true).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const records = await ctx.store.read({
          limit: input.limit ?? 20,
          label: input.label,
          belowThreshold: input.below_threshold,
          includePayload: input.include_payload !== false,
        });
        return json({
          count: records.length,
          storage_dir: ctx.config.storageDir,
          provider: ctx.provider.note,
          records: records.map(compactRecord),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'jev_export',
    {
      title: 'Export decision report',
      description:
        'Write the stored trace to a Markdown or CSV report for bug reports and team discussion, and return the path. The API key is never included.',
      inputSchema: {
        format: z.enum(['markdown', 'csv']).optional().describe('Report format (default markdown).'),
        label: z.string().max(60).optional().describe('Only export records with this label.'),
        limit: z.number().int().min(1).max(5000).optional().describe('Maximum records to export (default 200).'),
        path: z.string().max(500).optional().describe('Optional output path; relative paths resolve from the working directory.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const format = input.format ?? 'markdown';
        const records = await ctx.store.read({ limit: input.limit ?? 200, label: input.label });
        const target = input.path
          ? isAbsolute(input.path)
            ? input.path
            : resolve(process.cwd(), input.path)
          : join(await ensureExports(ctx.config.storageDir), reportFileName(format));
        await mkdir(dirname(target), { recursive: true });
        const body =
          format === 'csv'
            ? toCsv(records)
            : toMarkdown(records, {
                threshold: ctx.config.confidenceThreshold,
                providerNote: ctx.provider.note,
              });
        await writeFile(target, body, 'utf8');
        return json({ format, path: target, records: records.length, bytes: Buffer.byteLength(body) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

async function ensureExports(storageDir: string): Promise<string> {
  const dir = exportsDir(storageDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function compactRecord(record: TraceRecord): Record<string, unknown> {
  return {
    id: record.id,
    ts: record.ts,
    label: record.label,
    status: record.status,
    provider: record.provider,
    model: record.response?.model,
    latency_ms: record.latencyMs,
    confidence: record.confidence,
    agent: record.agent,
    error: record.error,
    hints: record.hints,
    answers: record.response?.answers,
    questions: record.request.questions,
    state: record.request.state,
    file: record.file,
  };
}

export async function startMcpServer(config: JevLensConfig): Promise<{ server: McpServer; ctx: JevLensContext }> {
  const ctx = createContext(config);
  const server = buildServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[jevlens] MCP server ready (provider: ${ctx.provider.note}, trace dir: ${config.storageDir})\n`);
  return { server, ctx };
}
