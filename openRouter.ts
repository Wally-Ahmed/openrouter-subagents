// OpenRouter client for the ask_openrouter tool. OpenRouter speaks the
// OpenAI-compatible Chat Completions API; "Fusion" (model "openrouter/fusion")
// is invoked via the same endpoint plus an optional `plugins` entry. We use a
// raw fetch (Node 18+ global) rather than an SDK so the Fusion extension fields
// pass through cleanly and there are no extra dependencies.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const FUSION_MODEL = "openrouter/fusion";
const DEFAULT_MODEL = FUSION_MODEL;

// Fusion runs a panel of models in parallel and then a synthesis pass, so it is
// slow. Give the request a generous timeout that stays under typical MCP
// tool-call limits (~300s) rather than letting it hang indefinitely.
const REQUEST_TIMEOUT_MS = 280_000;

function getApiKey(): string {
  const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY in environment variables.");
  }
  return apiKey;
}

// The full set of named effort levels OpenRouter's unified `reasoning.effort`
// accepts, low to high. OpenRouter normalizes these across providers: OpenAI /
// Grok-style models take effort natively; for Anthropic it is converted to a
// thinking budget (ratio of max_tokens: minimal 0.1, low 0.2, medium 0.5,
// high 0.8, xhigh/max 0.95, clamped to [1024, 128000]); for Gemini it maps to
// thinkingLevel. An effort a model can't do is mapped to the nearest supported
// level (or silently ignored), never a hard error.
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// Ceiling for an explicit reasoning token budget. Providers clamp lower (e.g.
// Anthropic at 128k); this just bounds obviously-wrong input.
export const MAX_REASONING_TOKENS = 200_000;

export type ReasoningOptions = {
  reasoningEffort?: ReasoningEffort;
  reasoningMaxTokens?: number;
  reasoningEnabled?: boolean;
  reasoningExclude?: boolean;
};

// OpenRouter's standard sampling range. Models that don't support temperature
// (e.g. some reasoning-only models) have the param dropped by OpenRouter.
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 2;

export type AskOpenRouterInput = ReasoningOptions & {
  model?: string;
  instructions: string;
  prompt: string;
  context?: string;
  temperature?: number;
  analysisModels?: string[];
  judgeModel?: string;
};

// Resolve the caller's model, defaulting to Fusion when omitted/blank.
export function resolveModel(model?: string): string {
  return (model ?? "").trim() || DEFAULT_MODEL;
}

// Optional .env-configured default Fusion panel: a comma-separated list of
// OpenRouter model ids. Blank entries are dropped and the list is capped at the
// 8 panel models Fusion accepts. Read at call time (not module load) so the
// running process always sees the current env. Returns undefined when unset.
export function getEnvFusionAnalysisModels(): string[] | undefined {
  const raw = process.env.OPENROUTER_FUSION_ANALYSIS_MODELS;
  if (!raw) return undefined;
  const models = raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .slice(0, 8);
  return models.length > 0 ? models : undefined;
}

// Optional .env-configured default Fusion judge (synthesis) model id. Returns
// undefined when unset/blank.
export function getEnvFusionJudgeModel(): string | undefined {
  const judge = (process.env.OPENROUTER_FUSION_JUDGE_MODEL ?? "").trim();
  return judge || undefined;
}

