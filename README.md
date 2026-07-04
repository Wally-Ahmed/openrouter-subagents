# openrouter-subagents

An MCP server **and CLI** that exposes a GPT/Claude/Gemini-agnostic "subagent" tool backed by
**[OpenRouter](https://openrouter.ai)** — one API key, every model. It defaults to **OpenRouter
Fusion** (`openrouter/fusion`), which runs a *panel* of models in parallel and has a judge model
synthesize them into a single answer. Sibling to
[`gpt-subagents-api`](https://github.com/Wally-Ahmed/gpt-subagents-api) (OpenAI API key) and
[`gpt-subagents-subscription`](https://github.com/Wally-Ahmed/gpt-subagents-subscription) (ChatGPT
subscription), and it ships the same **orchestration patterns** system.

> **Note:** Uses an **OpenRouter API key** (`Authorization: Bearer …`) against the OpenAI-compatible
> Chat Completions endpoint. Not affiliated with or endorsed by OpenRouter.

---

## Tools

| Tool | What it does |
|------|--------------|
| `ask_openrouter` | Ask any OpenRouter model. **`model` defaults to `openrouter/fusion`** (multi-model synthesis); pass any OpenRouter id to override (e.g. `anthropic/claude-opus-latest`, `openai/gpt-latest`, or a fast cheap model). Write `instructions` (the system prompt) every call. Reasoning is fully controllable (see below). For Fusion only — `analysis_models` (the panel, 1–8 ids) and `judge_model` (the synthesizer). |
| `list_patterns` / `get_pattern` | Orchestration patterns for driving the model well (see below). |

**Fusion cost:** a Fusion call bills for **every panel model plus the judge**. Reach for it when
multiple perspectives are worth the spend (research, expert critique, high cost-of-being-wrong); for
quick tactical prompts pass a single model id instead.

### Reasoning & sampling controls

Any model's reasoning level can be set — the server exposes OpenRouter's full unified `reasoning`
object, and OpenRouter translates it into whatever the target model natively speaks (OpenAI/Grok
effort levels, Anthropic thinking budgets, Gemini `thinkingLevel`, Qwen thinking budgets, on/off
flags for models like DeepSeek/GLM). A level a model doesn't support is mapped to the nearest one
it offers.

| Param | Meaning |
|-------|---------|
| `reasoning_effort` | Named level, lowest → highest: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. (`none` disables reasoning. On Anthropic these become budget ratios ≈ 0.1/0.2/0.5/0.8/0.95 of `max_tokens`, clamped to [1024, 128000]; on Gemini they map to `thinkingLevel`.) |
| `reasoning_max_tokens` | Exact reasoning token budget (Anthropic/Gemini/Qwen-style) for fine-grained control. **Mutually exclusive with `reasoning_effort`.** |
| `reasoning_enabled` | Turn default-strength reasoning on/off without picking a level or budget. |
| `reasoning_exclude` | Model still reasons, but the reasoning tokens aren't returned in the response. |
| `temperature` | Sampling temperature, 0–2 (lower = more deterministic). Applied when the model supports it; OpenRouter drops it for models that don't. |

> **Note for agents (MCP or CLI):** if a call fails or any error occurs — timeout, rate limit,
> model rejection, provider outage — **retry the exact same call first** (waiting briefly for
> transient errors). If it keeps failing, report the error and **ask**; do **not** downgrade or
> change the configuration the user set (model, reasoning level/budget, temperature, Fusion
> panel/judge) without their direct say-so. This rule is also baked into the server's MCP
> `instructions` and the CLI `--help`.

---

## CLI

Everything the MCP server does is also available as a plain shell command — same client, same
patterns library, but the answer comes back as **raw text on stdout with zero JSON-RPC framing**.
For agents that can run shell commands, this is the token-cheap way to delegate: no MCP envelope
in either direction, and piped stdin means large inputs (diffs, logs, files) never have to be
echoed through the model's context at all.

```bash
npm run build        # compiles dist/cli.js
npm link             # optional: puts `openrouter-subagents` on your PATH

# ask (the subcommand is optional); raw answer on stdout
openrouter-subagents "why is the sky blue?"
openrouter-subagents ask -m anthropic/claude-haiku-4.5 -e xhigh "prove sqrt(2) is irrational"

# piped stdin becomes the prompt — or the context when a prompt is given
git diff | openrouter-subagents ask -p "review this diff for bugs" -e high
openrouter-subagents ask -p "summarize" --context-file big-report.md -m openai/gpt-5-mini

# patterns
openrouter-subagents patterns
openrouter-subagents pattern two-layer-cross-model-expert
```

Flags mirror the MCP tool: `-m/--model`, `-i/--instructions` (defaults to a terse expert prompt),
`-p/--prompt`, `-c/--context` (each with a `--*-file` variant), `-e/--effort`
(`none`…`max`), `--reasoning-tokens <n>`, `--reasoning on|off`, `--hide-reasoning`,
`-t/--temperature`, and Fusion's `--analysis-models` / `--judge`. `--help` shows the full
reference. Exit codes: `0` success, `2` usage error, `1` API/network error.

---

## Orchestration patterns

Patterns are reusable playbooks (Markdown in [`patterns/`](./patterns)) that describe *how* to drive
the expert tool — splitting work, bundling context, calling the expert, **verifying its output against
ground truth**, and aggregating. They're exposed via `list_patterns` (catalog) and
`get_pattern("<name>")` (full text), read from disk **at call time** (no rebuild to add one), and the
server's `instructions` nudge the agent to consult them before non-trivial expert work.

| name | what it does |
|------|--------------|
| [`two-layer-cross-model-expert`](./patterns/two-layer-cross-model-expert.md) | Wrap the OpenRouter expert in verifying Claude subagents so the orchestrator only ever sees parallel, context-cheap, ground-truth-checked conclusions. (Fusion makes the "cross-model" premise even stronger — the expert is a whole panel of model families.) |
| [`worker-orchestrator`](./patterns/worker-orchestrator.md) | Fan concrete work out to the OpenRouter worker (`ask_openrouter` with a fast model) through cheap Sonnet wrapper subagents — validated by execution, not a verification gate. |

Both patterns ship a rendered diagram under [`patterns/html/`](./patterns/html). See
[`patterns/README.md`](./patterns/README.md) to add your own.

---

## Setup

Requires Node 18+ (uses the global `fetch`) and an OpenRouter API key.

```bash
npm install
npm run build
cp .env.example .env       # then put your key in .env
```

Get a key at <https://openrouter.ai/keys> and set `OPENROUTER_API_KEY` in `.env`. `.env` is gitignored
and must never be committed — only `.env.example` is tracked.

### Configuring a default Fusion panel + judge (optional)

By default, `openrouter/fusion` uses OpenRouter's built-in "Quality" preset. You can override that
default for **every** Fusion call from your `.env`:

```bash
# 1–8 panel models that answer in parallel:
OPENROUTER_FUSION_ANALYSIS_MODELS=anthropic/claude-opus-latest,openai/gpt-latest,google/gemini-pro-latest
# the judge that synthesizes them:
OPENROUTER_FUSION_JUDGE_MODEL=anthropic/claude-opus-latest
```

Precedence is **per-call arg > `.env` default > OpenRouter preset**, resolved independently for the panel
and the judge: a per-call `analysis_models` / `judge_model` on `ask_openrouter` overrides the matching
`.env` default, and these defaults apply only to `openrouter/fusion` (they're ignored for any other model).

### Register with Claude Code

```bash
claude mcp add -s user openrouter-subagents -- node /absolute/path/to/openrouter-subagents/dist/server.js
```

(Claude Code reads MCP registrations at startup, so a newly added server appears after a full restart.)

---

## How it works

1. `ask_openrouter` builds an OpenAI-style Chat Completions request (`system` + `user` messages).
2. For `openrouter/fusion`, the panel (`analysis_models`) and judge (`judge_model`) are resolved with
   precedence **per-call arg > `.env` default > OpenRouter's preset**, then sent as a `plugins: [{ id:
   "fusion", … }]` entry. With none of them set, OpenRouter's built-in Quality preset is used.
3. The request is POSTed to `https://openrouter.ai/api/v1/chat/completions` with
   `Authorization: Bearer $OPENROUTER_API_KEY`; the answer is `choices[0].message.content`.
4. Fusion is slow (parallel panel + synthesis), so the client uses a generous request timeout (~280s).

---

## Security

- The API key lives in `.env` (gitignored everywhere); only `.env.example` (a placeholder) is tracked.
- Outbound `instructions` / `prompt` / `context` are run through a best-effort secret redactor
  (API keys, tokens, private keys) before they leave your machine — **not** a guarantee; don't paste
  highly sensitive data.
- **Data boundary:** with the default `openrouter/fusion`, a single call fans your input out to several
  third-party providers at once (e.g. Anthropic, OpenAI, Google) via OpenRouter.
- Local agent/editor state (`.mempalace/`, `.claude/`, `CLAUDE.local.md`, IDE folders) is gitignored.

---

## License

MIT
