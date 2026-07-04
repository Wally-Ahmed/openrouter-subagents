import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../patterns.js";

describe("parseFrontmatter — valid frontmatter", () => {
  it("parses key: value fields and trims the body", () => {
    const raw = [
      "---",
      "name: demo",
      "title: Demo Pattern",
      "summary: a short summary",
      "---",
      "",
      "# Body heading",
      "body text",
    ].join("\n");
    const { meta, body } = parseFrontmatter(raw);
    expect(meta.name).toBe("demo");
    expect(meta.title).toBe("Demo Pattern");
    expect(meta.summary).toBe("a short summary");
    expect(body).toBe("# Body heading\nbody text");
  });

  it("accepts trailing spaces/tabs on the delimiter lines", () => {
    const raw = "--- \nname: demo\n---\t\nbody";
    const { meta, body } = parseFrontmatter(raw);
    expect(meta.name).toBe("demo");
    expect(body).toBe("body");
  });

  it("handles frontmatter at end-of-file with no trailing body", () => {
    const raw = "---\nname: demo\n---";
    const { meta, body } = parseFrontmatter(raw);
    expect(meta.name).toBe("demo");
    expect(body).toBe("");
  });
});

describe("parseFrontmatter — close-delimiter bug regression", () => {
  it("does NOT treat `---not-a-close` as the closing delimiter", () => {
    const raw = ["---", "name: demo", "---not-a-close", "real body"].join("\n");
    const { meta, body } = parseFrontmatter(raw);
    expect(meta.name).toBeUndefined();
    expect(meta).toEqual({});
    expect(body).toBe(raw);
  });

  it("uses the first standalone `---` line as the close, not a `---x` line", () => {
    const raw = [
      "---",
      "name: demo",
      "---trailing",
      "more",
      "---",
      "the body",
    ].join("\n");
    const { meta, body } = parseFrontmatter(raw);
    expect(meta.name).toBe("demo");
    expect(body).toBe("the body");
  });
});

describe("parseFrontmatter — no frontmatter", () => {
  it("returns empty meta + the full raw body when there is no frontmatter", () => {
    const raw = "# Just markdown\n\nno frontmatter here";
    const { meta, body } = parseFrontmatter(raw);
    expect(meta).toEqual({});
    expect(body).toBe(raw);
  });

  it("treats a file whose frontmatter omits `name` as having no name", () => {
    const raw = "---\ntitle: only a title\n---\nbody";
    const { meta } = parseFrontmatter(raw);
    expect(meta.name).toBeUndefined();
    expect(meta.title).toBe("only a title");
  });
});

// Catalog-level tests run against a temp patterns dir seeded per test via the
// OPENROUTER_SUBAGENTS_PATTERNS_DIR override. The module is re-imported fresh so
// it re-reads the env-driven PATTERNS_DIR.
describe("pattern catalog (temp patterns dir)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openrouter-subagents-patterns-"));
    process.env.OPENROUTER_SUBAGENTS_PATTERNS_DIR = dir;
    vi.resetModules(); // so patterns.ts re-reads PATTERNS_DIR on next import
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENROUTER_SUBAGENTS_PATTERNS_DIR;
    vi.resetModules();
  });

  async function freshPatterns() {
    return await import("../patterns.js");
  }

  function writePattern(file: string, contents: string) {
    writeFileSync(join(dir, file), contents);
  }

  it("includes a valid pattern and exposes its fields", async () => {
    writePattern(
      "demo.md",
      [
        "---",
        "name: demo-pattern",
        "title: Demo",
        "summary: a summary",
        "use_when: when testing",
        "---",
        "the body",
      ].join("\n")
    );
    const m = await freshPatterns();
    expect(m.patternNames()).toEqual(["demo-pattern"]);
    const list = m.listPatterns();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "demo-pattern",
      title: "Demo",
      summary: "a summary",
      use_when: "when testing",
    });
  });

  it("excludes README.md, name-less .md files, and subdirectories", async () => {
    writePattern("good.md", "---\nname: good\n---\nbody");
    writePattern("README.md", "---\nname: should-be-ignored\n---\nreadme");
    writePattern("draft.md", "# just notes, no frontmatter name\n");
    writePattern("title-only.md", "---\ntitle: no name here\n---\nbody");
    mkdirSync(join(dir, "html.md")); // a directory whose name ends in .md
    const m = await freshPatterns();
    expect(m.patternNames()).toEqual(["good"]);
  });

  it("getPattern resolves case-insensitively and returns null for unknown", async () => {
    writePattern("p.md", "---\nname: two-layer-cross-model-expert\n---\nBODY TEXT");
    const m = await freshPatterns();
    const p = m.getPattern("TWO-LAYER-CROSS-MODEL-EXPERT");
    expect(p).not.toBeNull();
    expect(p!.name).toBe("two-layer-cross-model-expert");
    expect(p!.body).toBe("BODY TEXT");
    expect(m.getPattern("does-not-exist")).toBeNull();
  });

  it("returns an empty catalog when the dir does not exist", async () => {
    process.env.OPENROUTER_SUBAGENTS_PATTERNS_DIR = join(dir, "nope");
    vi.resetModules();
    const m = await freshPatterns();
    expect(m.listPatterns()).toEqual([]);
    expect(m.patternNames()).toEqual([]);
    expect(m.getPattern("anything")).toBeNull();
  });

  it("a file whose close delimiter is `---not-a-close` is not cataloged", async () => {
    writePattern("bad.md", "---\nname: sneaky\n---not-a-close\nbody");
    const m = await freshPatterns();
    expect(m.patternNames()).toEqual([]);
  });
});
