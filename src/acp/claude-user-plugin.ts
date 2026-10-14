import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSettingsUnavailableError } from "../errors.js";

// The operator's own Claude Code skills and agents reach Claude-family sessions as
// one local plugin, ~/.acpx/claude-user-plugin, rendered by the operator's tooling
// (Liaison: `liaison acpx link`). Claude Code lists them as `<plugin name>:<name>`.
// A plugin can carry more than skills and agents (hooks, MCP and LSP servers,
// commands, settings), and a skill or agent file can widen what the session may do
// (allowed-tools approve tool calls without asking acpx; hooks can answer allow).
// Only skills and agents without such keys are accepted; anything else refuses
// the session, so a stale or hand-edited plugin never loads.

export type ClaudeUserPlugin = { type: "local"; path: string; skipMcpDiscovery: true };

const PLUGIN_ENTRIES = new Set([".claude-plugin", "skills", "agents"]);
const MANIFEST_KEYS = new Set(["name", "description", "version"]);
// Frontmatter keys (compared lower-case, `_` read as `-`) that give a skill or an
// agent tool approvals, hooks, servers or a permission mode of its own.
const SKILL_FORBIDDEN_KEYS = new Set([
  "allowed-tools",
  "hooks",
  "mcpservers",
  "lspservers",
  "agents",
]);
const AGENT_FORBIDDEN_KEYS = new Set(["hooks", "mcpservers", "permissionmode", "allowed-tools"]);

export function claudeUserPluginPath(home: string = os.homedir()): string {
  return path.join(home, ".acpx", "claude-user-plugin");
}

function refuse(message: string, cause?: unknown): ClaudeSettingsUnavailableError {
  return new ClaudeSettingsUnavailableError(
    `${message}; re-render it with \`liaison acpx link --install\` or remove it; refusing to start the session.`,
    { cause },
  );
}

const FRONTMATTER_KEY = /^(?:"([^"]+)"|'([^']+)'|([^\s#:'"?{[][^:]*?))\s*:/;
const UNCHECKABLE_KEY = /^[?{[]/;

function frontmatterLineKey(line: string): string | undefined {
  const match = FRONTMATTER_KEY.exec(line);
  if (match) {
    return (match[1] ?? match[2] ?? match[3] ?? "").trim();
  }
  // complex or flow-style keys cannot be checked; they are reported as they are
  return UNCHECKABLE_KEY.test(line) ? line.trim() : undefined;
}

// Top-level keys of a Markdown file's leading YAML frontmatter.
export function frontmatterKeys(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return [];
  }
  const keys: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") {
      break;
    }
    const key = frontmatterLineKey(line);
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return keys;
}

function forbiddenKeys(file: string, forbidden: Set<string>): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw refuse(`Claude user plugin file is unreadable: ${file}`, error);
  }
  return frontmatterKeys(text).filter((key) => {
    const normalized = key.toLowerCase().replaceAll("_", "-");
    return forbidden.has(normalized) || UNCHECKABLE_KEY.test(key);
  });
}

function realDirectory(dir: string, label: string): void {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw refuse(`${label} is not a real directory: ${dir}`);
  }
}

function checkManifest(dir: string): void {
  realDirectory(dir, "Claude user plugin manifest directory");
  const entries = readdirSync(dir);
  if (entries.length !== 1 || entries[0] !== "plugin.json") {
    throw refuse(`Claude user plugin manifest directory must hold only plugin.json: ${dir}`);
  }
  const manifest = readManifest(dir);
  const extra = Object.keys(manifest).filter((key) => !MANIFEST_KEYS.has(key));
  if (extra.length > 0) {
    throw refuse(`Claude user plugin manifest declares ${extra.join(", ")}: ${dir}`);
  }
}

function readManifest(dir: string): Record<string, unknown> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "plugin.json"), "utf8"));
  } catch (error) {
    throw refuse(`Claude user plugin manifest is not valid JSON: ${dir}`, error);
  }
  const isObject = manifest !== null && typeof manifest === "object" && !Array.isArray(manifest);
  if (!isObject || typeof (manifest as Record<string, unknown>).name !== "string") {
    throw refuse(`Claude user plugin manifest must be an object with a name: ${dir}`);
  }
  return manifest as Record<string, unknown>;
}

function checkSkills(dir: string): void {
  realDirectory(dir, "Claude user plugin skills directory");
  for (const name of readdirSync(dir).toSorted()) {
    const skill = path.join(dir, name);
    let stat;
    try {
      stat = statSync(skill);
    } catch (error) {
      throw refuse(`Claude user plugin skill points nowhere: ${skill}`, error);
    }
    const file = path.join(skill, "SKILL.md");
    if (!stat.isDirectory() || !statSafe(file)?.isFile()) {
      throw refuse(`Claude user plugin skill is not a skill directory: ${skill}`);
    }
    const keys = forbiddenKeys(file, SKILL_FORBIDDEN_KEYS);
    if (keys.length > 0) {
      throw refuse(`Claude user plugin skill ${name} declares ${keys.join(", ")}`);
    }
  }
}

function checkAgents(dir: string): void {
  realDirectory(dir, "Claude user plugin agents directory");
  for (const name of readdirSync(dir).toSorted()) {
    const file = path.join(dir, name);
    if (!name.endsWith(".md") || !statSafe(file)?.isFile()) {
      throw refuse(`Claude user plugin agent is not a Markdown file: ${file}`);
    }
    const keys = forbiddenKeys(file, AGENT_FORBIDDEN_KEYS);
    if (keys.length > 0) {
      throw refuse(`Claude user plugin agent ${name} declares ${keys.join(", ")}`);
    }
  }
}

function lstatSafe(file: string) {
  try {
    return lstatSync(file);
  } catch {
    return undefined;
  }
}

function statSafe(file: string) {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

// The plugin to load, undefined when there is none; refuses one that carries
// anything but plain skills and agents.
export function loadClaudeUserPlugin(home: string = os.homedir()): ClaudeUserPlugin | undefined {
  const dir = claudeUserPluginPath(home);
  const stat = lstatSafe(dir);
  if (!stat) {
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw refuse(`Claude user plugin is not a real directory: ${dir}`);
  }
  checkPluginEntries(dir);
  return { type: "local", path: dir, skipMcpDiscovery: true };
}

function checkPluginEntries(dir: string): void {
  const entries = readdirSync(dir);
  const unexpected = entries.filter((entry) => !PLUGIN_ENTRIES.has(entry));
  if (unexpected.length > 0) {
    throw refuse(
      `Claude user plugin may hold only skills and agents, found ${unexpected.toSorted().join(", ")}: ${dir}`,
    );
  }
  if (!entries.includes(".claude-plugin")) {
    throw refuse(`Claude user plugin has no manifest: ${dir}`);
  }
  checkManifest(path.join(dir, ".claude-plugin"));
  if (entries.includes("skills")) {
    checkSkills(path.join(dir, "skills"));
  }
  if (entries.includes("agents")) {
    checkAgents(path.join(dir, "agents"));
  }
}
