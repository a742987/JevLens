import type { ChoiceQuestion, Hint, JsonValue, Question, Questions, ScoreQuestion } from './types.ts';
import { DEFAULTS } from './config.ts';

export interface QualityOptions {
  /** Pairwise similarity at or above which two Choice options are flagged. */
  overlapThreshold?: number;
  /** Fewer score buckets than this is flagged as too narrow. */
  minScoreBuckets?: number;
  /** More score buckets than this is flagged as too wide. */
  maxScoreBuckets?: number;
  /** More choice options than this is flagged as hard to discriminate. */
  maxChoiceOptions?: number;
  /** More questions than this is flagged. */
  maxQuestions?: number;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'or', 'in', 'on', 'for',
  'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'what', 'which', 'does', 'do',
  '是否', '一个', '我们', '这个', '那个',
]);

function text(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
}

function tokenize(value: string): Set<string> {
  const out = new Set<string>();
  for (const word of normalized(value).split(' ')) {
    if (word.length > 1 && !STOPWORDS.has(word)) out.add(word);
  }
  return out;
}

function bigrams(value: string): Set<string> {
  const compact = normalized(value).replace(/ /g, '');
  const out = new Set<string>();
  if (compact.length <= 1) {
    if (compact.length === 1) out.add(compact);
    return out;
  }
  for (let i = 0; i < compact.length - 1; i += 1) out.add(compact.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Similarity in [0, 1]. Word overlap (Jaccard) plus character-bigram overlap
 * (Dice, which behaves better on short strings) so it works for both English
 * labels and CJK text.
 */
export function textSimilarity(a: string, b: string): number {
  const lower = a.toLowerCase().trim();
  const upper = b.toLowerCase().trim();
  if (lower && upper && (lower === upper || lower.includes(upper) || upper.includes(lower))) return 1;
  return Math.max(jaccard(tokenize(a), tokenize(b)), dice(bigrams(a), bigrams(b)));
}

function choiceEntries(question: ChoiceQuestion): { label: string; combined: string }[] {
  return Object.entries(question.criteria).map(([label, description]) => ({
    label,
    combined: `${label} ${text(description)}`.trim(),
  }));
}

function overlapOf(entries: { label: string; combined: string }[], threshold: number): { a: string; b: string; score: number }[] {
  const hits: { a: string; b: string; score: number }[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i] as { label: string; combined: string };
      const b = entries[j] as { label: string; combined: string };
      // Labels matter most: the agent receives the label back, so `bug_report`
      // vs `bug_reports` is a real collision even if the descriptions differ.
      const score = Math.max(textSimilarity(a.label, b.label), textSimilarity(a.combined, b.combined));
      if (score >= threshold) hits.push({ a: a.label, b: b.label, score });
    }
  }
  return hits.sort((x, y) => y.score - x.score);
}

function scoreLabels(question: ScoreQuestion): string[] {
  return question.criteria.map((entry) => text(entry).trim()).filter((entry) => entry.length > 0);
}

function analyseQuestion(name: string, question: Question, options: Required<QualityOptions>): Hint[] {
  const hints: Hint[] = [];
  const instructions = text(question.instructions).trim();
  if (instructions.length === 0) {
    hints.push({
      code: 'question.missing_instructions',
      severity: 'info',
      question: name,
      message: `"${name}" has no instructions text; Jev answers from the option wording alone.`,
    });
  }

  if (question.type === 'choice') {
    const labels = Object.keys(question.criteria);
    if (labels.length < 2) {
      hints.push({
        code: 'choice.too_few_options',
        severity: 'warn',
        question: name,
        message: `"${name}" has ${labels.length} option(s); a Choice question needs at least two distinguishable options.`,
      });
    }
    if (labels.length > options.maxChoiceOptions) {
      hints.push({
        code: 'choice.too_many_options',
        severity: 'info',
        question: name,
        message: `"${name}" offers ${labels.length} options; probability mass gets noisy past ${options.maxChoiceOptions}.`,
      });
    }
    for (const hit of overlapOf(choiceEntries(question), options.overlapThreshold)) {
      hints.push({
        code: 'choice.overlap',
        severity: 'warn',
        question: name,
        message:
          `"${name}": options "${hit.a}" and "${hit.b}" look semantically overlapping ` +
          `(similarity ${hit.score.toFixed(2)}). The probability split between them is hard to read.`,
      });
    }
  }

  if (question.type === 'score') {
    const buckets = question.criteria.length;
    if (buckets < options.minScoreBuckets) {
      hints.push({
        code: 'score.range_narrow',
        severity: 'warn',
        question: name,
        message: `"${name}" spans only ${buckets} bucket(s); a range that narrow cannot express much beyond a boolean.`,
      });
    }
    if (buckets > options.maxScoreBuckets) {
      hints.push({
        code: 'score.range_wide',
        severity: 'warn',
        question: name,
        message: `"${name}" spans ${buckets} buckets; adjacent buckets become indistinguishable, which flattens the distribution.`,
      });
    }
    const labels = scoreLabels(question);
    if (labels.length !== new Set(labels.map((l) => l.toLowerCase())).size) {
      hints.push({
        code: 'score.duplicate_bucket',
        severity: 'warn',
        question: name,
        message: `"${name}" repeats the same bucket text; each score position should mean something different.`,
      });
    }
    if (labels.length > 2 && normalized(labels[0] as string) === normalized(labels[labels.length - 1] as string)) {
      hints.push({
        code: 'score.endpoints_identical',
        severity: 'warn',
        question: name,
        message: `"${name}" uses the same text for the lowest and highest bucket.`,
      });
    }
  }

  return hints;
}

/**
 * Static, non-blocking checks on the questions before they go to Jev. These are
 * hints about question quality, never validation errors.
 */
export function analyseQuestions(questions: Questions, options: QualityOptions = {}): Hint[] {
  const resolved: Required<QualityOptions> = {
    overlapThreshold: options.overlapThreshold ?? DEFAULTS.overlapThreshold,
    minScoreBuckets: options.minScoreBuckets ?? 3,
    maxScoreBuckets: options.maxScoreBuckets ?? 8,
    maxChoiceOptions: options.maxChoiceOptions ?? 16,
    maxQuestions: options.maxQuestions ?? 12,
  };
  const hints: Hint[] = [];
  const names = Object.keys(questions);
  if (names.length > resolved.maxQuestions) {
    hints.push({
      code: 'question.too_many',
      severity: 'info',
      message: `${names.length} questions in one call; answers get harder to attribute when the state is large.`,
    });
  }
  for (const name of names) {
    const question = questions[name];
    if (!question) continue;
    hints.push(...analyseQuestion(name, question, resolved));
  }
  return hints;
}