// Best-effort secret redaction for anything we send to the external API. Every
// pattern is linear (a single repetition over a simple character class, no
// nested quantifiers) so this is ReDoS-safe even on hostile input.
export function sanitizeContext(context = ""): string {
  return (
    context
      // PEM private-key blocks (any "... PRIVATE KEY" label). [\s\S] is the
      // body; the lazy *? plus distinct delimiters keep this linear.
      .replace(
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        "[REDACTED_PRIVATE_KEY]"
      )
      // OpenRouter keys (specific, high-signal) — must run before the generic
      // sk- rule so they get their own label.
      .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[REDACTED_OPENROUTER_KEY]")
      // Other provider API tokens (prefix-identified, high-signal).
      .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_OPENAI_KEY]")
      .replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
      .replace(/gh[pousr]_[A-Za-z0-9]+/g, "[REDACTED_GITHUB_TOKEN]")
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]")
      .replace(/\bAIza[A-Za-z0-9_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]")
      .replace(/\bxox[baprs]-[A-Za-z0-9-]+/g, "[REDACTED_SLACK_TOKEN]")
      // Generic `Bearer <token>` auth headers.
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
      // Sensitive assignments in either `KEY=value` or `KEY: value` form,
      // including quoted values, covering common YAML/JSON/.env shapes. Kept
      // conservative: only key names ending in API_KEY / SECRET / TOKEN /
      // PASSWORD, plus the legacy OPENAI/ANTHROPIC names.
      .replace(
        /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g,
        "$1=[REDACTED]"
      )
      // Generic high-entropy token catch-all (runs last). Require the 40+ char
      // run to MIX lower + UPPER + digit — the signature of a random secret — so
      // ordinary long strings pass through untouched: git SHAs and other hex
      // digests (no uppercase), SCREAMING_CONSTANTS / snake_case identifiers (no
      // digit), and plain prose. The three lookaheads each scan a fixed class
      // with no nested quantifiers, so this stays linear (ReDoS-safe).
      .replace(
        /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g,
        "[REDACTED_TOKEN]"
      )
  );
}

// Build the Chat Completions request body. Exported for unit testing. All
// outbound text is run through the secret redactor. For the Fusion model the
// panel + judge are resolved with precedence: per-call arg > .env default
// (OPENROUTER_FUSION_ANALYSIS_MODELS / OPENROUTER_FUSION_JUDGE_MODEL) >
// OpenRouter's built-in preset. Explicit per-call Fusion options passed with any
// other model are a caller error.
export function buildRequestBody(args: ReasoningOptions & {
  model: string;
  instructions: string;
  prompt: string;
  context?: string;
  temperature?: number;
  analysisModels?: string[];
  judgeModel?: string;
}): Record<string, unknown> {
  const {
    model,
    instructions,
    prompt,
    context,
    temperature,
    reasoningEffort,
    reasoningMaxTokens,
    reasoningEnabled,
    reasoningExclude,
    analysisModels,
    judgeModel,
  } = args;

  const safeInstructions = sanitizeContext(instructions);
  const safePrompt = sanitizeContext(prompt);
  const safeContext = sanitizeContext(context ?? "");
  const userContent = safeContext
    ? `${safePrompt}\n\nContext:\n${safeContext}`
    : safePrompt;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: safeInstructions },
      { role: "user", content: userContent },
    ],
  };

  if (temperature !== undefined) {
    if (
      typeof temperature !== "number" ||
      !Number.isFinite(temperature) ||
      temperature < MIN_TEMPERATURE ||
      temperature > MAX_TEMPERATURE
    ) {
      throw new Error(
        `temperature must be a number between ${MIN_TEMPERATURE} and ${MAX_TEMPERATURE}.`
      );
    }
    body.temperature = temperature;
  }

  // OpenRouter's unified reasoning object. `effort` (named level) and
  // `max_tokens` (explicit budget) are mutually exclusive per the API spec.
  if (reasoningEffort && reasoningMaxTokens !== undefined) {
    throw new Error(
      "reasoning_effort and reasoning_max_tokens are mutually exclusive: pass a named level OR an explicit token budget, not both."
    );
  }
  if (
    reasoningMaxTokens !== undefined &&
    (!Number.isInteger(reasoningMaxTokens) ||
      reasoningMaxTokens < 1 ||
      reasoningMaxTokens > MAX_REASONING_TOKENS)
  ) {
    throw new Error(
      `reasoning_max_tokens must be an integer between 1 and ${MAX_REASONING_TOKENS}.`
    );
  }
  const reasoning: Record<string, unknown> = {};
  if (reasoningEffort) reasoning.effort = reasoningEffort;
  if (reasoningMaxTokens !== undefined) reasoning.max_tokens = reasoningMaxTokens;
  if (reasoningEnabled !== undefined) reasoning.enabled = reasoningEnabled;
  if (reasoningExclude !== undefined) reasoning.exclude = reasoningExclude;
  if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;

  // Explicit per-call Fusion knobs are only valid on the Fusion model. (The .env
  // defaults below are silently ignored for non-fusion models, but a caller
  // passing these knobs with another model is a mistake worth surfacing.)
  const hasExplicitFusionOpts =
    (analysisModels && analysisModels.length > 0) || !!judgeModel;
  if (hasExplicitFusionOpts && model !== FUSION_MODEL) {
    throw new Error(
      `Fusion options (analysis_models / judge_model) only apply to model "${FUSION_MODEL}". ` +
        `Set model to "${FUSION_MODEL}" or remove those options.`
    );
  }

  if (model === FUSION_MODEL) {
    // Precedence is resolved per field: per-call arg > .env default >
    // OpenRouter's built-in preset (nothing attached). Panel and judge each fall
    // back independently, so an env default can fill in whichever the caller omits.
    const effectiveAnalysis =
      analysisModels && analysisModels.length > 0
        ? analysisModels
        : getEnvFusionAnalysisModels();
    const effectiveJudge = judgeModel || getEnvFusionJudgeModel();

    if ((effectiveAnalysis && effectiveAnalysis.length > 0) || effectiveJudge) {
      const fusion: Record<string, unknown> = { id: "fusion" };
      if (effectiveAnalysis && effectiveAnalysis.length > 0) {
        fusion.analysis_models = effectiveAnalysis;
      }
      if (effectiveJudge) fusion.model = effectiveJudge;
      body.plugins = [fusion];
    }
  }

  return body;
}

