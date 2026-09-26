# JevLens

**See what Jev decided at every step of your agent run.**

[中文](https://github.com/a742987/JevLens/blob/main/README.md) · **English** · [日本語](https://github.com/a742987/JevLens/blob/main/README_JP.md)

JevLens is a local MCP server plus a web panel for [TypeSafe Jev](https://typesafe.ai) decisions. It does not make decisions, does not route tools, and does not touch your agent's context. It wraps each `systemOne` call, records the full state, questions, answers, probability distribution, confidence and latency to an append-only JSONL file, and shows you a timeline so you can tell whether a weird agent behaviour came from Jev's judgement or from the LLM's generation.

Built for one-person, side-project, no-ops-budget developers:

- **No external services.** No database, no cloud, no Docker. A JSONL file per day, greppable with `grep` and `jq`.
- **No frontend build.** The panel is one HTML file; the chart library comes from a CDN.
- **No auth.** The panel binds to `127.0.0.1` and rejects other `Host` headers. It is a developer tool, not a SaaS.
- **No harness lock-in.** Standard MCP over stdio, so Claude Code, Codex, Cursor, OpenCode and any other MCP client can use it.
- **No extra model spend.** JevLens only forwards calls you already make. It never calls an LLM on its own.
- **Fail-open by design.** If the Jev API is unreachable, `jev_ask` returns an `undecided` result and your agent keeps running.

```
state + questions ──▶ [jev_ask] ──▶ TypeSafe Jev API ──▶ answers + probabilities + confidence
                          │
                          ├──▶ .jevlens/trace-YYYY-MM-DD.jsonl   (append-only)
                          │
                    [jevlens ui] ──▶ http://127.0.0.1:8787       (3s polling, same file)
```

The MCP server and the panel are two independent processes that share nothing but the JSONL file. Run the server while the agent works; start the panel only when you debug.

---

## Quickstart (about 5 minutes)

```bash
# 1. Register it with your coding agent (Claude Code shown; see "Wiring" below for others)
claude mcp add jevlens --env TYPESAFE_API_KEY=$TYPESAFE_API_KEY -- npx -y jevlens mcp

# 2. Ask your agent to call the tool, e.g.
#    "Use the jevlens jev_ask tool to classify this support ticket: I was charged twice, fix it today."

# 3. Look at what Jev actually returned
npx -y jevlens ui          # then open http://127.0.0.1:8787
```

No API key yet? Everything still works end to end against a deterministic offline provider, so you can try the panel and the tool shapes first:

```bash
npx -y jevlens ui --mock --port 8787
```

The panel then shows the mock provider badge (`mock`) on every record, so you never confuse demo data with real decisions.

---

## Wiring

JevLens is a plain stdio MCP server. The only secret, `TYPESAFE_API_KEY`, is read from the environment and is never written to config files, traces or exports.

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add jevlens --env TYPESAFE_API_KEY="$TYPESAFE_API_KEY" -- npx -y jevlens mcp
```

or in `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "jevlens": {
      "command": "npx",
      "args": ["-y", "jevlens", "mcp"],
      "env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" }
    }
  }
}
```
</details>

<details>
<summary><b>Codex CLI</b></summary>

In `~/.codex/config.toml`:

```toml
[mcp_servers.jevlens]
command = "npx"
args = ["-y", "jevlens", "mcp"]
env = { TYPESAFE_API_KEY = "tsk_live_..." }
```
</details>

<details>
<summary><b>Cursor</b></summary>

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "jevlens": {
      "command": "npx",
      "args": ["-y", "jevlens", "mcp"],
      "env": { "TYPESAFE_API_KEY": "tsk_live_..." }
    }
  }
}
```
</details>

<details>
<summary><b>OpenCode</b></summary>

In `opencode.json`:

```json
{
  "mcp": {
    "jevlens": {
      "type": "local",
      "command": ["npx", "-y", "jevlens", "mcp"],
      "environment": { "TYPESAFE_API_KEY": "tsk_live_..." },
      "enabled": true
    }
  }
}
```
</details>

