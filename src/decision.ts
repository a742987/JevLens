import { randomUUID } from 'node:crypto';
import type { JevLensConfig } from './config.ts';
import { createProvider, decide, timeoutFromEnv, type JevProvider, type JevRequest } from './jev.ts';
import { analyseQuestions } from './quality.ts';
import { TraceStore } from './storage.ts';
import { summarizeConfidence, type Hint, type JsonValue, type Questions, type TraceRecord } from './types.ts';

export interface JevLensContext {
  config: JevLensConfig;
  store: TraceStore;
  provider: JevProvider;
  timeoutMs: number;
  /** Non-fatal problems (a failed trace write) that the caller may want to log. */
  diagnostics: string[];
}

export function createContext(
  config: JevLensConfig,
  env: NodeJS.ProcessEnv = process.env,
  provider?: JevProvider,
): JevLensContext {
  return {
    config,
    store: new TraceStore(config.storageDir, config.maxRecordsPerFile),
    provider: provider ?? createProvider(config, env),
    timeoutMs: timeoutFromEnv(env),
    diagnostics: [],
  };
}

export interface AskInput {
  state: JsonValue;
  questions: Questions;
  label?: string;
  model?: string;
  threshold?: number;
}

export interface CaptureResult {
  record: TraceRecord;
  /** JSONL file the record landed in, or null when the write failed. */
  file: string | null;
  wrote: boolean;
  hints: Hint[];
}

export function sanitizeLabel(value: string | undefined): string {
  const cleaned = (value ?? '').trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');
  if (!cleaned) return 'default';
  return cleaned.slice(0, 60);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * One decision: static question checks, the Jev call, and the trace write.
 * Nothing here is allowed to throw at the caller — a failed trace or a failed
 * Jev call still produces a usable `undecided` result.
 */
export async function captureDecision(
  ctx: JevLensContext,
  input: AskInput,
  meta: { agent?: string | null } = {},
): Promise<CaptureResult> {
  const label = sanitizeLabel(input.label);
  const threshold = clamp01(input.threshold ?? ctx.config.confidenceThreshold);
  const questions = input.questions;
  const state = input.state;

  let hints: Hint[] = [];
  try {
    hints = analyseQuestions(questions, { overlapThreshold: ctx.config.overlapThreshold });
  } catch (error) {
    ctx.diagnostics.push(`quality check failed: ${String(error)}`);
  }

  const request: JevRequest = {
    state,
    questions,
    ...(input.model ? { model: input.model } : {}),
  };
  const outcome = await decide(ctx.provider, request, { timeoutMs: ctx.timeoutMs });
  const confidence = summarizeConfidence(outcome.answers, questions, threshold);

  const record: TraceRecord = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    label,
    status: outcome.status,
    provider: outcome.provider,
    latencyMs: outcome.latencyMs,
    request: {
      state,
      questions,
      ...(input.model ? { model: input.model } : {}),
    },
    response: { model: outcome.model, answers: outcome.answers, usage: outcome.usage },
    confidence,
    hints,
    error: outcome.error,
    agent: meta.agent ?? null,
  };

  let file: string | null = null;
  let wrote = false;
  try {
    file = await ctx.store.append(record);
    wrote = true;
  } catch (error) {
    ctx.diagnostics.push(`trace write failed: ${String(error)}`);
  }

  return { record, file, wrote, hints };
}

export function uiUrl(config: JevLensConfig): string {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}`;
}
