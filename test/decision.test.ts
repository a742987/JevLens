import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureDecision, createContext, sanitizeLabel } from '../src/decision.ts';
import { MockJevProvider, decide, fallbackAnswers } from '../src/jev.ts';
import type { Questions, TraceRecord } from '../src/types.ts';
import { BrokenProvider, contextFor, tempWorkspace, ticketState, triageQuestions } from './helpers.ts';

test('jev_ask records the full exchange: state, questions, answers, probabilities, confidence, latency', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config);
  const result = await captureDecision(ctx, { state: ticketState, questions: triageQuestions, label: 'support' });

  assert.equal(result.record.status, 'answered');
  assert.equal(result.wrote, true);
  assert.equal(result.record.label, 'support');
  assert.equal(result.record.request.state, ticketState, 'the raw state is stored as sent');
  assert.deepEqual(Object.keys(result.record.request.questions), ['category', 'urgency']);
  const category = result.record.response?.answers.category;
  assert.equal(category?.type, 'choice');
  assert.ok(category && category.probabilities.billing > 0.5, 'probability distribution captured');
  assert.ok(result.record.confidence.perQuestion.urgency !== undefined, 'per-question confidence');
  assert.ok(result.record.latencyMs >= 0);
  assert.match(result.record.id, /^[0-9a-f-]{36}$/);

  const stored = await readFile(join(workspace.config.storageDir, result.file ?? ''), 'utf8');
  const parsed = JSON.parse(stored.trim().split('\n').at(-1) ?? '{}') as TraceRecord;
  assert.equal(parsed.id, result.record.id, 'what the panel reads is what the tool returned');
  await workspace.cleanup();
});

test('a low-confidence decision is flagged against the threshold', async () => {
  const workspace = await tempWorkspace({ confidenceThreshold: 0.85 });
  const ctx = contextFor(workspace.config);
  const result = await captureDecision(ctx, { state: ticketState, questions: triageQuestions });
  assert.equal(result.record.confidence.belowThreshold.length > 0, true, '0.85 flags the fake answers');
  assert.equal(result.record.confidence.min < 0.85, true);

  const lenient = await captureDecision(ctx, { state: ticketState, questions: triageQuestions, threshold: 0.3 });
  assert.deepEqual(lenient.record.confidence.belowThreshold, [], 'the per-call threshold overrides the config');
  await workspace.cleanup();
});

test('fail-open: an unreachable Jev still returns an undecided result and records the error', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config, new BrokenProvider('unreachable'));
  const result = await captureDecision(ctx, { state: ticketState, questions: triageQuestions });

  assert.equal(result.record.status, 'undecided');
  assert.equal(result.record.error?.name, 'Error');
  assert.match(result.record.error?.message ?? '', /ECONNREFUSED/);
  assert.equal(result.wrote, true, 'the failure itself is traceable');
  assert.equal(result.record.confidence.min, 0, 'degrades to zero confidence, never a fake high number');
  for (const name of Object.keys(triageQuestions)) {
    assert.ok(result.record.response?.answers[name], `${name} still has an answer shape`);
  }
  await workspace.cleanup();
});

test('fail-open survives a provider that never resolves an answer', async () => {
  const workspace = await tempWorkspace();
  const ctx = contextFor(workspace.config, {
    kind: 'live',
    note: 'empty',
    async ask() {
      return { model: 'jev-1', answers: {}, usage: null };
    },
  });
  const result = await captureDecision(ctx, { state: 'x', questions: triageQuestions });
  assert.equal(result.record.status, 'undecided');
  assert.equal(result.record.error?.name, 'IncompleteAnswer');
  assert.match(result.record.error?.message ?? '', /category/);
  await workspace.cleanup();
});

