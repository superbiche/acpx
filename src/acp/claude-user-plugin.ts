import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSettingsUnavailableError } from "../errors.js";

// The operator's own Claude Code skills and agents reach Claude-family sessions as
// one local plugin, ~/.acpx/claude-user-plugin, rendered by the operator's tooling
// (Liaison: `liaison acpx link`). Claude Code lists them as `<plugin name>:<name>`.
// A plugin can carry more than skills and agents (hooks, MCP and LSP servers,
// commands, settings), so the plugin's own structure is checked at every session
// start: a real directory holding only the manifest, skills and agents, and a
// manifest with only name, description and version. A stale or hand-edited plugin
// that fails this never loads.
//
// Skill and agent content is delivered as-is: their frontmatter is not screened
// here. A grant key in it (allowed-tools, hooks, permissionMode) can pre-approve
// tool calls without an ACP permission request; that is Claude Code / adapter
// behavior tracked upstream, and the renderer reports such files when it links them.

export type ClaudeUserPlugin = { type: "local"; path: string; skipMcpDiscovery: true };

const PLUGIN_ENTRIES = new Set([".claude-plugin", "skills", "agents"]);
const MANIFEST_KEYS = new Set(["name", "description", "version"]);

export function claudeUserPluginPath(home: string = os.homedir()): string {
  return path.join(home, ".acpx", "claude-user-plugin");
}

function refuse(message: string, cause?: unknown): ClaudeSettingsUnavailableError {
  return new ClaudeSettingsUnavailableError(
    `${message}; re-render it with \`liaison acpx link --install\` or remove it; refusing to start the session.`,
    { cause },
  );
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
  }
}

function checkAgents(dir: string): void {
  realDirectory(dir, "Claude user plugin agents directory");
  for (const name of readdirSync(dir).toSorted()) {
    const file = path.join(dir, name);
    if (!name.endsWith(".md") || !statSafe(file)?.isFile()) {
      throw refuse(`Claude user plugin agent is not a Markdown file: ${file}`);
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
// anything but a manifest, skills and agents.
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
