import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type JevLensConfig } from '../src/config.ts';
import { createContext, type JevLensContext } from '../src/decision.ts';
import type { JevProvider, JevReply, JevRequest } from '../src/jev.ts';
import type { Questions } from '../src/types.ts';

/**
 * The CLI entry to spawn.
 *
 * It deliberately defaults to the TypeScript source rather than "dist if it
 * happens to exist". A stale build makes the suite test last week's code, and
 * the failures point at the wrong file — which cost a debugging cycle here.
 * Set JEVLENS_TEST_ENTRY=dist/cli.js to run the same tests against the shipped
 * artefact, which is what CI does after `npm run build`.
 */
export const cliEntry: string = process.env.JEVLENS_TEST_ENTRY
  ? resolve(process.env.JEVLENS_TEST_ENTRY)
  : fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export interface TempWorkspace {
  config: JevLensConfig;
  root: string;
  cleanup(): Promise<void>;
}

export async function tempWorkspace(overrides: Partial<JevLensConfig> = {}): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'jevlens-test-'));
  const base = loadConfig(root, {});
  const config: JevLensConfig = {
    ...base,
    storageDir: join(root, '.jevlens'),
    mock: true,
    port: 0,
    ...overrides,
  };
  return { config, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function contextFor(config: JevLensConfig, provider?: JevProvider): JevLensContext {
  return createContext(config, {}, provider ?? new FakeProvider());
}

export const triageQuestions: Questions = {
  category: {
    type: 'choice',
    instructions: 'What is this support ticket about?',
    criteria: { billing: 'money charged incorrectly', technical: 'something is broken', other: null },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this ticket?',
    criteria: ['routine', 'soon', 'right now'],
  },
};

export const ticketState = {
  subject: 'I was charged twice, please fix',
  body: 'Two identical charges on the same day. I need this resolved today.',
  channel: 'email',
};

/** Provider double: returns a fixed reply, or throws to exercise fail-open. */
export class FakeProvider implements JevProvider {
  readonly kind = 'live' as const;
  readonly note = 'fake provider';
  calls: JevRequest[] = [];
  failure: Error | null = null;
  reply: Partial<JevReply> = { model: 'jev-fake-1', usage: { input_tokens: 120, output_tokens: 8 } };
  answerBuilder: ((request: JevRequest) => JevReply['answers']) | null;

  constructor(answerBuilder?: (request: JevRequest) => JevReply['answers']) {
    this.answerBuilder = answerBuilder ?? null;
  }

  async ask(request: JevRequest): Promise<JevReply> {
    this.calls.push(request);
    if (this.failure) throw this.failure;
    const answers = this.answerBuilder
      ? this.answerBuilder(request)
      : {
          category: { type: 'choice' as const, choice: 'billing', confidence: 0.91, probabilities: { billing: 0.91, technical: 0.07, other: 0.02 } },
          urgency: { type: 'score' as const, score: 2, confidence: 0.78, probabilities: { '0': 0.05, '1': 0.17, '2': 0.78 }, legend: { '0': 'routine', '1': 'soon', '2': 'right now' } },
        };
    return { model: this.reply.model ?? 'jev-fake-1', answers, usage: this.reply.usage ?? null };
  }
}

/** Always throws: models an unreachable or misconfigured Jev API. */
export class BrokenProvider implements JevProvider {
  readonly kind = 'live' as const;
  readonly note: string;
  readonly error: unknown;

  constructor(note: string, error: unknown = new Error('connect ECONNREFUSED api.typesafe.ai:443')) {
    this.note = note;
    this.error = error;
  }

  async ask(): Promise<JevReply> {
    throw this.error;
  }
}
