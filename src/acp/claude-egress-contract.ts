import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

// Vendored copy of Liaison's declared Claude Code egress hook contract
// (liaison/egress/claude-hooks-contract.json, schema liaison-egress-claude-hooks/1),
// without its prose. Liaison renders ~/.acpx/claude-settings.json from the same
// contract and checks it with `liaison egress link --check`; acpx validates the
// settings a Claude session loads against this copy before creating, loading or
// resuming it. Both sides pin CLAUDE_EGRESS_CONTRACT_DIGEST: change them together.
export const CLAUDE_EGRESS_CONTRACT = {
  schema: "liaison-egress-claude-hooks/1",
  topLevelKeys: ["hooks"],
  disablingKeys: ["disableAllHooks"],
  events: {
    PostToolBatch: { script: "egress-cc-post-tool-batch", timeout: 30, onFailure: "block" },
    PostToolUse: { script: "egress-cc-post-tool-use", timeout: 20 },
    PreCompact: { script: "egress-cc-pre-compact", timeout: 60, onFailure: "block" },
    SessionStart: { script: "egress-cc-session-start", timeout: 10 },
    UserPromptSubmit: { script: "egress-cc-user-prompt-submit", timeout: 60, onFailure: "block" },
  },
} as const;

// SHA-256 of the canonical contract (sorted keys, compact separators, no "doc").
export const CLAUDE_EGRESS_CONTRACT_DIGEST =
  "a75eac169a79c173ca35e7596916f2cacb03d67e1b1ec7986ba9f3de13eedddf";

type HookRule = { script: string; timeout: number; onFailure?: string };
export type CommandCheck = (command: string) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const wanted = [...keys].toSorted();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function isExecutableFile(command: string): boolean {
  try {
    accessSync(command, constants.X_OK);
    return statSync(command).isFile();
  } catch {
    return false;
  }
}

// A disabling key set to anything but absent or false turns the egress hooks off.
export function claudeDisablingKeys(settings: Record<string, unknown>): string[] {
  return CLAUDE_EGRESS_CONTRACT.disablingKeys.filter(
    (key) => settings[key] !== undefined && settings[key] !== null && settings[key] !== false,
  );
}

function usableCommand(command: unknown, script: string, isUsable: CommandCheck): string | null {
  if (typeof command !== "string" || !path.isAbsolute(command)) {
    return "command is not an absolute path";
  }
  if (path.basename(command) !== script) {
    return `command is not ${script}`;
  }
  return isUsable(command) ? null : "command is not an executable file";
}

function hookViolation(hook: unknown, rule: HookRule, isUsable: CommandCheck): string | null {
  const keys =
    rule.onFailure === undefined
      ? ["type", "command", "timeout"]
      : ["type", "command", "timeout", "onFailure"];
  if (!isRecord(hook) || !sameKeys(hook, keys) || hook.type !== "command") {
    return "hook shape differs from the contract";
  }
  if (hook.timeout !== rule.timeout || hook.onFailure !== rule.onFailure) {
    return "hook timeout or failure policy differs from the contract";
  }
  return usableCommand(hook.command, rule.script, isUsable);
}

function exactEvent(groups: unknown, rule: HookRule, isUsable: CommandCheck): string | null {
  if (!Array.isArray(groups) || groups.length !== 1) {
    return "expected exactly one hook group";
  }
  const group: unknown = groups[0];
  if (!isRecord(group) || !sameKeys(group, ["hooks"])) {
    return "hook group shape differs from the contract";
  }
  if (!Array.isArray(group.hooks) || group.hooks.length !== 1) {
    return "expected exactly one hook";
  }
  return hookViolation(group.hooks[0], rule, isUsable);
}

function unrestrictedHooks(group: unknown): unknown[] {
  if (!isRecord(group) || !Array.isArray(group.hooks)) {
    return [];
  }
  const matcher = group.matcher;
  return matcher === undefined || matcher === "" || matcher === "*" ? group.hooks : [];
}

function containsEvent(groups: unknown, rule: HookRule, isUsable: CommandCheck): string | null {
  if (!Array.isArray(groups)) {
    return "missing";
  }
  const candidates = groups
    .flatMap(unrestrictedHooks)
    .filter(
      (hook) =>
        isRecord(hook) &&
        typeof hook.command === "string" &&
        path.basename(hook.command) === rule.script,
    );
  if (candidates.length === 0) {
    return "missing";
  }
  const problems = candidates.map((hook) => hookViolation(hook, rule, isUsable));
  return problems.includes(null) ? null : (problems[0] ?? "missing");
}

function eventViolations(
  hooks: Record<string, unknown>,
  exact: boolean,
  isUsable: CommandCheck,
): string[] {
  const rules: Record<string, HookRule> = CLAUDE_EGRESS_CONTRACT.events;
  const found: string[] = [];
  if (exact && !sameKeys(hooks, Object.keys(rules))) {
    found.push("hook events differ from the contract");
  }
  const check = exact ? exactEvent : containsEvent;
  for (const event of Object.keys(rules).toSorted()) {
    const problem = check(hooks[event], rules[event], isUsable);
    if (problem) {
      found.push(`${event}: ${problem}`);
    }
  }
  return found;
}

// Contract violations of parsed settings; empty when the egress hooks are in force.
// exact: an egress-only settings file holds the contract and nothing else.
// contains (exact = false): broader settings carry every contract hook among others.
export function claudeEgressContractViolations(
  settings: unknown,
  exact: boolean,
  isUsable: CommandCheck = isExecutableFile,
): string[] {
  if (!isRecord(settings)) {
    return ["settings are not a JSON object"];
  }
  const found = claudeDisablingKeys(settings).map((key) => `${key} disables hooks`);
  if (exact && !sameKeys(settings, CLAUDE_EGRESS_CONTRACT.topLevelKeys)) {
    found.push("top-level keys differ from the contract");
  }
  if (!isRecord(settings.hooks)) {
    return [...found, "hooks is not an object"];
  }
  return [...found, ...eventViolations(settings.hooks, exact, isUsable)];
}
