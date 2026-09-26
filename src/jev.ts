import {
  TypeSafeClient,
  choice as jevChoice,
  noul as jevNoul,
  score as jevScore,
  type EntryType as SdkEntry,
  type Questions as SdkQuestions,
  type SystemOneRequest,
} from '@typesafe-ai/sdk';
import type { JevLensConfig } from './config.ts';
import { scrub } from './sanitize.ts';
import type {
  Answer,
  Answers,
  JsonValue,
  NoulQuestion,
  ProviderKind,
  Question,
  Questions,
  TraceStatus,
} from './types.ts';

export interface JevRequest {
  state: JsonValue;
  questions: Questions;
  model?: string;
}

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevReply {
  model: string;
  answers: Answers;
  usage: JevUsage | null;
}

export interface AskOptions {
  timeoutMs?: number;
  /**
   * Model the caller would have used, so a call that never came back can still
   * say what it attempted. This is the configuration's answer; the provider's
   * own `defaultModel` is the fallback for callers that do not pass one.
   */
  defaultModel?: string;
}

export interface JevProvider {
  readonly kind: ProviderKind;
  /** Why this provider is being used, surfaced in traces and the panel. */
  readonly note: string;
  /** Model this provider would request, used to label a call that never returned. */
  readonly defaultModel?: string;
  ask(request: JevRequest, options?: AskOptions): Promise<JevReply>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The SDK's option text is `string | object | array | null`; agents happily
 * write `{ label: 0.5 }`, so scalars are stringified rather than rejected.
 */
function toEntry(value: JsonValue | undefined): SdkEntry {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value as SdkEntry;
}

function toSdkQuestion(question: Question): SdkQuestions[string] {
  const instructions = toEntry(question.instructions);
  if (question.type === 'choice') {
    const criteria: Record<string, SdkEntry> = {};
    for (const [label, description] of Object.entries(question.criteria)) criteria[label] = toEntry(description);
    return jevChoice(instructions, criteria);
  }
  if (question.type === 'score') {
    const criteria = question.criteria.map((entry) => toEntry(entry)) as [SdkEntry, SdkEntry, ...SdkEntry[]];
    return jevScore(instructions, criteria);
  }
  const noulQuestion = question as NoulQuestion;
  const criteria = noulQuestion.criteria
    ? { true: toEntry(noulQuestion.criteria.true), false: toEntry(noulQuestion.criteria.false) }
    : undefined;
  return jevNoul(instructions, criteria);
}

function toSdkQuestions(questions: Questions): SdkQuestions {
  const out: Record<string, SdkQuestions[string]> = {};
  for (const [name, question] of Object.entries(questions)) out[name] = toSdkQuestion(question);
  return out as SdkQuestions;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function probabilitiesOf(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    out[key] = numberOr(raw, 0);
  }
  return out;
}

/** Coerce whatever the API returned into the shape the panel renders. */
export function normalizeAnswer(question: Question | undefined, raw: unknown): Answer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : question?.type;
  if (type === 'choice') {
    return {
      type: 'choice',
      choice: String(value.choice ?? ''),
      confidence: numberOr(value.confidence, 0),
      probabilities: probabilitiesOf(value.probabilities),
    };
  }
  if (type === 'score') {
    const legend = value.legend;
    return {
      type: 'score',
      score: numberOr(value.score, 0),
      confidence: numberOr(value.confidence, 0),
      legend:
        legend && typeof legend === 'object' && !Array.isArray(legend)
          ? (legend as Record<string, JsonValue>)
          : undefined,
      probabilities: probabilitiesOf(value.probabilities),
    };
  }
  if (type === 'noul') {
    return { type: 'noul', noul: numberOr(value.noul, 0.5) };
  }
  return undefined;
}

function usageOf(value: unknown): JevUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  if (typeof usage.input_tokens !== 'number' && typeof usage.output_tokens !== 'number') return null;
  return {
    input_tokens: numberOr(usage.input_tokens, 0),
    output_tokens: numberOr(usage.output_tokens, 0),
  };
}

/** Calls the real TypeSafe Jev API. */
export class LiveJevProvider implements JevProvider {
  readonly kind = 'live' as const;
  readonly note = 'TypeSafe Jev API';
  readonly defaultModel?: string;
  private readonly client: TypeSafeClient;
  private readonly model?: string;

