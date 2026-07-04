#!/usr/bin/env node
// CLI twin of the MCP server. Same client (openRouter.ts) and patterns library
// (patterns.ts), but invoked as a shell command: the answer comes back as raw
// text on stdout with zero JSON-RPC framing, so an agent driving it through a
// shell tool spends no tokens on MCP boilerplate. Piped stdin becomes the
// prompt (or, when a prompt is given, the context), so large inputs never have
// to be echoed through the model's context at all:
//
//   openrouter-subagents ask -m anthropic/claude-haiku-4.5 -e high "why is the sky blue?"
//   git diff | openrouter-subagents ask -p "review this diff" -e xhigh
//   openrouter-subagents patterns
import { config } from "dotenv";
import { readFileSync, realpathSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  askOpenRouter,
  REASONING_EFFORTS,
  MIN_TEMPERATURE,
  MAX_TEMPERATURE,
  type ReasoningEffort,
  type AskOpenRouterInput,
} from "./openRouter.js";
import { listPatterns, getPattern, patternNames } from "./patterns.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled to <pkg>/dist/cli.js; the colocated .env is one level up (same
// resolution as server.ts). quiet suppresses dotenv's stdout banner, which
// would otherwise pollute the machine-readable output.
config({ path: resolve(__dirname, "..", ".env"), quiet: true });

// CLI callers often just want an answer; unlike the MCP tool (where the
// orchestrating agent is expected to write a role prompt every call), default
// the system prompt to a terse expert.
export const DEFAULT_INSTRUCTIONS =
  "You are an expert assistant. Answer directly and concisely; output the raw result without preamble.";

export type AskFlags = {
  model?: string;
  instructions?: string;
  instructionsFile?: string;
  prompt?: string;
  promptFile?: string;
  context?: string;
  contextFile?: string;
  effort?: string;
  reasoningTokens?: string;
  reasoning?: string;
  hideReasoning?: boolean;
  temperature?: string;
  analysisModels?: string;
  judge?: string;
  positional: string[];
};

// flag spec: long name -> { key, takesValue }, plus short aliases.
const FLAGS: Record<string, { key: keyof AskFlags; takesValue: boolean }> = {
  "--model": { key: "model", takesValue: true },
  "-m": { key: "model", takesValue: true },
  "--instructions": { key: "instructions", takesValue: true },
  "-i": { key: "instructions", takesValue: true },
  "--instructions-file": { key: "instructionsFile", takesValue: true },
  "--prompt": { key: "prompt", takesValue: true },
  "-p": { key: "prompt", takesValue: true },
  "--prompt-file": { key: "promptFile", takesValue: true },
  "--context": { key: "context", takesValue: true },
  "-c": { key: "context", takesValue: true },
  "--context-file": { key: "contextFile", takesValue: true },
  "--effort": { key: "effort", takesValue: true },
  "-e": { key: "effort", takesValue: true },
  "--reasoning-tokens": { key: "reasoningTokens", takesValue: true },
  "--reasoning": { key: "reasoning", takesValue: true },
  "--hide-reasoning": { key: "hideReasoning", takesValue: false },
  "--temperature": { key: "temperature", takesValue: true },
  "-t": { key: "temperature", takesValue: true },
  "--analysis-models": { key: "analysisModels", takesValue: true },
  "--judge": { key: "judge", takesValue: true },
};

export class UsageError extends Error {}