<details>
<summary><b>Any other MCP client</b></summary>

Command: `npx -y jevlens mcp` (or `jevlens mcp` if installed globally), transport: `stdio`, and `TYPESAFE_API_KEY` in the child environment.
</details>

---

## Tools

### `jev_ask` — ask Jev, record everything

```json
{
  "label": "support-triage",
  "state": { "subject": "I was charged twice, please fix this today", "channel": "email" },
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "What is this ticket about?",
      "criteria": { "billing": "money charged wrongly", "technical": "a feature does not work", "other": null }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is it?",
      "criteria": ["routine", "within a day", "right now"]
    }
  }
}
```

`type` is one of `choice`, `score` or `noul`. A `noul` question is a bare "how true is this?" judgement with no option set — `{ "type": "noul", "instructions": "Does this diff look risky to merge?" }`, optionally with `criteria: { true, false }` labelling the two ends. It answers `{ "type": "noul", "noul": 0.87 }`, and its confidence is derived rather than returned: `|noul − 0.5| × 2`, so `0.5` reads as maximal ambiguity, `0` and `1` as certainty, and the value feeds `confidence.min` and `belowThreshold` like any other question. `score` answers also carry a `legend` mapping bucket index to bucket text, when the provider returns one.

Returns structured JSON only — no prose for the model to misread:
```json
{
  "id": "0f4d5c6e-…",
  "label": "support-triage",
  "status": "answered",
  "provider": "live",
  "model": "system-one-2025-09",
  "latency_ms": 812,
  "confidence": { "min": 0.78, "mean": 0.845, "perQuestion": { "category": 0.91, "urgency": 0.78 }, "belowThreshold": [] },
  "answers": {
    "category": { "type": "choice", "choice": "billing", "confidence": 0.91, "probabilities": { "billing": 0.91, "technical": 0.07, "other": 0.02 } },
    "urgency": { "type": "score", "score": 2, "confidence": 0.78, "probabilities": { "0": 0.05, "1": 0.17, "2": 0.78 } }
  },
  "hints": [],
  "error": null,
  "trace": "trace-2026-09-21.jsonl"
}
```

`status` is `"answered"` or `"undecided"`. An `undecided` result still contains an answer for every question (uniform probabilities, confidence `0`) plus the recorded `error`, so a Jev outage degrades judgement instead of breaking the run.

Optional fields: `model` (per-call model override) and `threshold` (per-call alert threshold).

### `jev_trace` — read recent decisions back

`{ "limit": 20, "label": "support-triage", "below_threshold": 0.7, "include_payload": false }`

Newest first, straight from the JSONL file. Set `include_payload: false` to drop the `state` body and keep the agent's context small.

### `jev_export` — write a report

`{ "format": "markdown", "label": "support-triage", "path": "reports/triage.md" }`

Writes Markdown or CSV into `.jevlens/exports/` (or your `path`) and returns `{ format, path, records, bytes }`. Markdown is a paste-ready bug report: state, question definitions, answer table, probability distribution, confidence flags, hints and errors. CSV is one row per question with the record metadata repeated, so a spreadsheet can pivot on it.

---

## The panel

```bash
jevlens ui --port 8787
```

- Timeline of every decision, newest first, with label, model, latency and minimum confidence.
- Probability bars per question; the returned answer is the highlighted bar.
- Confidence alerts: anything below the threshold is outlined in red and counted in the summary cards. The threshold is editable in the header and is persisted to `.jevlens/config.json`.
- Auto-refresh every 3 seconds (polling, no WebSocket), pausable, and idle while the tab is hidden.
- Expand a row for the raw `state`, question definitions, hints, error text and the full record.
- Label filter, "flagged only" toggle, limit selector and a text filter over the whole record.
- Confidence chart per decision (Chart.js from a pinned, SRI-hashed CDN URL; a text fallback appears if the CDN is unreachable).
- One-click `.md` / `.csv` export.
- Deep links for sharing a view: `/?label=support&threshold=0.8&flagged=1&expand=1&q=billing`, plus `limit=200` and `open=<id,id>` to expand specific records by trace id.