  constructor(options: { apiKey?: string; baseURL?: string; model?: string; timeoutMs?: number } = {}) {
    this.model = options.model;
    this.defaultModel = options.model;
    this.client = new TypeSafeClient({
      apiKey: options.apiKey ?? process.env.TYPESAFE_API_KEY,
      baseURL: options.baseURL ?? process.env.TYPESAFE_BASE_URL,
      defaultModel: options.model,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      logLevel: 'warn',
    });
  }

  async ask(request: JevRequest, options: AskOptions = {}): Promise<JevReply> {
    const payload: SystemOneRequest<SdkQuestions> = {
      state: request.state as SdkEntry,
      questions: toSdkQuestions(request.questions),
      ...(request.model ?? this.model ? { model: request.model ?? this.model } : {}),
    };
    const result = await this.client.systemOne(payload, {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const typed = result as unknown as { model: string; answers: Record<string, unknown>; usage?: unknown };
    const answers: Answers = {};
    for (const [name, question] of Object.entries(request.questions)) {
      const answer = normalizeAnswer(question, typed.answers?.[name]);
      if (answer) answers[name] = answer;
    }
    return { model: String(typed.model ?? 'unknown'), answers, usage: usageOf(typed.usage) };
  }
}

function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw a probability distribution over `count` slots. The largest slot is the
 * answer, so a "shaky" draw produces a genuinely flat distribution rather than
 * a winner that contradicts its own numbers.
 */
function drawShares(rng: () => number, count: number, shaky: boolean): number[] {
  const weights: number[] = [];
  for (let i = 0; i < count; i += 1) weights.push(Math.pow(rng(), shaky ? 0.6 : 3) + 0.02);
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((weight) => Math.round((weight / sum) * 1000) / 1000);
  const drift = Math.round((1 - shares.reduce((a, b) => a + b, 0)) * 1000) / 1000;
  let peak = 0;
  shares.forEach((share, index) => {
    if (share > (shares[peak] ?? 0)) peak = index;
  });
  shares[peak] = Math.round(((shares[peak] ?? 0) + drift) * 1000) / 1000;
  return shares;
}

/**
 * Offline stand-in used when `JEVLENS_MOCK=1` or no API key is present. Answers
 * are deterministic for a given request, which makes demos reproducible and lets
 * the whole pipeline be tested without network access or spend.
 */
export class MockJevProvider implements JevProvider {
  readonly kind = 'mock' as const;
  readonly note: string;

  constructor(note: string) {
    this.note = note;
  }

  async ask(request: JevRequest): Promise<JevReply> {
    const rng = rngFrom(hashSeed(JSON.stringify({ s: request.state, q: request.questions })));
    const answers: Answers = {};
    for (const [name, question] of Object.entries(request.questions)) {
      const shaky = rng() < 0.35;
      if (question.type === 'choice') {
        const labels = Object.keys(question.criteria);
        const shares = drawShares(rng, labels.length, shaky);
        let peak = 0;
        labels.forEach((_, index) => {
          if ((shares[index] ?? 0) > (shares[peak] ?? 0)) peak = index;
        });
        const probabilities: Record<string, number> = {};
        labels.forEach((label, index) => {
          probabilities[label] = shares[index] ?? 0;
        });
        answers[name] = {
          type: 'choice',
          choice: labels[peak] ?? '',
          confidence: shares[peak] ?? 0,
          probabilities,
        };
      } else if (question.type === 'score') {
        const count = question.criteria.length;
        const shares = drawShares(rng, count, shaky);
        let peak = 0;
        shares.forEach((share, index) => {
          if (share > (shares[peak] ?? 0)) peak = index;
        });
        const probabilities: Record<string, number> = {};
        shares.forEach((share, index) => {
          probabilities[String(index)] = share;
        });
        const legend: Record<string, JsonValue> = {};
        question.criteria.forEach((entry, index) => {
          legend[String(index)] = entry;
        });
        answers[name] = { type: 'score', score: peak, confidence: shares[peak] ?? 0, legend, probabilities };
      } else {
        answers[name] = { type: 'noul', noul: Math.round((shaky ? 0.35 + rng() * 0.3 : rng()) * 1000) / 1000 };
      }
    }
    return {
      model: 'jev-mock-1',
      answers,
      usage: { input_tokens: JSON.stringify(request.state).length >> 2, output_tokens: Object.keys(answers).length * 4 },
    };
  }
}

/** Uniform answers with zero confidence: what a failed decision degrades to. */
export function fallbackAnswers(questions: Questions): Answers {
  const answers: Answers = {};
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      const labels = Object.keys(question.criteria);
      const first = labels[0] ?? '';
      const uniform = Math.round((1 / Math.max(1, labels.length)) * 1000) / 1000;
      const probabilities: Record<string, number> = {};
      for (const label of labels) probabilities[label] = uniform;
      answers[name] = { type: 'choice', choice: first, confidence: 0, probabilities };
    } else if (question.type === 'score') {
      const uniform = Math.round((1 / Math.max(1, question.criteria.length)) * 1000) / 1000;
      const probabilities: Record<string, number> = {};
      question.criteria.forEach((_, index) => {
        probabilities[String(index)] = uniform;
      });
      const legend: Record<string, JsonValue> = {};
      question.criteria.forEach((entry, index) => {
        legend[String(index)] = entry;
      });
      answers[name] = {
        type: 'score',
        score: Math.floor((question.criteria.length - 1) / 2),
        confidence: 0,
        legend,
        probabilities,
      };
    } else {
      answers[name] = { type: 'noul', noul: 0.5 };
    }
  }
  return answers;
}

