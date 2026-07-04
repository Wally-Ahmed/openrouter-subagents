import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  askOpenRouter,
  REASONING_EFFORTS,
  MAX_REASONING_TOKENS,
  MIN_TEMPERATURE,
  MAX_TEMPERATURE,
} from "./openRouter.js";
import { listPatterns, getPattern, patternNames } from "./patterns.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Global install: compiled to <pkg>/dist/server.js, so the colocated .env is one
// level up. Falls back silently to any inherited process.env.OPENROUTER_API_KEY.
config({ path: resolve(__dirname, "..", ".env") });

const server = new McpServer(
  {
    name: "openrouter-subagents",
    version: "1.0.0",
  },
  {
    instructions: `
This server lets you delegate to an OpenRouter model as an "expert" subagent from inside your agent
loop, via a SINGLE tool:

- ask_openrouter: ask any model on OpenRouter. The model defaults to "openrouter/fusion" — Fusion runs
  a PANEL of models in parallel and a judge model synthesizes their answers into one. You can pass any
  OpenRouter model id instead (e.g. "anthropic/claude-opus-latest", "openai/gpt-latest", or a fast,
  cheap model for concrete work). Write the instructions (its system prompt) every call.

  REASONING: any model's reasoning level can be set. reasoning_effort takes the full unified scale
  (none | minimal | low | medium | high | xhigh | max) — OpenRouter translates it into whatever the
  target model natively speaks (OpenAI/Grok effort, Anthropic thinking budget, Gemini thinkingLevel),
  mapping unsupported levels to the nearest one the model offers. For exact budget control pass
  reasoning_max_tokens (a token budget, instead of — not with — reasoning_effort). reasoning_enabled
  toggles default-strength reasoning on/off; reasoning_exclude hides reasoning tokens from the response.
  You can also set temperature (0-2) when the model supports it — OpenRouter drops it for models that
  don't.

  For Fusion you may optionally set analysis_models (the panel, 1-8 ids) and
  judge_model (the synthesizer), which override any panel/judge default the operator configured in the
  server's .env; omit them to use that .env default if set, otherwise OpenRouter's Quality preset. There is NO separate
  "worker" vs "architect" tool — that distinction is just the orchestration PATTERN you apply plus your
  model/effort choice:
  - Concrete code work (patches, debugging, tests, repo inspection): a single fast model + the
    worker-orchestrator pattern.
  - Hard reasoning, architecture, security/threat modeling, review of large/high-risk changes:
    "openrouter/fusion" (or a strong single model) + reasoning_effort "high" + the
    two-layer-cross-model-expert pattern.
  COST: a Fusion call bills for EVERY panel model plus the judge. Reach for it when multiple
  perspectives are worth the spend (research, expert critique, high cost-of-being-wrong); for quick
  tactical prompts pass a single model instead.

ON FAILURE, RETRY FIRST — NEVER SILENTLY DOWNGRADE: if a call fails or errors (timeout, rate
limit, model rejection, provider outage), FIRST retry the exact same call with the exact same
configuration (waiting briefly for transient errors like rate limits). If retries keep failing,
report the error to the user and ASK before changing anything they chose — do NOT substitute a
cheaper model, lower the reasoning level/budget, alter temperature, or drop Fusion panel/judge
options without their direct say-so.

ORCHESTRATION PATTERNS: Before any non-trivial use of ask_openrouter — reviews, audits, threat
modeling, large-document analysis, anything whose output you would act on — call list_patterns and
apply the most relevant pattern, then read it in full with get_pattern. Patterns are reusable playbooks
that keep expert output parallel, context-cheap, and verified against ground truth.

DATA BOUNDARY: instructions, prompt, and context are sent to OpenRouter, which routes them to one or
more third-party model providers — and with the default "openrouter/fusion" model a SINGLE call fans
your input out to several providers at once (e.g. Anthropic, OpenAI, Google). Secrets are stripped on a
best-effort basis (common API keys, tokens, and private keys are redacted), but this is NOT guaranteed
— do NOT paste highly sensitive data and rely on redaction to protect it.
    `.trim(),
  }
);

