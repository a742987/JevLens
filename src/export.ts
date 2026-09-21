import type { Answer, JsonValue, Question, TraceRecord } from './types.ts';

function probabilityText(answer: Answer): string {
  if (answer.type === 'noul') return `noul ${answer.noul.toFixed(3)}`;
  return Object.entries(answer.probabilities ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key}=${value.toFixed(3)}`)
    .join(' ');
}

function answerText(answer: Answer | undefined, question: Question): string {
  if (!answer) return '-';
  if (answer.type === 'choice') return answer.choice || '-';
  if (answer.type === 'noul') return String(answer.noul);
  const index = Math.trunc(answer.score);
  let label: JsonValue | undefined;
  if (question.type === 'score') label = question.criteria[index];
  if (label === undefined && answer.legend) label = answer.legend[String(index)];
  if (label === undefined) return String(answer.score);
  return `${answer.score} (${typeof label === 'string' ? label : JSON.stringify(label)})`;
}

function confidenceOf(answer: Answer | undefined): number | undefined {
  if (!answer) return undefined;
  if (answer.type === 'noul') return Math.round(Math.abs(answer.noul - 0.5) * 2 * 1000) / 1000;
  return answer.confidence;
}

/** A raw pipe inside a markdown table cell splits the row in two. */
function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function jsonBlock(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

export interface ReportOptions {
  title?: string;
  /** Confidence threshold used to mark alerts in the report. */
  threshold?: number;
  generatedAt?: Date;
  /** Which Jev endpoint/provider produced these answers. */
  providerNote?: string;
}

/** Markdown report: readable in a terminal, pasteable into an issue. */
export function toMarkdown(records: TraceRecord[], options: ReportOptions = {}): string {
  const threshold = options.threshold ?? 0.7;
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const undecided = records.filter((record) => record.status === 'undecided').length;
  const flagged = records.filter(
    (record) => record.status === 'undecided' || record.confidence.min < threshold,
  ).length;
  const lines: string[] = [];
  lines.push(`# ${options.title ?? 'JevLens decision report'}`, '');
  lines.push(`- generated: ${generatedAt}`);
  lines.push(`- records: ${records.length}`);
  lines.push(`- confidence threshold: ${threshold}`);
  lines.push(`- flagged (undecided or below threshold): ${flagged}`);
  lines.push(`- undecided: ${undecided}`);
  if (options.providerNote) lines.push(`- provider: ${options.providerNote}`);
  lines.push('');

  records.forEach((record, index) => {
    const status = record.status === 'undecided' ? 'UNDECIDED' : 'answered';
    lines.push(`## ${index + 1}. \`${record.label}\` — ${record.ts}`, '');
    lines.push(
      `- status: ${status}${record.status === 'undecided' ? ' ⚠️' : ''}`,
      `- provider/model: ${record.provider} / ${record.response?.model ?? 'n/a'}`,
      `- latency: ${record.latencyMs} ms`,
      `- confidence: min ${record.confidence.min.toFixed(3)} · mean ${record.confidence.mean.toFixed(3)}`,
      `- trace id: ${record.id}`,
    );
    if (record.agent) lines.push(`- agent: ${record.agent}`);
    if (record.error) lines.push(`- error: ${record.error.name}: ${record.error.message}`);
    lines.push('');

    lines.push('### State', '', jsonBlock(record.request.state), '');
    lines.push('### Questions and answers', '');
    lines.push('| question | type | answer | confidence | probabilities |', '| --- | --- | --- | --- | --- |');
    for (const [name, question] of Object.entries(record.request.questions)) {
      const answer = record.response?.answers?.[name];
      const confidence = confidenceOf(answer);
      const alert = confidence !== undefined && confidence < threshold ? ' ⚠️' : '';
      lines.push(
        `| ${mdCell(name)} | ${question.type} | ${mdCell(answerText(answer, question))} | ${
          confidence === undefined ? '-' : `${confidence.toFixed(3)}${alert}`
        } | ${answer ? mdCell(probabilityText(answer)) : '-'} |`,
      );
    }
    lines.push('');

    const criteria = Object.entries(record.request.questions).map(([name, question]) => ({
      name,
      ...(question.type === 'choice' ? { options: Object.keys(question.criteria) } : {}),
      ...(question.type === 'score' ? { buckets: question.criteria } : {}),
      ...(question.instructions === undefined ? {} : { instructions: question.instructions }),
    }));
    lines.push('### Question definitions', '', jsonBlock(criteria), '');

    if (record.hints.length) {
      lines.push('### Question quality hints', '');
      for (const hint of record.hints) lines.push(`- **${hint.severity}** \`${hint.code}\` — ${hint.message}`);
      lines.push('');
    }
  });

  lines.push('---', '', 'Produced by JevLens. The trace behind this report is plain JSONL and can be replayed with `grep` or `jq`.', '');
  return lines.join('\n');
}

const CSV_COLUMNS = [
  'id',
  'ts',
  'label',
  'status',
  'provider',
  'model',
  'agent',
  'latency_ms',
  'record_min_confidence',
  'question',
  'question_type',
  'answer',
  'answer_confidence',
  'probabilities',
  'hints',
  'error',
  'state_json',
] as const;

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV export: one row per question so spreadsheets can pivot on it. */
export function toCsv(records: TraceRecord[]): string {
  const rows: string[] = [CSV_COLUMNS.join(',')];
  for (const record of records) {
    const questions = Object.entries(record.request.questions);
    const shared = [
      record.id,
      record.ts,
      record.label,
      record.status,
      record.provider,
      record.response?.model ?? '',
      record.agent ?? '',
      record.latencyMs,
      record.confidence.min,
    ];
    const hints = record.hints.map((hint) => `${hint.code}${hint.question ? `@${hint.question}` : ''}`).join('; ');
    const error = record.error ? `${record.error.name}: ${record.error.message}` : '';
    const state = JSON.stringify(record.request.state);
    if (questions.length === 0) {
      rows.push([...shared, '', '', '', '', '', hints, error, state].map(csvCell).join(','));
      continue;
    }
    for (const [name, question] of questions) {
      const answer = record.response?.answers?.[name];
      rows.push(
        [
          ...shared,
          name,
          question.type,
          answer ? answerText(answer, question) : '',
          answer ? (confidenceOf(answer) ?? '') : '',
          answer ? probabilityText(answer) : '',
          hints,
          error,
          state,
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return `${rows.join('\r\n')}\r\n`;
}

export function reportFileName(format: 'markdown' | 'csv', date: Date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `jevlens-${stamp}.${format === 'csv' ? 'csv' : 'md'}`;
}
