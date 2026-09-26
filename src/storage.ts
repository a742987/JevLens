import { appendFile, mkdir, open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS } from './config.ts';
import { scrub, secretValues } from './sanitize.ts';
import type { JsonValue, TraceRecord, TraceStatus } from './types.ts';

const FILE_RE = /^trace-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.jsonl$/;

/** Local-time day key used for daily rotation. */
export function dateKey(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface TraceQuery {
  limit?: number;
  offset?: number;
  label?: string;
  /** Only search for records belonging to this agent run. */
  runId?: string;
  /** Only search for records with this exact trace id. */
  id?: string;
  /** Inclusive ISO-8601 lower bound. */
  since?: string;
  /** Inclusive ISO-8601 upper bound. */
  until?: string;
  /** Only search for records whose minimum confidence is below this value. */
  belowThreshold?: number;
  /** Keep the full `state` payload in the results (default true). */
  includePayload?: boolean;
}

export interface LabelSummary {
  label: string;
  count: number;
  latest: string;
  undecided: number;
  lowConfidence: number;
}

export interface StoreStats {
  records: number;
  files: number;
  /** Sum of the trace files' sizes on disk, in bytes. */
  bytes: number;
  dir: string;
  oldest: string | null;
  newest: string | null;
}

export interface LabelOverview {
  label: string;
  count: number;
  undecided: number;
  flagged: number;
}

export interface DayOverview {
  /** Local-time day key, `YYYY-MM-DD`. */
  day: string;
  count: number;
  undecided: number;
  flagged: number;
}

export interface StoreOverview {
  records: number;
  undecided: number;
  flagged: number;
  threshold: number;
  /** Share of decisions that came back undecided, in [0, 1]. */
  undecidedRate: number;
  inputTokens: number;
  outputTokens: number;
  latency: { p50: number; p95: number; max: number };
  byLabel: LabelOverview[];
  byDay: DayOverview[];
}

/** The few fields the aggregate views need, kept instead of the whole record. */
interface IndexEntry {
  ts: string;
  label: string;
  status: TraceStatus;
  min: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Per-file aggregate, cached against `(size, mtimeMs)` and extended by reading
 * only the appended tail. This is what keeps the panel's 3s poll cheap: without
 * it every refresh re-parses every record ever written.
 */
interface FileSummary {
  size: number;
  mtimeMs: number;
  /** Byte offset of the last complete line folded into `index`. */
  consumed: number;
  index: IndexEntry[];
}

function fileName(date: string, part: number): string {
  return part <= 1 ? `trace-${date}.jsonl` : `trace-${date}-${part}.jsonl`;
}

function summarizeState(state: JsonValue): JsonValue {
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    return { _omitted: true, keys: Object.keys(state as Record<string, JsonValue>) };
  }
  const text = typeof state === 'string' ? state : JSON.stringify(state);
  return { _omitted: true, type: Array.isArray(state) ? 'array' : typeof state, chars: text.length };
}

function stripPayload(record: TraceRecord): TraceRecord {
  return {
    ...record,
    request: { ...record.request, state: summarizeState(record.request.state) },
  };
}

/**
 * Append-only JSONL store: one decision per line, one file per day, rotated
 * once a file reaches `maxRecordsPerFile`. No database, no index — `grep` and
 * `jq` work on these files directly.
 */
export class TraceStore {
  readonly dir: string;
  private readonly maxRecordsPerFile: number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lineCounts = new Map<string, number>();
  private readonly summaries = new Map<string, FileSummary>();

  constructor(dir: string, maxRecordsPerFile: number = DEFAULTS.maxRecordsPerFile) {
    this.dir = dir;
    this.maxRecordsPerFile = Math.max(1, Math.floor(maxRecordsPerFile));
  }

  async append(record: TraceRecord): Promise<string> {
    // Scrub the whole record, not just the payload fields: quality hints quote
    // the user's own option text verbatim, so a credential-shaped string can
    // reach disk through `hints[].message` just as easily as through `state`.
    const safe = scrub(record as unknown as JsonValue, secretValues()) as unknown as TraceRecord;
    const line = `${JSON.stringify(safe)}\n`;
    const target = await new Promise<string>((resolveTarget, rejectTarget) => {
      this.queue = this.queue.then(async () => {
        try {
          const file = await this.writeNow(line, safe.ts);
          resolveTarget(file);
        } catch (error) {
          rejectTarget(error);
        }
      });
    });
    return target;
  }

  private async writeNow(line: string, ts: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const date = dateKey(new Date(ts));
    let part = 1;
    while ((await this.countFor(fileName(date, part))) >= this.maxRecordsPerFile) part += 1;
    const name = fileName(date, part);
    await appendFile(join(this.dir, name), line, 'utf8');
    this.lineCounts.set(name, (this.lineCounts.get(name) ?? 0) + 1);
    return name;
  }

  private async countFor(name: string): Promise<number> {
    const cached = this.lineCounts.get(name);
    if (cached !== undefined) return cached;
    let count = 0;
    try {
      const raw = await readFile(join(this.dir, name), 'utf8');
      count = raw.split('\n').filter((l) => l.trim().length > 0).length;
    } catch {
      count = 0;
    }
    this.lineCounts.set(name, count);
    return count;
  }

  /** Trace files, newest first. */
  async files(): Promise<{ name: string; date: string; part: number }[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const parsed = names
      .map((name) => {
        const match = FILE_RE.exec(name);
        if (!match) return null;
        return { name, date: match[1] as string, part: Number(match[2] ?? 1) };
      })
      .filter((v): v is { name: string; date: string; part: number } => v !== null);
    parsed.sort((a, b) => (a.date === b.date ? b.part - a.part : a.date < b.date ? 1 : -1));
    return parsed;
  }

  async readAll(): Promise<TraceRecord[]> {
    const out: TraceRecord[] = [];
    for (const file of await this.files()) {
      const records = await this.readFileName(file.name);
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const record = records[i];
        if (record) out.push(record);
      }
    }
    return out;
  }

  async readFileName(name: string): Promise<TraceRecord[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, name), 'utf8');
    } catch {
      return [];
    }
    const records: TraceRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as TraceRecord;
        if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
          parsed.file = name;
          records.push(parsed);
        }
      } catch {
        /* tolerate a torn line from a killed process */
      }
    }
    return records;
  }

  /** Newest-first query across rotated files. */
  async read(query: TraceQuery = {}): Promise<TraceRecord[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 50, 5000));
    const offset = Math.max(0, query.offset ?? 0);
    const includePayload = query.includePayload !== false;
    const matched: TraceRecord[] = [];
    let skipped = 0;

    for (const file of await this.files()) {
      const records = await this.readFileName(file.name);
      for (let i = records.length - 1; i >= 0; i -= 1) {
        const record = records[i];
        if (!record) continue;
        if (!this.matches(record, query)) continue;
        if (skipped < offset) {
          skipped += 1;
          continue;
        }
        matched.push(includePayload ? record : stripPayload(record));
        if (matched.length >= limit) return matched;
      }
    }
    return matched;
  }

  private matches(record: TraceRecord, query: TraceQuery): boolean {
    if (query.label && record.label !== query.label) return false;
    if (query.id && record.id !== query.id) return false;
    if (query.runId && (record.runId ?? null) !== query.runId) return false;
    if (query.since && record.ts < query.since) return false;
    if (query.until && record.ts > query.until) return false;
    if (query.belowThreshold !== undefined) {
      if (record.status !== 'undecided' && record.confidence.min >= query.belowThreshold) return false;
    }
    return true;
  }

  /**
   * Aggregate view of one file, extended incrementally: only the bytes appended
   * since the last call are parsed, and a torn trailing line is left out of
   * `consumed` so it is reconsidered once the write completes.
   */
  private async summaryFor(name: string): Promise<FileSummary | null> {
    const path = join(this.dir, name);
    let info: { size: number; mtimeMs: number };
    try {
      const st = await stat(path);
      info = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      this.summaries.delete(name);
      return null;
    }

    const hit = this.summaries.get(name);
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit;

    // A truncating rewrite invalidates the prefix we already folded in.
    const base = hit && info.size >= hit.consumed ? hit : { consumed: 0, index: [] as IndexEntry[] };
    const text = await readRange(path, base.consumed, info.size - base.consumed);
    if (text === null) {
      this.summaries.delete(name);
      return null;
    }

    const lastNewline = text.lastIndexOf('\n');
    const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
    const index = base.index.slice();
    for (const line of complete.split('\n')) {
      const entry = indexOfLine(line);
      if (entry) index.push(entry);
    }
    const summary: FileSummary = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      consumed: base.consumed + Buffer.byteLength(complete, 'utf8'),
      index,
    };
    this.summaries.set(name, summary);
    return summary;
  }

  /** Per-label totals over the whole store, not just the most recent page. */
  async labels(threshold: number = DEFAULTS.confidenceThreshold): Promise<LabelSummary[]> {
    const byLabel = new Map<string, LabelSummary>();
    for (const file of await this.files()) {
      const summary = await this.summaryFor(file.name);
      if (!summary) continue;
      for (const entry of summary.index) {
        const existing = byLabel.get(entry.label) ?? {
          label: entry.label,
          count: 0,
          latest: entry.ts,
          undecided: 0,
          lowConfidence: 0,
        };
        existing.count += 1;
        if (entry.ts > existing.latest) existing.latest = entry.ts;
        if (entry.status === 'undecided') existing.undecided += 1;
        else if (entry.min < threshold) existing.lowConfidence += 1;
        byLabel.set(entry.label, existing);
      }
    }
    return [...byLabel.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1));
  }

  async stats(): Promise<StoreStats> {
    const files = await this.files();
    let records = 0;
    let bytes = 0;
    let oldest: string | null = null;
    let newest: string | null = null;
    for (const file of files) {
      const summary = await this.summaryFor(file.name);
      if (!summary) continue;
      // Sizes come from stat: re-serialising every record just to count bytes
      // was the single most expensive thing the panel did on each 3s poll.
      bytes += summary.size;
      records += summary.index.length;
      for (const entry of summary.index) {
        if (!oldest || entry.ts < oldest) oldest = entry.ts;
        if (!newest || entry.ts > newest) newest = entry.ts;
      }
    }
    return { records, files: files.length, bytes, dir: this.dir, oldest, newest };
  }

  /** Drop cached aggregates, e.g. after files are removed behind our back. */
  invalidate(): void {
    this.summaries.clear();
    this.lineCounts.clear();
  }

  /**
   * Whole-store aggregates computed from the lightweight index, so reporting on
   * two weeks of decisions costs no more than reporting on ten.
   */
  async overview(threshold: number = DEFAULTS.confidenceThreshold): Promise<StoreOverview> {
    const entries: IndexEntry[] = [];
    for (const file of await this.files()) {
      const summary = await this.summaryFor(file.name);
      if (summary) entries.push(...summary.index);
    }

    let undecided = 0;
    let flagged = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const latencies: number[] = [];
    const byLabel = new Map<string, LabelOverview>();
    const byDay = new Map<string, DayOverview>();

    for (const entry of entries) {
      const isUndecided = entry.status === 'undecided';
      const isFlagged = isUndecided || entry.min < threshold;
      if (isUndecided) undecided += 1;
      if (isFlagged) flagged += 1;
      inputTokens += entry.inputTokens;
      outputTokens += entry.outputTokens;
      if (entry.latencyMs > 0) latencies.push(entry.latencyMs);

      const day = entry.ts.slice(0, 10);
      const label = byLabel.get(entry.label) ?? { label: entry.label, count: 0, undecided: 0, flagged: 0 };
      label.count += 1;
      if (isUndecided) label.undecided += 1;
      if (isFlagged) label.flagged += 1;
      byLabel.set(entry.label, label);

      const bucket = byDay.get(day) ?? { day, count: 0, undecided: 0, flagged: 0 };
      bucket.count += 1;
      if (isUndecided) bucket.undecided += 1;
      if (isFlagged) bucket.flagged += 1;
      byDay.set(day, bucket);
    }

    latencies.sort((a, b) => a - b);
    return {
      records: entries.length,
      undecided,
      flagged,
      threshold,
      undecidedRate: entries.length ? round3(undecided / entries.length) : 0,
      inputTokens,
      outputTokens,
      latency: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.length ? (latencies[latencies.length - 1] as number) : 0,
      },
      byLabel: [...byLabel.values()].sort((a, b) => b.count - a.count),
      byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    };
  }

  /** Drain pending writes before process exit. */
  async flush(): Promise<void> {
    await this.queue;
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Nearest-rank percentile over an already-sorted sample. */
function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] as number;
}

/** Read `[start, start + length)` of a file as UTF-8, or null if it vanished. */
async function readRange(path: string, start: number, length: number): Promise<string | null> {
  if (length <= 0) return '';
  if (start === 0) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function indexOfLine(line: string): IndexEntry | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Partial<TraceRecord>;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.ts !== 'string') return null;
    const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    return {
      ts: parsed.ts,
      label: typeof parsed.label === 'string' ? parsed.label : 'default',
      status: parsed.status === 'undecided' ? 'undecided' : 'answered',
      min: num(parsed.confidence?.min),
      latencyMs: num(parsed.latencyMs),
      inputTokens: num(parsed.response?.usage?.input_tokens),
      outputTokens: num(parsed.response?.usage?.output_tokens),
    };
  } catch {
    /* tolerate a torn line from a killed process */
    return null;
  }
}
