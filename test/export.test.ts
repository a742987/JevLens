import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportFileName, toCsv, toMarkdown } from '../src/export.ts';
import { captureDecision } from '../src/decision.ts';
import { TraceStore } from '../src/storage.ts';
import type { Questions } from '../src/types.ts';
import { BrokenProvider, contextFor, tempWorkspace, ticketState, triageQuestions } from './helpers.ts';

test('markdown reports are self-contained enough to paste into an issue', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  const answered = await captureDecision(ctx, { state: ticketState, questions: triageQuestions, label: 'support' });
  const undecided = await captureDecision({ ...ctx, provider: new BrokenProvider('outage') }, {
    state: 'router decision',
    questions: { route: { type: 'choice', instructions: 'which file?', criteria: { read: 'read it', write: 'write it' } } } as Questions,
    label: 'router',
  });

  const body = toMarkdown([answered.record, undecided.record], { threshold: 0.7, providerNote: 'fake provider' });
  assert.match(body, /# JevLens decision report/);
  assert.match(body, /- records: 2/);
  assert.match(body, /- undecided: 1/);
  assert.match(body, /## 1\. `support`/);
  assert.match(body, /## 2\. `router`/);
  assert.match(body, /UNDECIDED/);
  assert.match(body, /\| category \| choice \| billing \|/);
  assert.match(body, /charged twice/, 'state is embedded for reproduction');
  assert.match(body, /jev-fake-1/);
  assert.match(body, /connect ECONNREFUSED|Error/, 'the error text is reported');
  assert.ok(!body.includes('TYPESAFE_API_KEY'), 'no credential plumbing in the report');
  await workspace.cleanup();
});

test('pipes inside question names and options do not break the markdown table', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  const result = await captureDecision(ctx, {
    state: 'x',
    questions: { 'q|1': { type: 'choice', instructions: 'pick', criteria: { 'yes|no': 'either side' } } },
  });
  const body = toMarkdown([result.record], {});
  const row = body.split('\n').find((line) => line.startsWith('| q\\|'));
  assert.ok(row, 'the question row is present');
  const unescaped = (row ?? '').replaceAll('\\|', '!');
  assert.equal(unescaped.split('|').length - 2, 5, 'five columns survive: name, type, answer, confidence, probabilities');
  assert.match(row ?? '', /q\\\|1/);
  assert.match(row ?? '', /yes\\\|no/);
  await workspace.cleanup();
});

test('hints reach the report so question problems are discussable', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  const result = await captureDecision(ctx, {
    state: 'x',
    questions: {
      bucket: { type: 'choice', instructions: 'pick one', criteria: { bug_report: 'report a bug', bug_reports: 'report bugs' } },
      heat: { type: 'score', instructions: 'how hot', criteria: ['cold', 'hot'] },
    },
  });
  const body = toMarkdown([result.record], {});
  assert.match(body, /### Question quality hints/);
  assert.match(body, /choice\.overlap/);
  assert.match(body, /score\.range_narrow/);
  await workspace.cleanup();
});

test('csv has one row per question and escapes awkward values', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  const messy = { note: 'line one, "quoted"\nline two', count: 3 };
  const result = await captureDecision(ctx, { state: messy, questions: triageQuestions, label: 'support' });
  const csv = toCsv([result.record]);
  const lines = csv.trimEnd().split('\r\n');
  const header = lines[0]?.split(',') ?? [];
  assert.equal(header.length, 17, `unexpected columns: ${header.join('|')}`);
  assert.equal(header[0], 'id');
  assert.equal(lines.length, 3, 'header + one row per question');
  const cells = parseCsvLine(lines[1] ?? '');
  assert.equal(cells.length, header.length, 'a comma inside the state does not shift columns');
  assert.deepEqual(JSON.parse(cells[16] ?? 'null'), messy, 'the state survives CSV escaping intact');
  assert.ok(csv.endsWith('\r\n'));
  await workspace.cleanup();
});

/** Minimal quote-aware CSV line reader: enough to prove the writer is correct. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

test('an empty trace still exports valid documents', () => {
  const markdown = toMarkdown([], {});
  assert.match(markdown, /- records: 0/);
  const csv = toCsv([]);
  assert.equal(csv.trimEnd().split('\r\n').length, 1, 'header only');
});

test('file names are timestamped and format-correct', () => {
  const date = new Date('2026-03-04T05:06:07.008Z');
  assert.equal(reportFileName('markdown', date), 'jevlens-2026-03-04T05-06-07.md');
  assert.equal(reportFileName('csv', date), 'jevlens-2026-03-04T05-06-07.csv');
});

test('a store written by one process is readable by another', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  await captureDecision(ctx, { state: ticketState, questions: triageQuestions, label: 'support' });
  // Fresh store instance: the MCP server and the panel never share memory.
  const reopened = new TraceStore(workspace.config.storageDir, workspace.config.maxRecordsPerFile);
  const records = await reopened.read({ limit: 10 });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.label, 'support');
  const stats = await reopened.stats();
  assert.equal(stats.records, 1);
  assert.ok(stats.bytes > 0);
  assert.ok(stats.newest);
  await workspace.cleanup();
});
