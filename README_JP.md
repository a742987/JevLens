# JevLens

**エージェントの実行の各ステップで Jev が何を決めたのかを目で確認できます。**

[中文](https://github.com/a742987/JevLens/blob/main/README.md) · [English](https://github.com/a742987/JevLens/blob/main/README_EN.md) · **日本語**

JevLens は [TypeSafe Jev](https://typesafe.ai) の判断のための、ローカル MCP サーバーと Web パネルの組み合わせです。判断を下すことはなく、ツールのルーティングもせず、エージェントのコンテキストに手を触れることもありません。各 `systemOne` 呼び出しをラップし、完全な state、質問、回答、確率分布、信頼度、レイテンシを追記専用の JSONL ファイルに記録し、タイムラインとして表示します。これにより、エージェントの奇妙な挙動が Jev の判断によるものなのか、LLM の生成によるものなのかが切り分けられます。

一人サイドプロジェクトで ops に予算を割けない開発者のために作りました:

- **外部サービスなし。** データベースもクラウドも Docker も使いません。1 日 1 つの JSONL ファイルで、`grep` と `jq` で検索できます。
- **フロントエンドのビルドなし。** パネルは 1 つの HTML ファイルのみ。チャートライブラリは CDN から読み込みます。
- **認証なし。** パネルは `127.0.0.1` にバインドし、それ以外の `Host` ヘッダーは拒否します。デベロッパー向けツールであり、SaaS ではありません。
- **ハーネスへのロックインなし。** stdio 上の標準 MCP なので、Claude Code、Codex、Cursor、OpenCode などあらゆる MCP クライアントから使えます。
- **モデル呼び出しの追加コストなし。** JevLens はすでに実行している呼び出しを転送するだけで、みずから LLM を呼び出すことはありません。
- **設計上フェイルオープン。** Jev API に到達できない場合、`jev_ask` は `undecided` の結果を返し、エージェントは実行を継続します。

```
state + questions ──▶ [jev_ask] ──▶ TypeSafe Jev API ──▶ answers + probabilities + confidence
                          │
                          ├──▶ .jevlens/trace-YYYY-MM-DD.jsonl   (append-only)
                          │
                    [jevlens ui] ──▶ http://127.0.0.1:8787       (3s polling, same file)
```

MCP サーバーとパネルは、JSONL ファイル以外には何も共有しない 2 つの独立したプロセスです。エージェントが作業している間はサーバーを動かし、パネルはデバッグするときだけ起動してください。

---

## クイックスタート（約 5 分）

```bash
# 1. Register it with your coding agent (Claude Code shown; see "Wiring" below for others)
claude mcp add jevlens --env TYPESAFE_API_KEY=$TYPESAFE_API_KEY -- npx -y jevlens mcp

# 2. Ask your agent to call the tool, e.g.
#    "Use the jevlens jev_ask tool to classify this support ticket: I was charged twice, fix it today."

# 3. Look at what Jev actually returned
npx -y jevlens ui          # then open http://127.0.0.1:8787
```

API キーがまだなくても、決定論的なオフラインプロバイダーに対してそのままエンドツーエンドで動きます。まずはパネルとツールの形を試すことができます:

```bash
npx -y jevlens ui --mock --port 8787
```

パネルは各レコードにモックプロバイダーのバッジ（`mock`）を表示するので、デモデータと実際の判断を混同することは決してありません。

---

## 接続

JevLens はプレーンな stdio MCP サーバーです。唯一のシークレットである `TYPESAFE_API_KEY` は環境から読み込まれ、設定ファイル、トレース、エクスポートに書き込まれることはありません。

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add jevlens --env TYPESAFE_API_KEY="$TYPESAFE_API_KEY" -- npx -y jevlens mcp
```

または、プロジェクト直下の `.mcp.json` に:

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

`~/.codex/config.toml` に:

```toml
[mcp_servers.jevlens]
command = "npx"
args = ["-y", "jevlens", "mcp"]
env = { TYPESAFE_API_KEY = "tsk_live_..." }
```
</details>

<details>
<summary><b>Cursor</b></summary>

`.cursor/mcp.json` に:

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

`opencode.json` に:

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
<summary><b>その他の MCP クライアント</b></summary>

コマンドは `npx -y jevlens mcp`（グローバルにインストールした場合は `jevlens mcp`）、トランスポートは `stdio`、そして子プロセスの環境に `TYPESAFE_API_KEY` を渡します。
</details>

---

## ツール

### `jev_ask` — Jev に質問し、すべてを記録する

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

`type` は `choice`、`score`、`noul` のいずれかです。`noul` の質問は選択肢の集合を持たない、「これはどれくらい真実に近いか」という素の判断です — `{ "type": "noul", "instructions": "Does this diff look risky to merge?" }` のように書き、必要なら `criteria: { true, false }` で両端にラベルを付けられます。回答は `{ "type": "noul", "noul": 0.87 }` の形になり、信頼度は返ってくる値ではなく導出されます: `|noul − 0.5| × 2` です。つまり `0.5` は最大限のあいまいさ、`0` と `1` は確実性として読め、この値は他の質問と同じように `confidence.min` と `belowThreshold` に反映されます。`score` の回答には、プロバイダーが返す場合、バケットのインデックスをバケットのテキストへ対応付ける `legend` も含まれます。

返するのは構造化された JSON のみ — モデルが誤読するような文章は含めません:
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

`status` は `"answered"` または `"undecided"` です。`undecided` の結果にもすべての質問に対する回答（一律の確率、信頼度 `0`）と記録された `error` が入るため、Jev が停止しても実行は止まらず、判断の質が低下するにとどまります。

省略可能なフィールド: `model`（呼び出しごとのモデル上書き）と `threshold`（呼び出しごとのアラート閾値）。

### `jev_trace` — 直近の判断を読み返す

`{ "limit": 20, "label": "support-triage", "below_threshold": 0.7, "include_payload": false }`

新しい順に、JSONL ファイルから直接返します。`include_payload: false` を設定すると `state` の本体が除外され、エージェントのコンテキストを小さく保てます。

### `jev_export` — レポートを書き出す

`{ "format": "markdown", "label": "support-triage", "path": "reports/triage.md" }`

Markdown または CSV を `.jevlens/exports/`（または指定した `path`）に書き込み、`{ format, path, records, bytes }` を返します。Markdown はそのまま貼り付けられるバグレポートの形で、state、質問の定義、回答の表、確率分布、信頼度のフラグ、ヒント、エラーを含みます。CSV は 1 質問 1 行でレコードのメタデータが繰り返し記述されるため、スプレッドシートでピボットできます。

---

## パネル

```bash
jevlens ui --port 8787
```

- すべての判断のタイムライン。新しい順に、ラベル、モデル、レイテンシ、最小信頼度を表示。
- 質問ごとの確率バー。返された回答がハイライトされたバーです。
- 信頼度アラート: 閾値を下回るものは赤い枠線で示され、サマリーカードの集計に入ります。閾値はヘッダーで編集でき、`.jevlens/config.json` に保存されます。
- 3 秒ごとの自動更新（ポーリングで WebSocket は使いません）。一時停止でき、タブが非表示のあいだはアイドル状態になります。
- 行を展開すると、生の `state`、質問の定義、ヒント、エラーテキスト、レコード全体を確認できます。
- ラベルによる絞り込み、「フラグ付きのみ」のトグル、件数選択、レコード全体のテキスト絞り込み。
- 判断ごとの信頼度チャート（バージョン固定で SRI ハッシュ付きの CDN URL から読み込む Chart.js。CDN に到達できない場合はテキストのフォールバックを表示）。
- ワンクリックで `.md` / `.csv` にエクスポート。
- 表示状態を共有するためのディープリンク: `/?label=support&threshold=0.8&flagged=1&expand=1&q=billing`。加えて `limit=200`、そしてトレース ID で特定のレコードを展開する `open=<id,id>` が使えます。

パネルはサーバーが書き込むのと同じファイルを読むだけです。何もアップロードされず、選択した以外のポートが開くこともありません。

---

## 質問の品質ヒント

各呼び出しの前に、JevLens は質問に対して安価な静的チェックを実行し、その結果を参考用のヒントとして添付します（ツールレスポンスの `hints`、パネルではアンバー色のチップ）。ヒントが呼び出しを止めることは決してありません。

| コード | 意味 |
| --- | --- |
| `choice.overlap` | 2 つの選択肢がほぼ同じ意味を指しており、両者のあいだの確率の割かれ方が解釈不能になります。ラベルとラベル＋説明のテキストを、単語の重複と文字バイグラムの Dice 係数で比較するため、英語でも CJK の表現でも機能します。 |
| `choice.too_few_options` | 選択肢が 2 つ未満: 区別すべきものがありません。 |
| `choice.too_many_options` | 選択肢が多すぎて、確率質量がノイズを帯びます。 |
| `score.range_narrow` | バケットが 3 つ未満: これほど短い範囲ではブール値とほとんど変わりません。 |
| `score.range_wide` | バケットが 8 つを超える: 隣り合う位置が区別できなくなります。 |
| `score.duplicate_bucket` / `score.endpoints_identical` | スケール上の異なる位置に同じテキストが使い回されています。 |
| `question.missing_instructions` | 指示テキストのない質問。Jev は選択肢の文言だけで回答します。 |
| `question.too_many` | 1 回の呼び出しで 12 を超える質問を渡しています。 |

`noul` の質問には 2 つの `question.*` チェックだけが適用されます。選択肢の集合がないため、重複やバケット数を比較する対象そのものがありません。

重複検出の感度は `.jevlens/config.json` の `overlapThreshold` で調整します。

---

## ストレージ

```
.jevlens/
├── config.json                 # optional: threshold, port, rotation, model
├── trace-2026-09-21.jsonl      # one decision per line
├── trace-2026-09-21-2.jsonl    # rotation part 2 once maxRecordsPerFile is hit
└── exports/                    # jevlens-<timestamp>.md | .csv
```

追記専用で、1 行に 1 つの JSON オブジェクト。日次ファイルに加えて、1 ファイルあたりのレコード数の上限があります。プロセスを kill されたときに生じた途中で切れた行は、パネルを壊すのではなく読み込み時にスキップされます。各行には `agent`（接続している MCP クライアントが自身を報告する場合、その `name@version`）と `response.usage` のトークン数も記録され、パネルでは展開した生のレコードの中に両方が表示されます。

```bash
jq -r '[.ts, .label, .status, .confidence.min] | @tsv' .jevlens/trace-*.jsonl
grep -c '"status":"undecided"' .jevlens/trace-2026-09-21.jsonl
```

資格情報の衛生管理は、慣習ではなく書き込み時に強制される 3 つの独立したルールで成り立っています。資格情報らしきキー（`api_key`、`apikey`、`access_token`、`auth_token`、`bearer`、`token`、`secret`、`password`、`passwd`、`credential`、`authorization`、`cookie`）に格納された値は `[redacted]` になります。*名前* が同じパターンに一致し、長さが 12 文字以上の環境変数の値と等しい文字列はマスキングされます。さらに、どの文字列の中にあっても資格情報に似た形状のトークン — `sk…`、`pk…`、`pat…`、`ghp…`、`xoxb…`、`ai…` のあとに 12 文字以上の単語文字が続くもの — は置き換えられます。20 000 文字を超える文字列は切り詰められ、12 階層より深いネストは打ち切られます。

これは形状のマッチングであって汎用のシークレット検出器ではありません: 自由記述の `state` テキストの中にある意味の読めない `Bearer dXkR9f…` は、キーが `bearer`/`authorization` である場合やその値そのものが環境に存在する場合を除いてそのまま残ります。トレースファイルを機密として扱い、バージョン管理の外に置いてください — `.jevlens/` が gitignore されているのはそのためです。`state` に偽のキーを入れて、ディスクに到達しないことを検証するテストもあります。

---

## 設定

| 環境変数 | 用途 | デフォルト |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Jev の API キー（環境のみ。永続化されることはありません） | — |
| `TYPESAFE_BASE_URL` | Jev のエンドポイントの上書き | SDK のデフォルト |
| `TYPESAFE_DEFAULT_MODEL` | すべての呼び出しで要求されるモデル | プロバイダーのデフォルト |
| `JEVLENS_DIR` | トレースディレクトリ | `./.jevlens` |
| `JEVLENS_PORT` / `JEVLENS_HOST` | パネルのバインド | `8787` / `127.0.0.1` |
| `JEVLENS_CONFIDENCE_THRESHOLD` | アラートの閾値 | `0.7` |
| `JEVLENS_MAX_RECORDS` | ローテーションまでの 1 ファイルあたりのレコード数 | `5000` |
| `JEVLENS_TIMEOUT_MS` | Jev へのリクエストタイムアウト | `20000` |
| `JEVLENS_MOCK` | オフラインプロバイダーを強制 | オフ |
| `JEVLENS_INSPECTOR_PORT` | `jevlens inspector` のポート | `6274` |
| `JEVLENS_UI_HTML` | パネルの HTML パス（開発・テスト用のフック） | `<package>/ui/index.html` |

`.jevlens/config.json` にも同じ設定項目（`confidenceThreshold`、`storageDir`、`host`、`port`、`maxRecordsPerFile`、`model`、`mock`、`overlapThreshold`）があります。優先順位: 組み込みのデフォルト < 設定ファイル < 環境変数 < CLI フラグ。

```json
{ "confidenceThreshold": 0.8, "maxRecordsPerFile": 2000, "overlapThreshold": 0.55 }
```

---

## CLI

```
jevlens mcp         start the MCP server on stdio (what your agent launches)
jevlens ui          start the local decision timeline
jevlens inspector   launch the official MCP Inspector against this server
jevlens help        usage;  -v / --version prints the version
```

共通フラグ: `--port <n>`、`--host <addr>`、`--dir <path>`、`--threshold <0..1>`、`--mock`。`jevlens inspector` ではこれに加えて `--inspector-port <n>` が使えます。これらのフラグは優先順位チェーンの最上位に置かれるため、設定ファイルや環境変数に常に優先します。

`jevlens inspector` は `npx` 経由で公式の MCP Inspector を `jevlens mcp` に対して起動し、
`http://127.0.0.1:6274/…` の URL を表示します（最近の Inspector のバージョンでは認証トークンが付加されます）。
そこから `jev_ask` を手動で呼び出し、JSONL ファイルが追記されていく様子を観察できます。

---

## 開発

```bash
npm install
npm run typecheck     # tsc -p tsconfig.dev.json (src + tests + examples)
npm run build         # tsc → dist/
npm test              # node --test on TypeScript sources, no build step needed
npm run check         # all three
node examples/seed-trace.ts   # write a few demo decisions with the offline provider
```

TypeScript、Node 22.18 以上（`engines` は `>=22.18.0`。`npm test` は Node の型ストリッピングで TypeScript のソースを直接実行しますが、これがフラグなしで有効になるのは 22.18 からです）、ESM、そして実行時の依存は `@modelcontextprotocol/sdk`、`@typesafe-ai/sdk`、`zod` v4 のちょうど 3 つです。テストは Node 組み込みのランナーを使い、ストレージのローテーションと途中で切れた行、設定の優先順位、資格情報のスクラブ、質問品質のヒューリスティクス、フェイルオープンの経路（API に到達できない、回答が欠落している、ストレージに書き込めない）、モックプロバイダーの確率の不変条件、Markdown/CSV の正確性、パネルの HTTP API、そしてビルド済みサーバーと stdio でやり取りする実際の MCP クライアントをカバーしています。

公開:

```bash
npm publish --access public   # prepublishOnly runs a clean build plus the test suite
```

---

## JevLens が意図的にやらないこと

| よくある Jev ハーネスの方向性 | JevLens |
| --- | --- |
| ツールの選択やリスクのゲーティングに Jev を使う | 判断を記録して表示するだけで、判断は下さない |
| ツールの出力をフィルタリングしたりコンテキストを圧縮する | エージェントのコンテキストには一切触れない |
| Jev を他のモデルと比較する | 一度に 1 つのエージェント実行だけをトレースする |
| あらかじめ用意した質問バンクやリンターを配布する | *あなたの*質問が実際に何を返したかを表示する |
| エンタープライズの監査とコンプライアンス | ローカルファイルのみ。アカウントもクォータもなし |

v0.1 で同じくスコープ外: データベース、インデックス、クエリ言語、認証、マルチテナンシー、WebSocket によるプッシュ、コードの自動変更、判断チェーンのオーケストレーション。

同じ位置づけに沿う今後の方向性: 判断チェーンの可視化（関連する呼び出しをツリー状に結ぶ）、書き込み前にローカルで行う PII マスキング、エクスポートした実行の読み取り専用共有、そして Jev の質問品質リンターとのより密な連携。

## ライセンス

MIT