The panel reads the same file the server writes; nothing is uploaded, and no port other than the one you choose is opened.

---

## Question quality hints

Before each call, JevLens runs cheap static checks on your questions and attaches the results as advisory hints (`hints` in the tool response, an amber chip in the panel). Hints never block a call.

| Code | Meaning |
| --- | --- |
| `choice.overlap` | Two options mean nearly the same thing, so the probability split between them is uninterpretable. Compares labels and label+description text with word overlap plus character-bigram Dice, which works for English and CJK wording. |
| `choice.too_few_options` | Fewer than two options: nothing to discriminate. |
| `choice.too_many_options` | So many options that probability mass gets noisy. |
| `score.range_narrow` | Fewer than three buckets: a range that short cannot express much beyond a boolean. |
| `score.range_wide` | More than eight buckets: adjacent positions become indistinguishable. |
| `score.duplicate_bucket` / `score.endpoints_identical` | The same text reused at different positions of the scale. |
| `question.missing_instructions` | A question with no instruction text; Jev answers from the option wording alone. |
| `question.too_many` | More than twelve questions in one call. |

`noul` questions only get the two `question.*` checks: with no option set there is nothing to compare for overlap or bucket count.

Tune the overlap sensitivity with `overlapThreshold` in `.jevlens/config.json`.

---

## Storage

```
.jevlens/
├── config.json                 # optional: threshold, port, rotation, model
├── trace-2026-09-21.jsonl      # one decision per line
├── trace-2026-09-21-2.jsonl    # rotation part 2 once maxRecordsPerFile is hit
└── exports/                    # jevlens-<timestamp>.md | .csv
```

