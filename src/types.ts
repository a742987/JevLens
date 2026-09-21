import { z } from 'zod';

/** Any JSON-serialisable value. Jev `state` and question text accept these. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const entryTypeSchema = jsonValueSchema;

export interface ChoiceQuestion {
  type: 'choice';
  instructions?: JsonValue;
  criteria: Record<string, JsonValue>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions?: JsonValue;
  criteria: JsonValue[];
}

export interface NoulQuestion {
  type: 'noul';
  instructions?: JsonValue;
  criteria?: { true?: JsonValue; false?: JsonValue } | null;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Questions = Record<string, Question>;

export const choiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: entryTypeSchema.optional(),
  criteria: z.record(z.string(), entryTypeSchema),
});

export const scoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: entryTypeSchema.optional(),
  criteria: z.array(entryTypeSchema).min(2),
});

export const noulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: entryTypeSchema.optional(),
  criteria: z
    .object({ true: entryTypeSchema.optional(), false: entryTypeSchema.optional() })
    .nullish(),
});

export const questionSchema = z.discriminatedUnion('type', [
  choiceQuestionSchema,
  scoreQuestionSchema,
  noulQuestionSchema,
]);

export const questionsSchema = z.record(z.string(), questionSchema).refine(
  (q) => Object.keys(q).length > 0,
  { message: 'questions must contain at least one entry' },
);

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend?: Record<string, JsonValue>;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export type Answers = Record<string, Answer>;

export type TraceStatus = 'answered' | 'undecided';
export type ProviderKind = 'live' | 'mock';

export interface TraceRequest {
  state: JsonValue;
  questions: Questions;
  model?: string;
}

export interface TraceResponse {
  model: string;
  answers: Answers;
  usage?: { input_tokens: number; output_tokens: number } | null;
}

export interface Hint {
  code: string;
  severity: 'info' | 'warn';
  question?: string;
  message: string;
}

export interface ConfidenceSummary {
  /** Lowest per-question confidence in the record; used for alerting. */
  min: number;
  mean: number;
  perQuestion: Record<string, number>;
  belowThreshold: string[];
}

export interface TraceRecord {
  /** Trace id, unique per decision. */
  id: string;
  /** ISO-8601 timestamp of completion. */
  ts: string;
  label: string;
  status: TraceStatus;
  provider: ProviderKind;
  latencyMs: number;
  request: TraceRequest;
  response: TraceResponse | null;
  confidence: ConfidenceSummary;
  hints: Hint[];
  error?: { name: string; message: string; status?: number } | null;
  /** Name/version of the MCP client that made the call, when known. */
  agent?: string | null;
  /** Storage file the record lives in; filled in on read. */
  file?: string;
}

/**
 * Confidence for a `noul` answer is derived: the model returns a single
 * probability, so 0.5 is maximal ambiguity and 0/1 are maximal certainty.
 */
export function noulConfidence(p: number): number {
  return Math.round(Math.abs(p - 0.5) * 2 * 1000) / 1000;
}

export function answerConfidence(answer: Answer | undefined): number | undefined {
  if (!answer) return undefined;
  if (answer.type === 'noul') return noulConfidence(answer.noul);
  return answer.confidence;
}

export function summarizeConfidence(
  answers: Answers | undefined | null,
  questions: Questions,
  threshold: number,
): ConfidenceSummary {
  const perQuestion: Record<string, number> = {};
  const belowThreshold: string[] = [];
  for (const name of Object.keys(questions)) {
    const c = answerConfidence(answers?.[name]);
    if (c === undefined) continue;
    perQuestion[name] = c;
    if (c < threshold) belowThreshold.push(name);
  }
  const values = Object.values(perQuestion);
  const min = values.length ? Math.min(...values) : 0;
  const mean = values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000
    : 0;
  return { min, mean, perQuestion, belowThreshold };
}
