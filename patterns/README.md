# Orchestration Patterns

Reusable playbooks that tell the calling agent **how** to drive the OpenRouter subagent
tool (`ask_openrouter`) well — not just *that* it exists.

Each pattern is a single Markdown file in this folder. The MCP server reads them
**at call time**, so adding or editing a pattern needs no rebuild or restart.

## How the agent uses them

1. `list_patterns` → catalog of every pattern (name, title, summary, when to use).
2. `get_pattern("<name>")` → the full text of one pattern.

The server's startup `instructions` nudge the agent to consult patterns before any
non-trivial expert work (reviews, audits, threat modeling, large-document analysis).

## Available patterns

| name | summary |
|------|---------|
| `two-layer-cross-model-expert` | Wrap the OpenRouter expert in verifying Claude subagents so the orchestrator only ever sees parallel, context-cheap, ground-truth-checked conclusions. |
| `worker-orchestrator` | Fan concrete implementation work out to the OpenRouter worker through cheap Sonnet wrapper subagents — validated by execution, not a verification gate. |

## Adding a pattern

1. Create `patterns/<your-pattern-name>.md`.
2. Start the file with single-line YAML frontmatter:

   ```
   ---
   name: your-pattern-name
   title: Human-Readable Title
   summary: One sentence describing what the pattern does.
   use_when: Comma-separated situations where this pattern is the right call.
   ---
   ```

3. Write the pattern body below the closing `---` (Markdown; mermaid diagrams render
   on GitHub).
4. Add a row to the table above.

**Notes**

- Keep each frontmatter field on a **single line** — the parser is intentionally minimal.
- `name` should match the filename (without `.md`); it's how `get_pattern` looks it up.
- This `README.md` is ignored by `list_patterns`.
