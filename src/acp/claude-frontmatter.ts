// The frontmatter a skill or agent file may carry into Claude-family sessions.
//
// Allowlist, not denylist: a file is admitted only when its frontmatter is a flat
// mapping written in a small YAML subset whose reading is unambiguous, and every
// key is listed in SKILL_KEYS / AGENT_KEYS with a value of the listed type.
// Anything else (an unknown key, an indented or flow mapping, a quoted key, an
// anchor, alias, tag or merge key, a continued or escaped value, a non-string
// value where a string is expected, a tab, a carriage return, a byte-order mark, a
// second `---` inside the block) excludes the file. acpx declares no YAML parser;
// the subset is small enough to read exactly, and its readings are checked against
// Claude Code's own parser (Bun.YAML) over the shared corpus.
//
// Same rule, same problem codes and same corpus as Liaison's
// liaison/acpx_claude/frontmatter.py: test/fixtures/claude-frontmatter-corpus.json
// is byte-identical in both repositories (its SHA-256 is pinned in both test suites).
//
// The subset, line by line inside the block (between a first line `---` and the
// next line `---`):
// - an empty line, or a comment line starting with `#` in column 0;
// - `key: value` in column 0, the key matching [A-Za-z][A-Za-z0-9_-]*, the value one
//   of: a plain scalar on one line (not starting with a YAML indicator, without
//   `: ` or ` #`, not ending with `:`); a double-quoted string on one line without
//   backslashes; a single-quoted string on one line; a block scalar header `|` or
//   `>` (optional `-`/`+`) followed by lines indented at least as much as its first
//   content line.
// Plain scalars are typed with the YAML 1.2 core schema (null, booleans, integers,
// floats), the schema Claude Code's parser applies.

export type FrontmatterKind = "skill" | "agent";
type ValueType = "string" | "boolean";

// The keys Claude Code needs to list and describe a skill or an agent, and inert
// metadata the operator's library uses; nothing that names tools, grants, hooks,
// servers, models or modes.
export const SKILL_KEYS: Readonly<Record<string, ValueType>> = {
  name: "string",
  description: "string",
  when_to_use: "string",
  "argument-hint": "string",
  "user-invocable": "boolean",
  "disable-model-invocation": "boolean",
  license: "string",
  last_verified: "string",
};
export const AGENT_KEYS: Readonly<Record<string, ValueType>> = {
  name: "string",
  description: "string",
};
const KEYS: Record<FrontmatterKind, Readonly<Record<string, ValueType>>> = {
  skill: SKILL_KEYS,
  agent: AGENT_KEYS,
};

export type FrontmatterVerdict =
  | { admitted: true; keys: string[] }
  | { admitted: false; code: string; detail: string };

const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/;
const BLOCK_HEADER = /^[|>][-+]?$/;
const DOUBLE_QUOTED = /^"[^"\\]*"$/;
const SINGLE_QUOTED = /^'(?:[^']|'')*'$/;
const INDICATORS = new Set("-?:,[]{}#&*!|>'\"%@`");
// Control characters (tab and carriage return included) and the characters some
// YAML readers take as line breaks.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f\u0085\u2028\u2029]/;
const CORE_NULL = /^(?:~|null|Null|NULL)$/;
const CORE_BOOL = /^(?:true|True|TRUE|false|False|FALSE)$/;
const CORE_INT = /^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/;
const CORE_FLOAT =
  /^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

function excluded(code: string, detail: string): FrontmatterVerdict {
  return { admitted: false, code, detail };
}

// YAML 1.2 core-schema type of a plain scalar.
export function plainType(value: string): "null" | "boolean" | "number" | "string" {
  if (CORE_NULL.test(value)) {
    return "null";
  }
  if (CORE_BOOL.test(value)) {
    return "boolean";
  }
  if (CORE_INT.test(value) || CORE_FLOAT.test(value)) {
    return "number";
  }
  return "string";
}

type ValueReading = { type?: string; next: number; why: string };

// Lines of a block scalar: empty, or indented with spaces; the first content line
// sets the least indentation.
function blockScalar(block: string[], start: number): ValueReading {
  let end = start;
  while (end < block.length && (block[end] === "" || block[end].startsWith(" "))) {
    end += 1;
  }
  const content = block.slice(start, end).filter((line) => line !== "");
  const widths = content.map((line) => line.length - line.replace(/^ +/, "").length);
  if (content.some((line, i) => widths[i] === line.length)) {
    return { next: end, why: "a block scalar line holds only spaces" };
  }
  if (widths.some((width) => width < widths[0])) {
    return { next: end, why: "a block scalar line is less indented than its first line" };
  }
  return { type: "string", next: end, why: "" };
}

