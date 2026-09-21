import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS } from './config.ts';
import { scrub, secretValues } from './sanitize.ts';
import type { Answers, JsonValue, Questions, TraceRecord } from './types.ts';

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
  bytes: number;
  dir: string;
  oldest: string | null;
  newest: string | null;
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

  constructor(dir: string, maxRecordsPerFile: number = DEFAULTS.maxRecordsPerFile) {
    this.dir = dir;
    this.maxRecordsPerFile = Math.max(1, Math.floor(maxRecordsPerFile));
  }

  async append(record: TraceRecord): Promise<string> {
    const secrets = secretValues();
    const response = record.response;
    const safe: TraceRecord = {
      ...record,
      request: {
        ...record.request,
        state: scrub(record.request.state, secrets),
        questions: scrub(record.request.questions as unknown as JsonValue, secrets) as unknown as Questions,
      },
      response: response
        ? { ...response, answers: scrub(response.answers as unknown as JsonValue, secrets) as unknown as Answers }
        : null,
    };
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
    if (query.since && record.ts < query.since) return false;
    if (query.until && record.ts > query.until) return false;
    if (query.belowThreshold !== undefined) {
      if (record.status !== 'undecided' && record.confidence.min >= query.belowThreshold) return false;
    }
    return true;
  }

  async labels(threshold: number = DEFAULTS.confidenceThreshold): Promise<LabelSummary[]> {
    const all = await this.read({ limit: 5000 });
    const byLabel = new Map<string, LabelSummary>();
    for (const record of all) {
      const entry = byLabel.get(record.label) ?? {
        label: record.label,
        count: 0,
        latest: record.ts,
        undecided: 0,
        lowConfidence: 0,
      };
      entry.count += 1;
      if (record.ts > entry.latest) entry.latest = record.ts;
      if (record.status === 'undecided') entry.undecided += 1;
      if (record.status !== 'undecided' && record.confidence.min < threshold) entry.lowConfidence += 1;
      byLabel.set(record.label, entry);
    }
    return [...byLabel.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1));
  }

  async stats(threshold: number = DEFAULTS.confidenceThreshold): Promise<StoreStats> {
    const files = await this.files();
    let records = 0;
    let bytes = 0;
    let oldest: string | null = null;
    let newest: string | null = null;
    for (const file of files) {
      const found = await this.readFileName(file.name);
      records += found.length;
      for (const record of found) {
        bytes += JSON.stringify(record).length;
        if (!oldest || record.ts < oldest) oldest = record.ts;
        if (!newest || record.ts > newest) newest = record.ts;
      }
    }
    void threshold;
    return { records, files: files.length, bytes, dir: this.dir, oldest, newest };
  }

  /** Drain pending writes before process exit. */
  async flush(): Promise<void> {
    await this.queue;
  }
}