// Input size caps. These bound what we forward to the API so an oversized
// argument can't be used to burn API credit, overflow context, or buffer huge
// strings. Matches the sibling servers' limits.
const MAX_INSTRUCTIONS_CHARS = 32_000;
const MAX_PROMPT_CHARS = 100_000;
const MAX_CONTEXT_CHARS = 200_000;
const MAX_MODEL_CHARS = 100;
const MAX_PATTERN_NAME_CHARS = 100;

// Convert any thrown error into a generic, caller-safe message. Details
// (including the original error) are logged to stderr by openRouter/here, never
// returned to the MCP client where they could disclose local paths/metadata.
function errorText(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

server.tool(
  "ask_openrouter",
  "Ask an OpenRouter model as an expert subagent. ONE tool for everything: `model` defaults to 'openrouter/fusion' (a panel of models answers in parallel and a judge fuses them), or pass any OpenRouter model id. Write `instructions` (its system prompt). Any model's reasoning level can be set: `reasoning_effort` (none/minimal/low/medium/high/xhigh/max, auto-translated to each model's native scheme) or `reasoning_max_tokens` (exact budget; not both), plus `reasoning_enabled` / `reasoning_exclude`. Optional `temperature` (0-2) where the model supports it. For Fusion you may set `analysis_models` (panel, 1-8) and `judge_model` (synthesizer). Use a single fast model + the worker-orchestrator pattern for concrete code work; use 'openrouter/fusion' or a strong model + reasoning_effort 'high' + the two-layer-cross-model-expert pattern for hard reasoning / architecture / security review. Note: a Fusion call bills for every panel model + the judge. Call list_patterns / get_pattern first for non-trivial work. If a call fails, retry it as-is first; if it keeps failing, report the error and ask — do NOT downgrade or change the user's chosen model/reasoning/temperature config without their direct say-so.",
  {
    model: z
      .string()
      .trim()
      .min(1)
      .max(MAX_MODEL_CHARS)
      .default("openrouter/fusion")
      .describe(
        "OpenRouter model id. Defaults to 'openrouter/fusion' (multi-model synthesis). Any valid OpenRouter id is accepted, e.g. 'anthropic/claude-opus-latest', 'openai/gpt-latest', or a fast, cheap model for worker tasks."
      ),
    instructions: z
      .string()
      .trim()
      .min(1)
      .max(MAX_INSTRUCTIONS_CHARS)
      .describe(
        "System instructions for the model (required): its role and how to respond. Write these for the task at hand — e.g. a coding-subagent prompt for worker-style work, or a reviewer/architect prompt for analysis."
      ),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PROMPT_CHARS)
      .describe("The task or question for the model."),
    reasoning_effort: z
      .enum(REASONING_EFFORTS)
      .optional()
      .describe(
        "Named reasoning level, lowest to highest: none, minimal, low, medium, high, xhigh, max. " +
          "OpenRouter normalizes this across providers (OpenAI/Grok take it natively; Anthropic gets a " +
          "proportional thinking budget; Gemini a thinkingLevel); an unsupported level is mapped to the " +
          "nearest one the model offers, never a hard error. 'none' disables reasoning where the model " +
          "allows it (some models' reasoning is mandatory and 'none' is ignored). Use 'high' or above " +
          "for deep audits / architecture review. Mutually exclusive with reasoning_max_tokens."
      ),
    reasoning_max_tokens: z
      .number()
      .int()
      .min(1)
      .max(MAX_REASONING_TOKENS)
      .optional()
      .describe(
        "Explicit reasoning token budget (Anthropic/Gemini/Qwen-style budget_tokens) for fine-grained " +
          "control instead of a named level. Providers clamp to their own limits (e.g. Anthropic " +
          "[1024, 128000]). Mutually exclusive with reasoning_effort."
      ),
    reasoning_enabled: z
      .boolean()
      .optional()
      .describe(
        "Enable reasoning at the model's default strength without picking a level or budget " +
          "(true = default reasoning on; false = off). Prefer reasoning_effort when you care how much."
      ),
    reasoning_exclude: z
      .boolean()
      .optional()
      .describe(
        "When true the model still reasons but the reasoning tokens are not returned in the response " +
          "(saves context; you still pay for them)."
      ),
    temperature: z
      .number()
      .min(MIN_TEMPERATURE)
      .max(MAX_TEMPERATURE)
      .optional()
      .describe(
        "Sampling temperature, 0-2 (lower = more deterministic, higher = more varied/creative). " +
          "Omit to use the model's default. Applied when the model supports it; OpenRouter drops it " +
          "for models that don't (e.g. some reasoning-only models)."
      ),
    context: z
      .string()
      .max(MAX_CONTEXT_CHARS)
      .optional()
      .describe(
        "Code snippets, error messages, stack traces, constraints, or other relevant context."
      ),
    analysis_models: z
      .array(z.string().trim().min(1).max(MAX_MODEL_CHARS))
      .min(1)
      .max(8)
      .optional()
      .describe(
        "Fusion panel: 1-8 OpenRouter model ids that answer in parallel. Only valid when model is 'openrouter/fusion'."
      ),
    judge_model: z
      .string()
      .trim()
      .min(1)
      .max(MAX_MODEL_CHARS)
      .optional()
      .describe(
        "Fusion judge/synthesis model id. Only valid when model is 'openrouter/fusion'."
      ),
  },
  async ({
    model,
    instructions,
    prompt,
    reasoning_effort,
    reasoning_max_tokens,
    reasoning_enabled,
    reasoning_exclude,
    temperature,
    context,
    analysis_models,
    judge_model,
  }) => {
    try {
      const result = await askOpenRouter({
        model,
        instructions,
        prompt,
        temperature,
        reasoningEffort: reasoning_effort,
        reasoningMaxTokens: reasoning_max_tokens,
        reasoningEnabled: reasoning_enabled,
        reasoningExclude: reasoning_exclude,
        context,
        analysisModels: analysis_models,
        judgeModel: judge_model,
      });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      console.error("[openrouter-subagents] ask_openrouter handler error:", err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: errorText(err) }],
      };
    }
  }
);