Append-only, one JSON object per line, daily files plus a per-file record cap. Torn lines from a killed process are skipped on read rather than breaking the panel. Each line also carries `agent` (the connected MCP client's `name@version`, when it reports one) and `response.usage` token counts; the panel shows both in the expanded raw record.

```bash
jq -r '[.ts, .label, .status, .confidence.min] | @tsv' .jevlens/trace-*.jsonl
grep -c '"status":"undecided"' .jevlens/trace-2026-09-21.jsonl
```

Credential hygiene is enforced at write time, not by convention, on three independent rules. A value stored under a key that looks like a credential (`api_key`, `apikey`, `access_token`, `auth_token`, `bearer`, `token`, `secret`, `password`, `passwd`, `credential`, `authorization`, `cookie`) becomes `[redacted]`. A string equal to any environment value whose *name* matches those same patterns and is at least 12 characters long gets masked. And a credential-shaped token inside any string — `sk…`, `pk…`, `pat…`, `ghp…`, `xoxb…` or `ai…` followed by 12 or more word characters — is replaced. Strings over 20 000 characters are truncated and nesting deeper than 12 levels is cut.

These are shape matches, not a general secret detector: an opaque `Bearer dXkR9f…` inside free-form `state` text survives unless `bearer`/`authorization` was the key or that exact value is also in your environment. Treat the trace file as sensitive and keep it out of version control — `.jevlens/` is gitignored for that reason. There is a test that puts a fake key into `state` and asserts it never reaches disk.

---

## Configuration

| Environment | Purpose | Default |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Jev API key (environment only; never persisted) | — |
| `TYPESAFE_BASE_URL` | Jev endpoint override | SDK default |
| `TYPESAFE_DEFAULT_MODEL` | model requested for every call | provider default |
| `JEVLENS_DIR` | trace directory | `./.jevlens` |
| `JEVLENS_PORT` / `JEVLENS_HOST` | panel bind | `8787` / `127.0.0.1` |
| `JEVLENS_CONFIDENCE_THRESHOLD` | alert threshold | `0.7` |
| `JEVLENS_MAX_RECORDS` | records per file before rotation | `5000` |
| `JEVLENS_TIMEOUT_MS` | Jev request timeout | `20000` |
| `JEVLENS_MOCK` | force the offline provider | off |
| `JEVLENS_RUN_ID` | tag every decision this process records with a run id | — |
| `JEVLENS_INSPECTOR_PORT` | port for `jevlens inspector` | `6274` |
| `JEVLENS_UI_HTML` | panel HTML path (dev/test hook) | `<package>/ui/index.html` |

`.jevlens/config.json` holds the same knobs (`confidenceThreshold`, `storageDir`, `host`, `port`, `maxRecordsPerFile`, `model`, `mock`, `overlapThreshold`). Precedence: built-in defaults < config file < environment < CLI flags.

```json
{ "confidenceThreshold": 0.8, "maxRecordsPerFile": 2000, "overlapThreshold": 0.55 }
```

---

## CLI

```
jevlens mcp         start the MCP server on stdio (what your agent launches)
jevlens ui          start the local decision timeline
jevlens stats       aggregate the trace on disk: tokens, latency, undecided rate, per label
jevlens doctor      check the install: Node, API key, trace dir, provider, one live Jev call
jevlens inspector   launch the official MCP Inspector against this server
jevlens help        usage;  -v / --version prints the version
```

Shared flags: `--port <n>`, `--host <addr>`, `--dir <path>`, `--threshold <0..1>`, `--mock`; `jevlens inspector` also takes `--inspector-port <n>`. They sit on top of the precedence chain, so a flag always beats config file and environment.

`jevlens stats` reads what is already on disk and adds nothing to it. `--label <name>` narrows the
per-label table to one label, and `--json` emits the whole aggregate as machine-readable JSON. Both
read `--dir` and `--threshold` like everything else.

`jevlens doctor` answers "why is everything coming back mock?" without reading the source: it prints
one line each for Node, the version, the trace directory, `TYPESAFE_API_KEY`, the provider in use, and
one real Jev round trip. A missing key is `FAIL` only when live calls were intended — with `--mock` it
is expected. Lines marked `warn` are normal on a fresh install; `jevlens doctor` exits non-zero only on
a `FAIL`, and its probe is never written to the trace.

`jevlens inspector` runs the official MCP Inspector against `jevlens mcp` via `npx` and prints the
`http://127.0.0.1:6274/…` URL (recent Inspector versions add an auth token to it). From there you can
call `jev_ask` by hand and watch the JSONL file grow.

---

## Development

```bash
npm install
npm run typecheck     # tsc -p tsconfig.dev.json (src + tests + examples)
npm run build         # tsc → dist/
npm test              # node --test on TypeScript sources, no build step needed
npm run check         # all three
node examples/seed-trace.ts   # write a few demo decisions with the offline provider
```

TypeScript, Node 22.18+ (`engines` is `>=22.18.0`; `npm test` runs the TypeScript sources directly through Node's type stripping, which is only unflagged from 22.18), ESM, and exactly three runtime dependencies: `@modelcontextprotocol/sdk`, `@typesafe-ai/sdk` and `zod` v4. Tests use the built-in Node runner and cover storage rotation and torn lines, config precedence, credential scrubbing, question-quality heuristics, fail-open paths (unreachable API, missing answers, unwritable storage), the mock provider's probability invariants, Markdown/CSV correctness, the HTTP API of the panel, and a real MCP client talking to the built server over stdio.

Publishing:

```bash
npm publish --access public   # prepublishOnly runs a clean build, the type check and the test suite
```

---

## What JevLens deliberately does not do

| Common Jev harness direction | JevLens |
| --- | --- |
| Use Jev for tool selection or risk gating | Records and displays decisions; makes none |
| Filter tool output or compress context | Never touches the agent's context |
| Compare Jev against other models | Traces one agent run at a time |
| Ship a preset question bank or linter | Shows what *your* questions actually returned |
| Enterprise audit and compliance | Local files, no accounts, no quotas |

Also out of scope for v0.1: databases, indexes, query languages, auth, multi-tenancy, WebSocket push, automatic code changes, decision-chain orchestration.

Later directions that fit the same positioning: decision-chain visualisation (linking related calls into a tree), local PII masking before the write, read-only sharing of an exported run, and a tighter loop with a Jev question-quality linter.

## License

MIT