export interface JevError {
  name: string;
  message: string;
  status?: number;
}

export function describeError(error: unknown): JevError {
  const err = error as { name?: string; message?: string; status?: unknown };
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const message = String(err?.message ?? error ?? 'unknown error');
  const scrubbed = scrub({ message }, process.env.TYPESAFE_API_KEY ? [process.env.TYPESAFE_API_KEY] : []);
  return {
    name: String(err?.name ?? 'Error'),
    message: String((scrubbed as { message: JsonValue }).message),
    ...(status === undefined ? {} : { status }),
  };
}

export interface JevOutcome {
  status: TraceStatus;
  provider: ProviderKind;
  model: string;
  answers: Answers;
  usage: JevUsage | null;
  error: JevError | null;
  latencyMs: number;
}

/** Error thrown when the watchdog fires before the provider answers. */
export class JevTimeoutError extends Error {
  override readonly name = 'JevTimeoutError';
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Jev did not answer within ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Fail-open is the iron rule: any provider failure is recorded and degraded into
 * an `undecided` result so the calling agent keeps working.
 *
 * The timeout is enforced here as well as in the SDK. Fail-open is worthless if
 * the call can hang, and honouring the deadline must not depend on a third-party
 * client remembering to.
 */
export async function decide(
  provider: JevProvider,
  request: JevRequest,
  options: AskOptions = {},
): Promise<JevOutcome> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failedModel = request.model ?? options.defaultModel ?? provider.defaultModel ?? 'unknown';
  try {
    const reply = await withTimeout(provider.ask(request, { timeoutMs }), timeoutMs);
    const missing = Object.keys(request.questions).filter((name) => !reply.answers[name]);
    if (missing.length > 0) {
      for (const name of missing) {
        const question = request.questions[name] as Question;
        reply.answers[name] = fallbackAnswers({ [name]: question })[name] as Answer;
      }
      return {
        status: 'undecided',
        provider: provider.kind,
        model: reply.model || failedModel,
        answers: reply.answers,
        usage: reply.usage,
        error: { name: 'IncompleteAnswer', message: `Jev returned no answer for: ${missing.join(', ')}` },
        latencyMs: Date.now() - started,
      };
    }
    return {
      status: 'answered',
      provider: provider.kind,
      model: reply.model,
      answers: reply.answers,
      usage: reply.usage,
      error: null,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      status: 'undecided',
      provider: provider.kind,
      model: failedModel,
      answers: fallbackAnswers(request.questions),
      usage: null,
      error: describeError(error),
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Races the provider against a watchdog. The losing promise is left to settle on
 * its own — an in-flight HTTP request cannot be recalled from here — but its
 * rejection is swallowed so it cannot surface as an unhandled rejection after
 * the caller has already moved on.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new JevTimeoutError(timeoutMs)), timeoutMs);
    // Never hold the event loop open just for a deadline.
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
    promise.catch(() => {});
  }
}

export function hasApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TYPESAFE_API_KEY && env.TYPESAFE_API_KEY.trim().length > 0);
}

export function timeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.JEVLENS_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export function createProvider(config: JevLensConfig, env: NodeJS.ProcessEnv = process.env): JevProvider {
  const timeoutMs = timeoutFromEnv(env);
  if (config.mock) return new MockJevProvider('mock provider (JEVLENS_MOCK)');
  if (!hasApiKey(env)) return new MockJevProvider('mock provider (no TYPESAFE_API_KEY set)');
  return new LiveJevProvider({
    apiKey: env.TYPESAFE_API_KEY,
    baseURL: env.TYPESAFE_BASE_URL,
    model: config.model,
    timeoutMs,
  });
}