export function parseAskFlags(argv: string[]): AskFlags {
  const flags: AskFlags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const spec = FLAGS[arg];
    if (spec) {
      if (spec.takesValue) {
        const value = argv[++i];
        if (value === undefined) throw new UsageError(`${arg} requires a value`);
        (flags as any)[spec.key] = value;
      } else {
        (flags as any)[spec.key] = true;
      }
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`Unknown option: ${arg} (see --help)`);
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

// Turn parsed flags (+ any piped stdin) into an AskOpenRouterInput. Pure and
// exported for tests; all runtime validation not already done by
// buildRequestBody (effort names, numbers, on/off) happens here so bad input
// fails fast with a usage message instead of an API round-trip.
export function buildAskInput(flags: AskFlags, stdin: string | null): AskOpenRouterInput {
  const readFile = (path: string) => readFileSync(path, "utf8");

  let prompt =
    flags.prompt ??
    (flags.promptFile ? readFile(flags.promptFile) : undefined) ??
    (flags.positional.length ? flags.positional.join(" ") : undefined);
  let context =
    flags.context ?? (flags.contextFile ? readFile(flags.contextFile) : undefined);

  // Piped stdin fills whichever slot is empty: the prompt if none was given,
  // otherwise the context (`git diff | ... -p "review this"`).
  if (stdin && stdin.trim()) {
    if (prompt === undefined) prompt = stdin;
    else if (context === undefined) context = stdin;
    else throw new UsageError("stdin was piped but both prompt and context are already set");
  }
  if (prompt === undefined || !prompt.trim()) {
    throw new UsageError("No prompt. Pass it as an argument, via -p/--prompt(-file), or pipe it on stdin.");
  }

  const input: AskOpenRouterInput = {
    model: flags.model,
    instructions:
      flags.instructions ??
      (flags.instructionsFile ? readFile(flags.instructionsFile) : DEFAULT_INSTRUCTIONS),
    prompt,
    context,
  };

  if (flags.effort !== undefined) {
    if (!REASONING_EFFORTS.includes(flags.effort as ReasoningEffort)) {
      throw new UsageError(
        `Invalid --effort "${flags.effort}". One of: ${REASONING_EFFORTS.join(", ")}`
      );
    }
    input.reasoningEffort = flags.effort as ReasoningEffort;
  }
  if (flags.reasoningTokens !== undefined) {
    const n = Number(flags.reasoningTokens);
    if (!Number.isInteger(n)) throw new UsageError("--reasoning-tokens must be an integer");
    input.reasoningMaxTokens = n;
  }
  if (flags.reasoning !== undefined) {
    if (flags.reasoning !== "on" && flags.reasoning !== "off") {
      throw new UsageError(`--reasoning must be "on" or "off", got "${flags.reasoning}"`);
    }
    input.reasoningEnabled = flags.reasoning === "on";
  }
  if (flags.hideReasoning) input.reasoningExclude = true;
  if (flags.temperature !== undefined) {
    const t = Number(flags.temperature);
    if (!Number.isFinite(t)) throw new UsageError("--temperature must be a number");
    input.temperature = t;
  }
  if (flags.analysisModels !== undefined) {
    const models = flags.analysisModels.split(",").map((m) => m.trim()).filter(Boolean);
    if (models.length === 0) throw new UsageError("--analysis-models needs at least one model id");
    input.analysisModels = models;
  }
  if (flags.judge !== undefined) input.judgeModel = flags.judge;

  return input;
}

const HELP = `openrouter-subagents — ask any OpenRouter model from the shell (CLI twin of the MCP server)

Usage:
  openrouter-subagents ask [options] [prompt...]     ask a model (raw answer on stdout)
  openrouter-subagents patterns                      list orchestration patterns
  openrouter-subagents pattern <name>                print one pattern in full

"ask" may be omitted: openrouter-subagents "why is the sky blue?"
Piped stdin becomes the prompt — or the context when a prompt is given:
  git diff | openrouter-subagents ask -p "review this diff" -e xhigh

Options:
  -m, --model <id>             OpenRouter model id (default: openrouter/fusion — a panel + judge;
                               bills every panel model, so pass a single model for cheap work)
  -i, --instructions <text>    system prompt (default: terse expert). --instructions-file <path>
  -p, --prompt <text>          the task/question. --prompt-file <path>, positional, or stdin
  -c, --context <text>         extra context. --context-file <path>, or stdin (see above)
  -e, --effort <level>         reasoning level: ${REASONING_EFFORTS.join(" | ")}
                               (translated to each model's native scheme; nearest level wins)
      --reasoning-tokens <n>   exact reasoning token budget (instead of --effort, not with it)
      --reasoning <on|off>     default-strength reasoning toggle
      --hide-reasoning         model reasons but thinking tokens aren't returned
  -t, --temperature <n>        sampling temperature ${MIN_TEMPERATURE}-${MAX_TEMPERATURE} (where the model supports it)
      --analysis-models <a,b>  Fusion panel (1-8 ids, comma-separated; fusion model only)
      --judge <id>             Fusion judge/synthesis model (fusion model only)
  -h, --help                   this help

Requires OPENROUTER_API_KEY (from the package's .env or the environment).`;

async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }

  if (argv[0] === "patterns") {
    const patterns = listPatterns();
    if (!patterns.length) {
      console.log("No patterns found.");
      return;
    }
    for (const p of patterns) {
      console.log(`${p.name} — ${p.title}\n  Summary: ${p.summary}\n  Use when: ${p.use_when}\n`);
    }
    return;
  }

  if (argv[0] === "pattern") {
    const name = argv[1];
    if (!name) throw new UsageError("Usage: openrouter-subagents pattern <name>");
    const pattern = getPattern(name);
    if (!pattern) {
      throw new UsageError(
        `No pattern named "${name}". Available: ${patternNames().join(", ") || "(none)"}`
      );
    }
    console.log(`# ${pattern.title}\n\n${pattern.body}`);
    return;
  }

  const askArgv = argv[0] === "ask" ? argv.slice(1) : argv;
  const flags = parseAskFlags(askArgv);
  const stdin = await readPipedStdin();
  const input = buildAskInput(flags, stdin);
  process.stdout.write((await askOpenRouter(input)) + "\n");
}

// Only run when executed as a binary, not when imported by tests. realpath
// follows the bin symlink npm creates on install.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    const usage = err instanceof UsageError;
    console.error(usage ? String(err.message) : `Error: ${err instanceof Error ? err.message : err}`);
    process.exit(usage ? 2 : 1);
  });
}
