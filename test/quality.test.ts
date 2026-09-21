import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseQuestions, textSimilarity } from '../src/quality.ts';
import type { Questions } from '../src/types.ts';

function codes(questions: Questions): string[] {
  return analyseQuestions(questions).map((hint) => hint.code);
}

test('similarity sees paraphrases as overlapping and unrelated text as not', () => {
  assert.ok(textSimilarity('billing issue', 'billing issues') > 0.8);
  assert.ok(textSimilarity('report a bug', 'report bugs') > 0.6);
  assert.ok(textSimilarity('billing', 'feature request') < 0.3);
  assert.ok(textSimilarity('无法登录账号', '账号登录不上') > 0.3, 'CJK overlap is visible');
  assert.equal(textSimilarity('', ''), 0);
});

test('choice options that mean the same thing are flagged', () => {
  const found = analyseQuestions({
    category: {
      type: 'choice',
      instructions: 'What is this about?',
      criteria: {
        billing_issue: 'problem with billing',
        billing_problem: 'problem with billing invoices',
        feature_request: 'request a new feature',
      },
    },
  });
  const overlap = found.filter((hint) => hint.code === 'choice.overlap');
  assert.equal(overlap.length, 1, 'exactly the overlapping pair is reported');
  assert.match(overlap[0]?.message ?? '', /billing_issue/);
  assert.match(overlap[0]?.message ?? '', /billing_problem/);
  assert.equal(overlap[0]?.severity, 'warn');
});

test('a clean choice question produces no warnings', () => {
  const hints = analyseQuestions({
    category: {
      type: 'choice',
      instructions: 'What is this about?',
      criteria: { billing: 'money', technical: 'broken', feature: 'new capability', spam: 'junk' },
    },
  });
  assert.deepEqual(hints, []);
});

test('score ranges that are too narrow or too wide are flagged', () => {
  assert.ok(codes({ u: { type: 'score', instructions: 'urgency', criteria: ['low', 'high'] } }).includes('score.range_narrow'));
  const wide = Array.from({ length: 10 }, (_, i) => `level ${i}`);
  assert.ok(codes({ u: { type: 'score', instructions: 'urgency', criteria: wide } }).includes('score.range_wide'));
  const healthy = ['routine', 'soon', 'right now'];
  assert.deepEqual(codes({ u: { type: 'score', instructions: 'urgency', criteria: healthy } }), []);
  assert.ok(codes({ u: { type: 'score', instructions: 'x', criteria: ['same', 'other', 'same'] } }).includes('score.duplicate_bucket'));
});

test('structural hints cover empty questions and single options', () => {
  assert.ok(codes({ odd: { type: 'choice', instructions: 'only one way', criteria: { yes: null } } }).includes('choice.too_few_options'));
  assert.ok(codes({ blank: { type: 'noul', criteria: null } }).includes('question.missing_instructions'));
});

test('hints are advisory: a huge question set is reported, never thrown on', () => {
  const many: Questions = {};
  for (let i = 0; i < 14; i += 1) {
    many[`q${i}`] = { type: 'noul', instructions: `is condition ${i} true?` };
  }
  assert.ok(codes(many).includes('question.too_many'));
  assert.doesNotThrow(() => analyseQuestions(many));
  assert.doesNotThrow(() => analyseQuestions({} as Questions));
});

test('overlap threshold is configurable', () => {
  const questions: Questions = {
    c: { type: 'choice', instructions: 'pick', criteria: { 'urgent now': 'asap', 'sort of urgent': 'soonish' } },
  };
  const strict = analyseQuestions(questions, { overlapThreshold: 0.95 });
  const loose = analyseQuestions(questions, { overlapThreshold: 0.2 });
  assert.equal(strict.filter((h) => h.code === 'choice.overlap').length, 0);
  assert.ok(loose.filter((h) => h.code === 'choice.overlap').length >= 1);
});