// A single entry point. There is no separate "worker" vs "architect" function:
// the caller picks the model (default openrouter/fusion), writes the
// instructions, and optionally sets reasoning effort / Fusion options. Which
// role it plays is a matter of those choices plus the orchestration pattern
// applied around it, not a different code path.
export async function askOpenRouter(input: AskOpenRouterInput): Promise<string> {
  const apiKey = getApiKey();
  const model = resolveModel(input.model);
  const body = buildRequestBody({
    model,
    instructions: input.instructions,
    prompt: input.prompt,
    context: input.context,
    temperature: input.temperature,
    reasoningEffort: input.reasoningEffort,
    reasoningMaxTokens: input.reasoningMaxTokens,
    reasoningEnabled: input.reasoningEnabled,
    reasoningExclude: input.reasoningExclude,
    analysisModels: input.analysisModels,
    judgeModel: input.judgeModel,
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  // Optional OpenRouter attribution headers (used for app rankings).
  const siteUrl = process.env.OPENROUTER_SITE_URL?.trim();
  const appName = process.env.OPENROUTER_APP_NAME?.trim();
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;
  if (appName) headers["X-Title"] = appName;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure / abort. Log full detail to stderr; return a generic,
    // redacted message to the client (request body may echo user content).
    console.error("[openrouter-subagents] request failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`ask_openrouter request failed: ${sanitizeContext(detail)}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    console.error(
      "[openrouter-subagents] non-JSON response:",
      res.status,
      raw.slice(0, 500)
    );
    throw new Error(`ask_openrouter failed: HTTP ${res.status} (non-JSON response)`);
  }

  if (!res.ok || data?.error) {
    const msg =
      data?.error?.message ||
      (typeof data?.error === "string" ? data.error : "") ||
      `HTTP ${res.status}`;
    console.error("[openrouter-subagents] API error:", res.status, msg);
    throw new Error(`ask_openrouter failed: ${sanitizeContext(String(msg))}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  // Some providers may return content as an array of parts; join their text.
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === "string" ? p : p?.text ?? ""))
      .join("");
  }
  return "";
}
