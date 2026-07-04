import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sanitizeContext,
  resolveModel,
  buildRequestBody,
  askOpenRouter,
  FUSION_MODEL,
  REASONING_EFFORTS,
  MAX_REASONING_TOKENS,
  MAX_TEMPERATURE,
  getEnvFusionAnalysisModels,
  getEnvFusionJudgeModel,
} from "../openRouter.js";

describe("sanitizeContext — provider secret classes", () => {
  it("redacts OpenRouter sk-or-v1- keys with their own label", () => {
    const key = "sk-or-v1-" + "a1B2c3D4".repeat(8);
    const out = sanitizeContext(`use ${key} now`);
    expect(out).not.toContain(key);
    expect(out).toContain("[REDACTED_OPENROUTER_KEY]");
  });

  it("redacts OpenAI sk- keys", () => {
    const out = sanitizeContext("token sk-AbC0123456789_def-XYZ end");
    expect(out).not.toContain("sk-AbC0123456789_def-XYZ");
    expect(out).toContain("[REDACTED_OPENAI_KEY]");
  });

  it("redacts GitHub classic (ghp_) and fine-grained (github_pat_) tokens", () => {
    const ghp = "ghp_" + "A".repeat(36);
    const pat = "github_pat_" + "B".repeat(22) + "_" + "C".repeat(59);
    const out = sanitizeContext(`a ${ghp} b ${pat} c`);
    expect(out).not.toContain(ghp);
    expect(out).not.toContain(pat);
    expect(out).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts AWS access key ids (AKIA / ASIA)", () => {
    const akia = "AKIA" + "1234567890ABCDEF";
    const asia = "ASIA" + "ABCDEF1234567890";
    const out = sanitizeContext(`${akia} and ${asia}`);
    expect(out).not.toContain(akia);
    expect(out).not.toContain(asia);
    expect(out).toContain("[REDACTED_AWS_KEY]");
  });

  it("redacts generic Bearer tokens", () => {
    const out = sanitizeContext("Authorization: Bearer abc.DEF-123_xyz==");
    expect(out).not.toContain("abc.DEF-123_xyz==");
    expect(out).toContain("Bearer [REDACTED]");
  });

  it("redacts PEM private-key blocks", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAk",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = sanitizeContext(`here is a key:\n${pem}\ndone`);
    expect(out).not.toContain("MIIBVAIBADAN");
    expect(out).toContain("[REDACTED_PRIVATE_KEY]");
    expect(out).toContain("here is a key:");
    expect(out).toContain("done");
  });

  it("leaves ordinary prose and a git SHA intact", () => {
    const text =
      "The key insight is that commit 0123456789abcdef0123456789abcdef01234567 is green.";
    expect(sanitizeContext(text)).toBe(text);
  });

  it("returns empty string for empty / default input", () => {
    expect(sanitizeContext()).toBe("");
    expect(sanitizeContext("")).toBe("");
  });

  it("stays linear (ReDoS-safe) on large hostile input", () => {
    const hostile = "Bearer " + "a".repeat(200_000) + " " + "-".repeat(200_000);
    const start = Date.now();
    const out = sanitizeContext(hostile);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).toContain("Bearer [REDACTED]");
  });
});

describe("resolveModel", () => {
  it("defaults to openrouter/fusion when omitted or blank", () => {
    expect(resolveModel()).toBe(FUSION_MODEL);
    expect(resolveModel("")).toBe(FUSION_MODEL);
    expect(resolveModel("   ")).toBe(FUSION_MODEL);
  });
  it("passes an explicit model id through", () => {
    expect(resolveModel("anthropic/claude-opus-latest")).toBe(
      "anthropic/claude-opus-latest"
    );
  });
});

