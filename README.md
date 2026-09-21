# JevLens

**Jev 在你 Agent 运行的每一步上判了什么，全都看得见。**

**中文** · [English](https://github.com/a742987/JevLens/blob/main/README_EN.md) · [日本語](https://github.com/a742987/JevLens/blob/main/README_JP.md)

JevLens 是一个本地 MCP 服务器，外加一个查看 [TypeSafe Jev](https://typesafe.ai) 决策的网页面板。它不做决策，不做工具路由，也不碰你 Agent 的上下文。它包住每一次 `systemOne` 调用，把完整的 state、问题、答案、概率分布、置信度与延迟写入一个只追加的 JSONL 文件，并呈现为一条时间线，让你能分辨某个古怪的 Agent 行为究竟出自 Jev 的判断，还是出自 LLM 的生成。

面向单人、副业项目、没有运维预算的开发者：

- **无外部服务。** 没有数据库、没有云端、没有 Docker。每天一个 JSONL 文件，用 `grep` 和 `jq` 就能查。
- **无前端构建。** 面板就是一个 HTML 文件；图表库来自 CDN。
- **无鉴权。** 面板绑定 `127.0.0.1`，其他 `Host` 头一律拒绝。它是开发者工具，不是 SaaS。
- **无 harness 锁定。** 标准 MCP over stdio，因此 Claude Code、Codex、Cursor、OpenCode 以及任何其它 MCP 客户端都能用。
- **无额外模型开销。** JevLens 只转发你本来就要发出的调用，从不自行调用 LLM。
- **按 fail-open 设计。** 若 Jev API 不可达，`jev_ask` 返回 `undecided` 结果，你的 Agent 继续运行。

```
state + questions ──▶ [jev_ask] ──▶ TypeSafe Jev API ──▶ answers + probabilities + confidence
                          │
                          ├──▶ .jevlens/trace-YYYY-MM-DD.jsonl   (append-only)
                          │
                    [jevlens ui] ──▶ http://127.0.0.1:8787       (3s polling, same file)
```

MCP 服务器与面板是两个独立进程，除 JSONL 文件外不共享任何东西。Agent 干活时开着服务器；只在调试时才启动面板。

---

## 快速开始（约 5 分钟）

```bash
# 1. Register it with your coding agent (Claude Code shown; see "Wiring" below for others)
claude mcp add jevlens --env TYPESAFE_API_KEY=$TYPESAFE_API_KEY -- npx -y jevlens mcp

# 2. Ask your agent to call the tool, e.g.
#    "Use the jevlens jev_ask tool to classify this support ticket: I was charged twice, fix it today."

# 3. Look at what Jev actually returned
npx -y jevlens ui          # then open http://127.0.0.1:8787
```

还没有 API key？整套流程照样能对着一个确定性的离线 provider 端到端跑通，所以你可以先试面板和工具的调用形态：

```bash
npx -y jevlens ui --mock --port 8787
```

此时面板会在每条记录上显示 mock provider 徽标（`mock`），你绝不会把演示数据误当成真实决策。

---

## 接入

JevLens 是一个普通的 stdio MCP 服务器。唯一的密钥 `TYPESAFE_API_KEY` 只从环境变量读取，绝不写入配置文件、trace 或导出文件。

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add jevlens --env TYPESAFE_API_KEY="$TYPESAFE_API_KEY" -- npx -y jevlens mcp
```

或写进项目根目录的 `.mcp.json`：

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

写在 `~/.codex/config.toml` 里：

```toml
[mcp_servers.jevlens]
command = "npx"
args = ["-y", "jevlens", "mcp"]
env = { TYPESAFE_API_KEY = "tsk_live_..." }
```
</details>

<details>
<summary><b>Cursor</b></summary>

写在 `.cursor/mcp.json` 里：

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

写在 `opencode.json` 里：

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
<summary><b>任何其它 MCP 客户端</b></summary>

命令：`npx -y jevlens mcp`（全局安装后也可以是 `jevlens mcp`），传输方式：`stdio`，并在子进程环境里给出 `TYPESAFE_API_KEY`。
</details>

---

## 工具

### `jev_ask` — 向 Jev 提问，并记录一切

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

`type` 取 `choice`、`score` 或 `noul` 之一。`noul` 问题没有选项集，只是一次「这话有多真」的判断 — `{ "type": "noul", "instructions": "Does this diff look risky to merge?" }`，可选地再带一个 `criteria: { true, false }` 给两端命名。它的回答是 `{ "type": "noul", "noul": 0.87 }`，其置信度不由接口返回而是推导得出：`|noul − 0.5| × 2`，因此 `0.5` 读作最大模糊，`0` 和 `1` 读作确定；该值同其它问题一样进入 `confidence.min` 与 `belowThreshold`。当 provider 返回 `legend` 时，`score` 的回答里也会带上把档位下标映射到档位文本的 `legend`。

返回的只有结构化 JSON — 不给模型留下任何可能误读的散文：
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

`status` 为 `"answered"` 或 `"undecided"`。`undecided` 结果依然为每个问题给出答案（均匀概率，置信度 `0`），并附上记录下来的 `error`，所以 Jev 停服只会让判断质量降级，而不是打断这次运行。

可选字段：`model`（单次调用覆盖模型）与 `threshold`（单次调用告警阈值）。

### `jev_trace` — 回读最近的决策

`{ "limit": 20, "label": "support-triage", "below_threshold": 0.7, "include_payload": false }`

最新的在前，直接读自 JSONL 文件。设置 `include_payload: false` 可以去掉 `state` 正文，让 Agent 的上下文保持紧凑。

### `jev_export` — 写出报告

`{ "format": "markdown", "label": "support-triage", "path": "reports/triage.md" }`

把 Markdown 或 CSV 写入 `.jevlens/exports/`（或你指定的 `path`），并返回 `{ format, path, records, bytes }`。Markdown 是一份可直接粘贴的缺陷报告：state、问题定义、答案表、概率分布、置信度标记、hints 与 error。CSV 则每个问题一行、重复记录级元数据，方便表格软件做透视。

---

## 面板

```bash
jevlens ui --port 8787
```

- 每条决策的时间线，最新的在前，含 label、model、延迟与最低置信度。
- 每个问题的概率条；被返回的那个答案是高亮条。
- 置信度告警：低于阈值的记录用红框描出，并计入概览卡片。阈值可在页头直接修改，并持久化到 `.jevlens/config.json`。
- 每 3 秒自动刷新（轮询，无 WebSocket），可暂停，标签页隐藏时保持空闲。
- 展开某行可看到原始 `state`、问题定义、hints、错误文本与完整记录。
- label 过滤、"flagged only" 开关、条数选择器，以及作用于整条记录的文本过滤。
- 每条决策的置信度图（Chart.js 取自固定版本、带 SRI 哈希的 CDN URL；CDN 不可达时退化为文本展示）。
- 一键导出 `.md` / `.csv`。
- 用于分享视图的深链：`/?label=support&threshold=0.8&flagged=1&expand=1&q=billing`，另有 `limit=200` 与 `open=<id,id>` 按 trace id 展开指定记录。

面板读的就是服务器写的那个文件；不上传任何内容，除你选定的端口外也不开放其它端口。

---

## 问题质量提示

每次调用前，JevLens 会对你的问题做一轮低成本的静态检查，并把结果作为参考性提示附上（工具响应里的 `hints`，面板里的一个琥珀色标签）。提示从不阻断调用。

| 代码 | 含义 |
| --- | --- |
| `choice.overlap` | 两个选项的意思几乎相同，于是二者之间的概率分配无从解读。比较 label 文本与 label+描述文本，用词重叠加字符二元组 Dice 系数，英文与 CJK 措辞都适用。 |
| `choice.too_few_options` | 选项少于两个：没有可区分的东西。 |
| `choice.too_many_options` | 选项多到概率质量开始变噪。 |
| `score.range_narrow` | 档位少于三个：这么短的量尺除布尔值之外表达不了什么。 |
| `score.range_wide` | 档位多于八个：相邻位置再也分辨不开。 |
| `score.duplicate_bucket` / `score.endpoints_identical` | 同一段文本被用在量尺的不同位置上。 |
| `question.missing_instructions` | 问题没有指令文本；Jev 只能凭选项措辞作答。 |
| `question.too_many` | 单次调用里超过十二个问题。 |

`noul` 问题只做 `question.*` 那两项检查：没有选项集，也就无从比较重叠或档位数量。

重叠判定的灵敏度通过 `.jevlens/config.json` 里的 `overlapThreshold` 调整。

---

## 存储

```
.jevlens/
├── config.json                 # optional: threshold, port, rotation, model
├── trace-2026-09-21.jsonl      # one decision per line
├── trace-2026-09-21-2.jsonl    # rotation part 2 once maxRecordsPerFile is hit
└── exports/                    # jevlens-<timestamp>.md | .csv
```

只追加，每行一个 JSON 对象，按天分文件，并对单文件记录数设上限。进程被杀留下的半行在读取时会被跳过，而不是把面板弄坏。每行还带有 `agent`（已连接 MCP 客户端上报的 `name@version`，如果它报了）与 `response.usage` 的 token 计数；面板展开原始记录时两者都能看到。

```bash
jq -r '[.ts, .label, .status, .confidence.min] | @tsv' .jevlens/trace-*.jsonl
grep -c '"status":"undecided"' .jevlens/trace-2026-09-21.jsonl
```

凭据清洗是在写入时强制执行的，而非仅靠约定，由三条彼此独立的规则构成。存在某个看起来像凭据的键（`api_key`、`apikey`、`access_token`、`auth_token`、`bearer`、`token`、`secret`、`password`、`passwd`、`credential`、`authorization`、`cookie`）下的值会变成 `[redacted]`。任何与某个环境变量值相等的字符串，只要该变量的*名字*匹配上面同样这些模式且长度至少 12 个字符，就会被遮蔽。任意字符串内部的凭据形状 token — `sk…`、`pk…`、`pat…`、`ghp…`、`xoxb…` 或 `ai…` 后接 12 个及以上单词字符 — 会被替换。超过 20 000 字符的字符串会被截断，嵌套深过 12 层会被裁掉。

这些只是形状匹配，不是通用的密钥检测器：自由文本 `state` 里一个不透明的 `Bearer dXkR9f…` 会躲过清洗，除非它所在的键就是 `bearer`/`authorization`，或者这个值恰好也在你的环境变量里。请把 trace 文件当作敏感内容对待，别让它进版本库 — `.jevlens/` 正因如此已被 gitignore。有一个测试会把一把假 key 塞进 `state`，并断言它永远到不了磁盘。

---

## 配置

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Jev API key（仅环境变量；从不持久化） | — |
| `TYPESAFE_BASE_URL` | 覆盖 Jev 端点 | SDK 默认 |
| `TYPESAFE_DEFAULT_MODEL` | 每次调用请求的模型 | provider 默认 |
| `JEVLENS_DIR` | trace 目录 | `./.jevlens` |
| `JEVLENS_PORT` / `JEVLENS_HOST` | 面板绑定 | `8787` / `127.0.0.1` |
| `JEVLENS_CONFIDENCE_THRESHOLD` | 告警阈值 | `0.7` |
| `JEVLENS_MAX_RECORDS` | 单个文件轮转前的记录数 | `5000` |
| `JEVLENS_TIMEOUT_MS` | Jev 请求超时 | `20000` |
| `JEVLENS_MOCK` | 强制使用离线 provider | 关闭 |
| `JEVLENS_INSPECTOR_PORT` | `jevlens inspector` 的端口 | `6274` |
| `JEVLENS_UI_HTML` | 面板 HTML 路径（开发/测试钩子） | `<package>/ui/index.html` |

`.jevlens/config.json` 放的是同一批开关（`confidenceThreshold`、`storageDir`、`host`、`port`、`maxRecordsPerFile`、`model`、`mock`、`overlapThreshold`）。优先级：内置默认值 < 配置文件 < 环境变量 < CLI 参数。

```json
{ "confidenceThreshold": 0.8, "maxRecordsPerFile": 2000, "overlapThreshold": 0.55 }
```

---

## 命令行

```
jevlens mcp         start the MCP server on stdio (what your agent launches)
jevlens ui          start the local decision timeline
jevlens inspector   launch the official MCP Inspector against this server
jevlens help        usage;  -v / --version prints the version
```

公共参数：`--port <n>`、`--host <addr>`、`--dir <path>`、`--threshold <0..1>`、`--mock`；`jevlens inspector` 另外接受 `--inspector-port <n>`。它们位于优先级链的最上层，因此命令行参数总是压过配置文件与环境变量。

`jevlens inspector` 通过 `npx` 针对 `jevlens mcp` 启动官方 MCP Inspector，并打印出
`http://127.0.0.1:6274/…` 地址（较新的 Inspector 版本会在其中附加一个 auth token）。在那里你可以
手工调用 `jev_ask`，同时看着 JSONL 文件不断变长。

---

## 开发

```bash
npm install
npm run typecheck     # tsc -p tsconfig.dev.json (src + tests + examples)
npm run build         # tsc → dist/
npm test              # node --test on TypeScript sources, no build step needed
npm run check         # all three
node examples/seed-trace.ts   # write a few demo decisions with the offline provider
```

TypeScript、Node 22.18+（`engines` 为 `>=22.18.0`；`npm test` 通过 Node 的类型擦除直接运行 TypeScript 源码，而该能力从 22.18 起才无需 flag）、ESM，运行时依赖恰好三个：`@modelcontextprotocol/sdk`、`@typesafe-ai/sdk` 与 `zod` v4。测试使用 Node 内置 runner，覆盖存储轮转与半行、配置优先级、凭据清洗、问题质量启发式、fail-open 路径（API 不可达、答案缺失、存储不可写）、mock provider 的概率不变量、Markdown/CSV 正确性、面板的 HTTP API，以及一个真实 MCP 客户端经 stdio 与构建好的服务器对话。

发布：

```bash
npm publish --access public   # prepublishOnly runs a clean build plus the test suite
```

---

## JevLens 刻意不做的事

| 常见的 Jev harness 方向 | JevLens |
| --- | --- |
| 用 Jev 做工具选择或风险闸门 | 只记录并展示决策，不做任何决策 |
| 过滤工具输出或压缩上下文 | 从不碰 Agent 的上下文 |
| 拿 Jev 与其它模型对比 | 一次只追踪一个 Agent 运行 |
| 提供预设问题库或 linter | 只展示*你的*问题实际返回了什么 |
| 企业级审计与合规 | 本地文件，无账号，无配额 |

v0.1 同样不在范围内：数据库、索引、查询语言、鉴权、多租户、WebSocket 推送、自动改代码、决策链编排。

与同一定位相符的后续方向：决策链可视化（把相关的调用串成一棵树）、写入前的本地 PII 掩码、导出运行的只读分享，以及与 Jev 问题质量 linter 更紧密的联动。

## 许可证

MIT
