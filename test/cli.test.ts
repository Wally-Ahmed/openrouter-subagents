import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseAskFlags,
  buildAskInput,
  DEFAULT_INSTRUCTIONS,
  UsageError,
} from "../cli.js";
import { REASONING_EFFORTS } from "../openRouter.js";

describe("parseAskFlags", () => {
  it("parses long and short flags plus positionals", () => {
    const flags = parseAskFlags([
      "-m", "openai/gpt-5-nano",
      "--effort", "xhigh",
      "-t", "0.3",
      "why", "is", "the", "sky", "blue",
    ]);
    expect(flags.model).toBe("openai/gpt-5-nano");
    expect(flags.effort).toBe("xhigh");
    expect(flags.temperature).toBe("0.3");
    expect(flags.positional).toEqual(["why", "is", "the", "sky", "blue"]);
  });

  it("parses boolean and file flags", () => {
    const flags = parseAskFlags([
      "--hide-reasoning",
      "--reasoning", "off",
      "--prompt-file", "/tmp/p.txt",
      "--analysis-models", "a/b,c/d",
      "--judge", "e/f",
    ]);
    expect(flags.hideReasoning).toBe(true);
    expect(flags.reasoning).toBe("off");
    expect(flags.promptFile).toBe("/tmp/p.txt");
    expect(flags.analysisModels).toBe("a/b,c/d");
    expect(flags.judge).toBe("e/f");
  });

  it("throws on unknown options and missing values", () => {
    expect(() => parseAskFlags(["--bogus"])).toThrow(UsageError);
    expect(() => parseAskFlags(["--model"])).toThrow(/requires a value/);
  });
});

describe("buildAskInput", () => {
  it("uses positionals as prompt and defaults instructions", () => {
    const input = buildAskInput(parseAskFlags(["hello", "world"]), null);
    expect(input.prompt).toBe("hello world");
    expect(input.instructions).toBe(DEFAULT_INSTRUCTIONS);
    expect(input.model).toBeUndefined();
  });

  it("uses stdin as prompt when no prompt given", () => {
    const input = buildAskInput(parseAskFlags([]), "piped question");
    expect(input.prompt).toBe("piped question");
  });

  it("uses stdin as context when a prompt is given", () => {
    const input = buildAskInput(parseAskFlags(["-p", "review this"]), "the diff");
    expect(input.prompt).toBe("review this");
    expect(input.context).toBe("the diff");
  });

  it("throws when stdin is piped but prompt and context are both set", () => {
    expect(() =>
      buildAskInput(parseAskFlags(["-p", "x", "-c", "y"]), "z")
    ).toThrow(/both prompt and context/);
  });

  it("throws when there is no prompt at all", () => {
    expect(() => buildAskInput(parseAskFlags([]), null)).toThrow(/No prompt/);
  });

  it("maps every reasoning knob and temperature", () => {
    const input = buildAskInput(
      parseAskFlags(["-e", "max", "--hide-reasoning", "-t", "1.5", "q"]),
      null
    );
    expect(input.reasoningEffort).toBe("max");
    expect(input.reasoningExclude).toBe(true);
    expect(input.temperature).toBe(1.5);

    const budget = buildAskInput(
      parseAskFlags(["--reasoning-tokens", "2048", "--reasoning", "on", "q"]),
      null
    );
    expect(budget.reasoningMaxTokens).toBe(2048);
    expect(budget.reasoningEnabled).toBe(true);
  });

  it("accepts every named effort level", () => {
    for (const effort of REASONING_EFFORTS) {
      const input = buildAskInput(parseAskFlags(["-e", effort, "q"]), null);
      expect(input.reasoningEffort).toBe(effort);
    }
  });

  it("rejects invalid effort / reasoning / numbers with usage errors", () => {
    expect(() => buildAskInput(parseAskFlags(["-e", "ultra", "q"]), null)).toThrow(
      /Invalid --effort/
    );
    expect(() =>
      buildAskInput(parseAskFlags(["--reasoning", "maybe", "q"]), null)
    ).toThrow(/"on" or "off"/);
    expect(() =>
      buildAskInput(parseAskFlags(["--reasoning-tokens", "2.5", "q"]), null)
    ).toThrow(/integer/);
    expect(() =>
      buildAskInput(parseAskFlags(["-t", "warm", "q"]), null)
    ).toThrow(/number/);
  });

  it("splits --analysis-models and passes --judge through", () => {
    const input = buildAskInput(
      parseAskFlags(["--analysis-models", " a/b , c/d ", "--judge", "e/f", "q"]),
      null
    );
    expect(input.analysisModels).toEqual(["a/b", "c/d"]);
    expect(input.judgeModel).toBe("e/f");
  });

  it("reads instructions/prompt/context from files", () => {
    const dir = mkdtempSync(join(tmpdir(), "orsub-cli-"));
    writeFileSync(join(dir, "i.txt"), "be a pirate");
    writeFileSync(join(dir, "p.txt"), "say hi");
    writeFileSync(join(dir, "c.txt"), "the ship's log");
    const input = buildAskInput(
      parseAskFlags([
        "--instructions-file", join(dir, "i.txt"),
        "--prompt-file", join(dir, "p.txt"),
        "--context-file", join(dir, "c.txt"),
      ]),
      null
    );
    expect(input.instructions).toBe("be a pirate");
    expect(input.prompt).toBe("say hi");
    expect(input.context).toBe("the ship's log");
  });
});