server.tool(
  "list_patterns",
  "List available orchestration patterns for driving ask_openrouter. Call this before non-trivial expert work — reviews, audits, threat modeling, large-document analysis — then read the chosen one with get_pattern. Returns each pattern's name, title, summary, and when to use it.",
  {},
  async () => {
    const patterns = listPatterns();
    if (patterns.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No patterns found." }],
      };
    }
    const text = patterns
      .map(
        (p) =>
          `- ${p.name} — ${p.title}\n  Summary: ${p.summary}\n  Use when: ${p.use_when}`
      )
      .join("\n\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `Available orchestration patterns (read one in full with get_pattern):\n\n${text}`,
        },
      ],
    };
  }
);

server.tool(
  "get_pattern",
  "Return the full text of an orchestration pattern by name (see list_patterns). Use it to apply the pattern when orchestrating ask_openrouter calls.",
  {
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PATTERN_NAME_CHARS)
      .describe(
        "The pattern name from list_patterns, e.g. 'two-layer-cross-model-expert'"
      ),
  },
  async ({ name }) => {
    const pattern = getPattern(name);
    if (!pattern) {
      const available = patternNames();
      const list = available.length ? available.join(", ") : "(none found)";
      // JSON.stringify + truncate the echoed name so control chars / a huge
      // value can't inject newlines or formatting into the reflected message.
      const echoed = JSON.stringify(name.slice(0, MAX_PATTERN_NAME_CHARS));
      return {
        content: [
          {
            type: "text" as const,
            text: `No pattern named ${echoed}. Available patterns: ${list}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `# ${pattern.title}\n\n${pattern.body}`,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("openrouter-subagents MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