test('a failed trace write is reported but never breaks the caller', async () => {
  const workspace = await tempWorkspace();
  const blocker = join(workspace.root, 'blocked');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(blocker, 'not a directory', 'utf8');
  const ctx = contextFor({ ...workspace.config, storageDir: join(blocker, 'traces') });
  const result = await captureDecision(ctx, { state: ticketState, questions: triageQuestions });
  assert.equal(result.wrote, false);
  assert.equal(result.file, null);
  assert.equal(result.record.status, 'answered', 'the agent still gets its decision');
  assert.ok(ctx.diagnostics.some((line) => line.includes('trace write failed')));
  await workspace.cleanup();
});

test('the API key never reaches the trace file', async () => {
  const workspace = await tempWorkspace();
  const key = 'tsk_live_supersecretvalue123';
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = key;
  try {
    const ctx = createContext(workspace.config, {});
    const result = await captureDecision(ctx, {
      state: { text: `call Jev with ${key}`, headers: { Authorization: `Bearer ${key}` } },
      questions: { note: { type: 'noul', instructions: `does ${key} appear?` } } as Questions,
    });
    const stored = await readFile(join(workspace.config.storageDir, result.file ?? ''), 'utf8');
    assert.ok(!stored.includes(key), 'key value is masked in the JSONL');
    assert.match(stored, /\[redacted\]/);
    assert.equal(ctx.provider.kind, 'mock', 'the key is only ever handed to the SDK');
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
  await workspace.cleanup();
});

test('labels are trimmed, collapsed and bounded', () => {
  assert.equal(sanitizeLabel(undefined), 'default');
  assert.equal(sanitizeLabel('  '), 'default');
  assert.equal(sanitizeLabel('support\tnight\n shift'), 'support night shift');
  assert.equal(sanitizeLabel('x'.repeat(200)).length, 60);
});

test('decide() keeps working with the documented fallback shapes', async () => {
  const outcome = await decide(new BrokenProvider('down'), { state: 'a', questions: triageQuestions });
  assert.equal(outcome.status, 'undecided');
  const expected = fallbackAnswers(triageQuestions);
  assert.deepEqual(outcome.answers, expected);
  assert.equal((expected.category as { confidence: number }).confidence, 0);
});

test('the mock provider is deterministic and produces a usable distribution', async () => {
  const provider = new MockJevProvider('test mock');
  const request = { state: ticketState, questions: triageQuestions };
  const a = await provider.ask(request);
  const b = await provider.ask(request);
  assert.deepEqual(a.answers, b.answers, 'same request, same answer');

  const category = a.answers.category;
  assert.equal(category?.type, 'choice');
  if (category?.type === 'choice') {
    const values = Object.values(category.probabilities);
    const sum = values.reduce((total, value) => total + value, 0);
    assert.ok(Math.abs(sum - 1) < 0.005, `probabilities sum to 1 (got ${sum})`);
    assert.ok(Object.keys(category.probabilities).includes(category.choice), 'winner exists in the distribution');
    assert.equal(Math.round(category.confidence * 1000) / 1000, category.probabilities[category.choice]);
    assert.equal(
      category.probabilities[category.choice],
      Math.max(...values),
      'the returned choice is the argmax of its own distribution, like the real API',
    );
  }
  const urgency = a.answers.urgency;
  if (urgency?.type === 'score') {
    assert.ok(Number.isInteger(urgency.score) && urgency.score >= 0 && urgency.score < 3);
    assert.equal(urgency.legend?.[String(urgency.score)], ['routine', 'soon', 'right now'][urgency.score]);
  } else {
    assert.fail('score answer expected');
  }
});

test('createProvider falls back to the mock when no key is configured', async () => {
  const workspace = await tempWorkspace();
  const { createProvider } = await import('../src/jev.ts');
  assert.equal(createProvider({ ...workspace.config, mock: false }, {}).kind, 'mock');
  assert.equal(createProvider({ ...workspace.config, mock: true }, { TYPESAFE_API_KEY: 'tsk_live_whatever123' }).kind, 'mock');
  assert.equal(
    createProvider({ ...workspace.config, mock: false }, { TYPESAFE_API_KEY: 'tsk_live_whatever123' }).kind,
    'live',
  );
  await workspace.cleanup();
});