function quotedValue(raw: string, start: number): ValueReading {
  if (raw.startsWith('"')) {
    return DOUBLE_QUOTED.test(raw)
      ? { type: "string", next: start, why: "" }
      : { next: start, why: "a double-quoted value must close on its line without backslashes" };
  }
  return SINGLE_QUOTED.test(raw)
    ? { type: "string", next: start, why: "" }
    : { next: start, why: "a single-quoted value must close on its line" };
}

function plainValue(raw: string, start: number): ValueReading {
  if (raw === "") {
    return { next: start, why: "the value is empty" };
  }
  if (INDICATORS.has(raw[0])) {
    return { next: start, why: `the value starts with the YAML indicator '${raw[0]}'` };
  }
  if (raw.includes(": ") || raw.includes(" #") || raw.endsWith(":")) {
    return { next: start, why: "a plain value may not hold ': ' or ' #' or end with ':'" };
  }
  return { type: plainType(raw), next: start, why: "" };
}

// The value of the line before `start`: its type, or why it is outside the subset.
function readValue(raw: string, block: string[], start: number): ValueReading {
  if (BLOCK_HEADER.test(raw)) {
    return blockScalar(block, start);
  }
  if (raw.startsWith('"') || raw.startsWith("'")) {
    return quotedValue(raw, start);
  }
  return plainValue(raw, start);
}

// The lines between the opening and the closing `---`, or why the framing is refused.
// No frontmatter at all (the file does not start with ---) reads as an empty block.
function frontmatterBlock(text: string): string[] | FrontmatterVerdict {
  if (text.startsWith("\ufeff")) {
    return excluded("byte-order-mark", "the file starts with a byte-order mark");
  }
  if (!text.startsWith("---")) {
    return [];
  }
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    return excluded("opening-line", "the first line must be exactly ---");
  }
  const close = lines.indexOf("---", 1);
  if (close < 0) {
    return excluded("unclosed", "no line --- closes the frontmatter");
  }
  const block = lines.slice(1, close);
  if (block.join("\n").includes("---")) {
    return excluded("ambiguous-close", "--- appears inside the frontmatter");
  }
  const controlLine = block.findIndex((line) => CONTROL.test(line));
  if (controlLine >= 0) {
    return excluded(
      "control-character",
      `line ${controlLine + 2} holds a tab or control character`,
    );
  }
  return block;
}

type Entry = { key?: string; next: number; problem?: FrontmatterVerdict };

// The `key: value` entry starting at block[index].
function readEntry(block: string[], index: number, kind: FrontmatterKind, seen: string[]): Entry {
  const allowed = KEYS[kind];
  const match = KEY_LINE.exec(block[index]);
  if (!match) {
    return {
      next: index + 1,
      problem: excluded("syntax", `line ${index + 2} is not \`key: value\` in column 0`),
    };
  }
  const key = match[1];
  if (seen.includes(key)) {
    return { next: index + 1, problem: excluded("duplicate-key", `${key} appears twice`) };
  }
  const expected = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
  if (expected === undefined) {
    return {
      next: index + 1,
      problem: excluded("key-not-allowed", `${key} is not an allowed ${kind} key`),
    };
  }
  const value = readValue((match[2] ?? "").replace(/ +$/, ""), block, index + 1);
  if (value.type === undefined) {
    return { next: value.next, problem: excluded("value-syntax", `${key}: ${value.why}`) };
  }
  if (value.type !== expected) {
    const detail = `${key} must be a ${expected}, not a ${value.type}`;
    return { next: value.next, problem: excluded("value-type", detail) };
  }
  return { key, next: value.next };
}

// Whether a skill or agent file may be delivered to a Claude-family session.
export function checkFrontmatter(text: string, kind: FrontmatterKind): FrontmatterVerdict {
  const block = frontmatterBlock(text);
  if (!Array.isArray(block)) {
    return block;
  }
  const keys: string[] = [];
  let index = 0;
  while (index < block.length) {
    if (block[index] === "" || block[index].startsWith("#")) {
      index += 1;
      continue;
    }
    const entry = readEntry(block, index, kind, keys);
    if (entry.problem) {
      return entry.problem;
    }
    keys.push(entry.key as string);
    index = entry.next;
  }
  return { admitted: true, keys };
}
