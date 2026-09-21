/**
 * Seed the panel with a handful of realistic decisions so you can see what
 * JevLens looks like before wiring it into an agent.
 *
 *   node examples/seed-trace.ts        # writes into ./.jevlens using the mock provider
 *   jevlens ui                         # then open http://127.0.0.1:8787
 */
import { loadConfig } from '../src/config.ts';
import { captureDecision, createContext, type AskInput } from '../src/decision.ts';
import { MockJevProvider } from '../src/jev.ts';

const config = { ...loadConfig(), mock: true };
const ctx = createContext(config, {}, new MockJevProvider('seeded example run'));

const runs: AskInput[] = [
  {
    label: 'support-triage',
    state: { subject: 'I was charged twice, please fix this today', channel: 'email', plan: 'pro' },
    questions: {
      category: {
        type: 'choice' as const,
        instructions: 'What is this ticket about?',
        criteria: { billing: 'money charged wrongly', technical: 'a feature does not work', other: 'none of these' },
      },
      urgency: {
        type: 'score' as const,
        instructions: 'How urgent is it?',
        criteria: ['routine', 'within a day', 'right now'],
      },
    },
  },
  {
    // Deliberately overlapping options so the question-quality hints light up.
    label: 'vague-question',
    state: { message: 'the export button does nothing when clicked twice' },
    questions: {
      kind: {
        type: 'choice' as const,
        instructions: 'Which kind of report is this?',
        criteria: { bug_report: 'report a bug', bug_reports: 'report a bug in the product', idea: 'a new idea' },
      },
      heat: { type: 'score' as const, instructions: 'How hot?', criteria: ['cold', 'hot'] },
    },
  },
  {
    label: 'tool-router',
    state: { request: 'summarise the PDF in my home directory', tools: ['read_file', 'run_shell', 'web_search'] },
    questions: {
      next_tool: {
        type: 'choice' as const,
        instructions: 'Which tool should run next?',
        criteria: { read_file: 'open a local file', run_shell: 'execute a command', web_search: 'search the internet' },
      },
    },
  },
  {
    label: 'code-review',
    state: { diff: '@@ -12,7 +12,9 @@\n+const total = items.reduce((a, b) => a + b.price, 0);' },
    questions: {
      risky: { type: 'noul' as const, instructions: 'Does this diff look risky to merge?' },
      area: {
        type: 'choice' as const,
        instructions: 'Which area does this touch?',
        criteria: { pricing: 'money maths', ui: 'presentation', infra: 'deployment' },
      },
    },
  },
];

for (const run of runs) {
  const result = await captureDecision(ctx, run, { agent: 'example-script' });
  const { record } = result;
  const answers = Object.entries(record.response?.answers ?? {})
    .map(([name, answer]) => {
      if (answer.type === 'choice') return `${name}=${answer.choice}@${answer.confidence.toFixed(2)}`;
      if (answer.type === 'score') return `${name}=${answer.score}@${answer.confidence.toFixed(2)}`;
      return `${name}=noul ${answer.noul.toFixed(2)}`;
    })
    .join('  ');
  process.stdout.write(
    `${record.status === 'undecided' ? 'UNDECIDED' : 'answered '} ${record.label.padEnd(16)} ${answers}` +
      `${record.hints.length ? `  (${record.hints.length} hints)` : ''}\n`,
  );
}

process.stdout.write(`\ntrace: ${config.storageDir}\npanel: http://${config.host}:${config.port}\n`);