describe("buildRequestBody", () => {
  const base = { model: FUSION_MODEL, instructions: "be terse", prompt: "do X" };

  it("builds system + user messages", () => {
    const body = buildRequestBody(base);
    expect(body.model).toBe(FUSION_MODEL);
    expect(body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "do X" },
    ]);
    expect(body.plugins).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it("appends a Context block when context is given", () => {
    const body = buildRequestBody({ ...base, context: "ctx here" });
    expect((body.messages as any)[1].content).toBe("do X\n\nContext:\nctx here");
  });

  it("maps reasoningEffort to reasoning.effort", () => {
    const body = buildRequestBody({ ...base, reasoningEffort: "high" });
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("accepts every unified effort level", () => {
    for (const effort of REASONING_EFFORTS) {
      const body = buildRequestBody({ ...base, reasoningEffort: effort });
      expect(body.reasoning).toEqual({ effort });
    }
  });

  it("maps reasoningMaxTokens to reasoning.max_tokens", () => {
    const body = buildRequestBody({ ...base, reasoningMaxTokens: 8000 });
    expect(body.reasoning).toEqual({ max_tokens: 8000 });
  });

  it("throws when effort and max_tokens are both given (mutually exclusive)", () => {
    expect(() =>
      buildRequestBody({ ...base, reasoningEffort: "high", reasoningMaxTokens: 8000 })
    ).toThrow(/mutually exclusive/);
  });

  it("rejects non-integer / out-of-range reasoningMaxTokens", () => {
    expect(() => buildRequestBody({ ...base, reasoningMaxTokens: 0 })).toThrow(
      /between 1 and/
    );
    expect(() => buildRequestBody({ ...base, reasoningMaxTokens: 1.5 })).toThrow(
      /between 1 and/
    );
    expect(() =>
      buildRequestBody({ ...base, reasoningMaxTokens: MAX_REASONING_TOKENS + 1 })
    ).toThrow(/between 1 and/);
  });

  it("maps reasoningEnabled / reasoningExclude, including explicit false", () => {
    expect(
      buildRequestBody({ ...base, reasoningEnabled: true }).reasoning
    ).toEqual({ enabled: true });
    expect(
      buildRequestBody({ ...base, reasoningEnabled: false }).reasoning
    ).toEqual({ enabled: false });
    expect(
      buildRequestBody({ ...base, reasoningExclude: true }).reasoning
    ).toEqual({ exclude: true });
  });

  it("combines effort with enabled/exclude in one reasoning object", () => {
    const body = buildRequestBody({
      ...base,
      reasoningEffort: "xhigh",
      reasoningExclude: true,
    });
    expect(body.reasoning).toEqual({ effort: "xhigh", exclude: true });
  });

  it("omits reasoning entirely when no reasoning options are set", () => {
    expect(buildRequestBody(base).reasoning).toBeUndefined();
  });

  it("maps temperature through, including 0", () => {
    expect(buildRequestBody({ ...base, temperature: 0.7 }).temperature).toBe(0.7);
    expect(buildRequestBody({ ...base, temperature: 0 }).temperature).toBe(0);
    expect(
      buildRequestBody({ ...base, temperature: MAX_TEMPERATURE }).temperature
    ).toBe(MAX_TEMPERATURE);
  });

  it("omits temperature when not set", () => {
    expect(buildRequestBody(base).temperature).toBeUndefined();
  });

  it("rejects out-of-range temperature", () => {
    expect(() => buildRequestBody({ ...base, temperature: -0.1 })).toThrow(
      /temperature must be/
    );
    expect(() =>
      buildRequestBody({ ...base, temperature: MAX_TEMPERATURE + 0.1 })
    ).toThrow(/temperature must be/);
    expect(() => buildRequestBody({ ...base, temperature: NaN })).toThrow(
      /temperature must be/
    );
  });

  it("attaches the fusion plugin when analysis_models / judge given", () => {
    const body = buildRequestBody({
      ...base,
      analysisModels: ["a/b", "c/d"],
      judgeModel: "e/f",
    });
    expect(body.plugins).toEqual([
      { id: "fusion", analysis_models: ["a/b", "c/d"], model: "e/f" },
    ]);
  });

  it("does not attach plugins for bare fusion (preset defaults)", () => {
    expect(buildRequestBody(base).plugins).toBeUndefined();
  });

  it("throws if fusion options are used with a non-fusion model", () => {
    expect(() =>
      buildRequestBody({
        model: "anthropic/claude-opus-latest",
        instructions: "i",
        prompt: "p",
        judgeModel: "x/y",
      })
    ).toThrow(/only apply to model/);
  });

  it("redacts secrets in outbound text", () => {
    const body = buildRequestBody({
      ...base,
      instructions: "key sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(JSON.stringify(body)).not.toContain("sk-or-v1-AAAA");
  });
});

describe("askOpenRouter (mocked fetch)", () => {
  const KEY = "sk-or-v1-testtesttesttesttesttesttest";

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_SITE_URL;
    delete process.env.OPENROUTER_APP_NAME;
  });

  function mockFetch(status: number, payload: unknown) {
    const fn = vi.fn(
      async (_url: any, _init: any) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("returns assistant content, defaults to fusion, sends auth + endpoint", async () => {
    const fn = mockFetch(200, { choices: [{ message: { content: "PONG" } }] });
    const out = await askOpenRouter({ instructions: "i", prompt: "p" });
    expect(out).toBe("PONG");

    const [url, init] = fn.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe(FUSION_MODEL);
  });

  it("includes optional attribution headers when env vars are set", async () => {
    process.env.OPENROUTER_SITE_URL = "https://example.com";
    process.env.OPENROUTER_APP_NAME = "myapp";
    const fn = mockFetch(200, { choices: [{ message: { content: "ok" } }] });
    await askOpenRouter({ instructions: "i", prompt: "p" });
    const init = fn.mock.calls[0][1];
    expect(init.headers["HTTP-Referer"]).toBe("https://example.com");
    expect(init.headers["X-Title"]).toBe("myapp");
  });

  it("throws (redacted) on an error envelope even with HTTP 200", async () => {
    mockFetch(200, { error: { message: "model not found" } });
    await expect(
      askOpenRouter({ instructions: "i", prompt: "p" })
    ).rejects.toThrow(/model not found/);
  });

  it("throws on a non-2xx status", async () => {
    mockFetch(401, { error: { message: "no auth" } });
    await expect(
      askOpenRouter({ instructions: "i", prompt: "p" })
    ).rejects.toThrow(/no auth|HTTP 401/);
  });

  it("throws when OPENROUTER_API_KEY is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    mockFetch(200, { choices: [{ message: { content: "x" } }] });
    await expect(
      askOpenRouter({ instructions: "i", prompt: "p" })
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("env-configured Fusion defaults (precedence)", () => {
  const base = { model: FUSION_MODEL, instructions: "be terse", prompt: "do X" };

  beforeEach(() => {
    delete process.env.OPENROUTER_FUSION_ANALYSIS_MODELS;
    delete process.env.OPENROUTER_FUSION_JUDGE_MODEL;
  });
  afterEach(() => {
    delete process.env.OPENROUTER_FUSION_ANALYSIS_MODELS;
    delete process.env.OPENROUTER_FUSION_JUDGE_MODEL;
  });

  it("parses analysis-models env (trims, drops blanks, caps at 8)", () => {
    process.env.OPENROUTER_FUSION_ANALYSIS_MODELS =
      " a/b , , c/d ,e/f,g/h,i/j,k/l,m/n,o/p,q/r ";
    expect(getEnvFusionAnalysisModels()).toEqual([
      "a/b", "c/d", "e/f", "g/h", "i/j", "k/l", "m/n", "o/p",
    ]);
  });

  it("returns undefined for unset / all-blank analysis-models env", () => {
    expect(getEnvFusionAnalysisModels()).toBeUndefined();
    process.env.OPENROUTER_FUSION_ANALYSIS_MODELS = "  , ,  ";
    expect(getEnvFusionAnalysisModels()).toBeUndefined();
  });

  it("trims judge-model env; undefined when unset or blank", () => {
    expect(getEnvFusionJudgeModel()).toBeUndefined();
    process.env.OPENROUTER_FUSION_JUDGE_MODEL = "  judge/x  ";
    expect(getEnvFusionJudgeModel()).toBe("judge/x");
    process.env.OPENROUTER_FUSION_JUDGE_MODEL = "   ";
    expect(getEnvFusionJudgeModel()).toBeUndefined();
  });

  it("uses .env defaults for bare fusion (no per-call knobs)", () => {
    process.env.OPENROUTER_FUSION_ANALYSIS_MODELS = "a/b,c/d";
    process.env.OPENROUTER_FUSION_JUDGE_MODEL = "judge/x";
    expect(buildRequestBody(base).plugins).toEqual([
      { id: "fusion", analysis_models: ["a/b", "c/d"], model: "judge/x" },
    ]);
  });

  it("per-call knobs override .env defaults (per field)", () => {
    process.env.OPENROUTER_FUSION_ANALYSIS_MODELS = "env/a,env/b";
    process.env.OPENROUTER_FUSION_JUDGE_MODEL = "env/judge";
    const body = buildRequestBody({
      ...base,
      analysisModels: ["call/a"],
      judgeModel: "call/judge",
    });
    expect(body.plugins).toEqual([
      { id: "fusion", analysis_models: ["call/a"], model: "call/judge" },
    ]);
  });

  it("falls back per field: per-call panel + .env judge", () => {
    process.env.OPENROUTER_FUSION_ANALYSIS_MODELS = "env/a,env/b";
    process.env.OPENROUTER_FUSION_JUDGE_MODEL = "env/judge";
    const body = buildRequestBody({ ...base, analysisModels: ["call/a"] });
    expect(body.plugins).toEqual([
      { id: "fusion", analysis_models: ["call/a"], model: "env/judge" },
    ]);
  });

  it("ignores .env Fusion defaults for non-fusion models (no plugins, no throw)", () => {
    process.env.OPENROUTER_FUSION_ANALYSIS_MODELS = "env/a,env/b";
    process.env.OPENROUTER_FUSION_JUDGE_MODEL = "env/judge";
    const body = buildRequestBody({
      model: "anthropic/claude-opus-latest",
      instructions: "i",
      prompt: "p",
    });
    expect(body.plugins).toBeUndefined();
  });

  it("attaches nothing for bare fusion when no .env defaults are set (preset)", () => {
    expect(buildRequestBody(base).plugins).toBeUndefined();
  });
});
