import { readdirSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled to <pkg>/dist/patterns.js, so the patterns/ folder is one level up.
// Mirrors how server.ts resolves the colocated .env. OPENROUTER_SUBAGENTS_PATTERNS_DIR
// overrides this (used by tests to point at a temp dir); unset in production.
const PATTERNS_DIR =
  process.env.OPENROUTER_SUBAGENTS_PATTERNS_DIR?.trim() ||
  resolve(__dirname, "..", "patterns");

export type PatternMeta = {
  name: string;
  title: string;
  summary: string;
  use_when: string;
};

export type Pattern = PatternMeta & {
  body: string;
};

// Minimal single-line `key: value` frontmatter parser. Avoids a dependency —
// pattern frontmatter is intentionally simple (one line per field).
export function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  // The close delimiter must be a standalone `---` line (optionally trailed by
  // spaces/tabs, then a newline or EOF) — a line like `---not-a-close` must NOT
  // count as the close. Kept linear (no nested ambiguous quantifiers).
  const match = raw.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw };
  }
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: match[2].trim() };
}

// A file counts as a pattern only if it declares frontmatter with a `name`.
// This keeps stray Markdown (notes, drafts, plugin-generated CLAUDE.local.md,
// etc.) out of the catalog. Returns null for anything that isn't a real pattern.
function loadPattern(file: string): Pattern | null {
  let raw: string;
  try {
    raw = readFileSync(join(PATTERNS_DIR, file), "utf8");
  } catch {
    // Unreadable entry: skip it rather than leak an absolute-path error to the
    // client (the .env lives in the parent dir).
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  if (!meta.name) return null;
  return {
    name: meta.name,
    title: meta.title || meta.name,
    summary: meta.summary || "",
    use_when: meta.use_when || "",
    body,
  };
}

// Patterns are read fresh on each call, so adding or editing one needs no
// rebuild or server restart. README.md is the folder's own docs, not a pattern;
// the html/ subfolder and other non-.md entries are ignored automatically.
function loadAll(): Pattern[] {
  let files: string[];
  try {
    files = readdirSync(PATTERNS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
  } catch {
    return [];
  }
  return files
    .sort()
    .map(loadPattern)
    .filter((p): p is Pattern => p !== null);
}

export function listPatterns(): PatternMeta[] {
  return loadAll().map(({ name, title, summary, use_when }) => ({
    name,
    title,
    summary,
    use_when,
  }));
}

export function getPattern(name: string): Pattern | null {
  const target = name.trim().toLowerCase();
  return loadAll().find((p) => p.name.toLowerCase() === target) || null;
}

export function patternNames(): string[] {
  return loadAll().map((p) => p.name);
}
