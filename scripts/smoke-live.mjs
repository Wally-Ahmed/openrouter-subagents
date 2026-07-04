// Live smoke test: exercises every reasoning/sampling knob against real,
// cheap models from each provider family through the compiled client
// (dist/openRouter.js). Costs a few cents of OpenRouter credit per run.
//
//   npm run build && node scripts/smoke-live.mjs
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { askOpenRouter } from "../dist/openRouter.js";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const instructions = "You are a test probe. Reply with exactly: OK";
const prompt = "Reply with exactly: OK";

// One scenario per knob × provider mechanism:
// named effort (native, budget-mapped, thinkingLevel-mapped, nearest-mapped,
// disabled), explicit token budget, enabled on/off flag, exclude, temperature.
const scenarios = [
  { name: "OpenAI effort native (low)", model: "openai/gpt-5-nano", reasoningEffort: "low" },
  { name: "OpenAI effort nearest-map (xhigh)", model: "openai/gpt-5-nano", reasoningEffort: "xhigh" },
  { name: "Anthropic effort→budget (medium)", model: "anthropic/claude-haiku-4.5", reasoningEffort: "medium" },
  { name: "Anthropic explicit budget (2048)", model: "anthropic/claude-haiku-4.5", reasoningMaxTokens: 2048 },
  { name: "Anthropic effort + exclude", model: "anthropic/claude-haiku-4.5", reasoningEffort: "low", reasoningExclude: true },
  { name: "Gemini 3 effort→thinkingLevel (minimal)", model: "google/gemini-3-flash-preview", reasoningEffort: "minimal" },
  { name: "Gemini 2.5 explicit budget (512)", model: "google/gemini-2.5-flash", reasoningMaxTokens: 512 },
  { name: "Grok effort disable (none)", model: "x-ai/grok-4.3", reasoningEffort: "none" },
  { name: "DeepSeek enabled flag (true)", model: "deepseek/deepseek-chat-v3.1", reasoningEnabled: true },
  { name: "Qwen budget→thinking_budget (1024)", model: "qwen/qwen3-30b-a3b", reasoningMaxTokens: 1024 },
  { name: "GLM enabled flag (false)", model: "z-ai/glm-4.6", reasoningEnabled: false },
  { name: "Temperature 0 (non-reasoning)", model: "openai/gpt-4o-mini", temperature: 0 },
  { name: "Temperature 1.9 (non-reasoning)", model: "openai/gpt-4o-mini", temperature: 1.9 },
  { name: "Effort max on default fusion-less strong model", model: "anthropic/claude-haiku-4.5", reasoningEffort: "max" },
];

let failures = 0;
await Promise.all(
  scenarios.map(async (s) => {
    const { name, ...args } = s;
    try {
      const out = await askOpenRouter({ instructions, prompt, ...args });
      const ok = typeof out === "string" && out.trim().length > 0;
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL(empty)"}  ${name} [${args.model}] -> ${JSON.stringify(out.slice(0, 40))}`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${name} [${args.model}] -> ${err.message}`);
    }
  })
);

console.log(failures === 0 ? "\nAll live scenarios passed." : `\n${failures} scenario(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
