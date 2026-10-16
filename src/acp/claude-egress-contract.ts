import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

// Vendored copy of Liaison's declared Claude Code egress hook contract
// (liaison/egress/claude-hooks-contract.json, schema liaison-egress-claude-hooks/1),
// without its prose. Redact, never prevent: the hooks rewrite or report secret values
// and never block (`onFailure: continue`); no prompt or compaction hook. Liaison derives
// ~/.acpx/claude-settings.json with these hooks and checks it with
// `liaison acpx link --check`; acpx validates the settings a Claude session loads
// against this copy before creating, loading or resuming it, and requires the hooks
// only once the egress cutover is on (isLiaisonEgressCutoverOn). Both sides pin
// CLAUDE_EGRESS_CONTRACT_DIGEST: change them together.
export const CLAUDE_EGRESS_CONTRACT = {
  schema: "liaison-egress-claude-hooks/1",
  topLevelKeys: ["hooks"],
  disablingKeys: ["disableAllHooks"],
  events: {
    PostToolBatch: { script: "egress-cc-post-tool-batch", timeout: 30, onFailure: "continue" },
    PostToolUse: { script: "egress-cc-post-tool-use", timeout: 20, onFailure: "continue" },
    SessionStart: { script: "egress-cc-session-start", timeout: 10, onFailure: "continue" },
  },
} as const;

// SHA-256 of the canonical contract (sorted keys, compact separators, no "doc").
export const CLAUDE_EGRESS_CONTRACT_DIGEST =
  "a9f1cb7e4befe2118b4b48b54d6f9af52e5badf7dbc6bfaedfbf898024e0a8da";

type HookRule = { script: string; timeout: number; onFailure?: string };

// Supported command grammar for an egress hook: the command is exactly the absolute
// path of its script, with no argument, no shell quoting or escaping, and no
// interpreter or environment prefix. A command that names a contract script (the name
// bounded by characters that cannot belong to a file name) in any other form is a
// contract violation, whatever the cutover state.
const NAME_CHAR = /[A-Za-z0-9_.-]/;
const SHELL_SPECIAL = /[\s"'`\\$;&|<>()*?[\]{}]/;

function namesScript(command: string, script: string): boolean {
  for (let at = command.indexOf(script); at >= 0; at = command.indexOf(script, at + 1)) {
    const before = command[at - 1] ?? "";
    const after = command[at + script.length] ?? "";
    if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) {
      return true;
    }
  }
  return false;
}

function isBareScriptCommand(command: string, script: string): boolean {
  return (
    path.isAbsolute(command) && !SHELL_SPECIAL.test(command) && path.basename(command) === script
  );
}

function groupCommands(group: unknown): string[] {
  if (!isRecord(group) || !Array.isArray(group.hooks)) {
    return [];
  }
  return group.hooks.flatMap((hook) =>
    isRecord(hook) && typeof hook.command === "string" ? [hook.command] : [],
  );
}

// Every command hook as [event, command], in any event or group.
function hookCommands(hooks: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(hooks).flatMap(([event, groups]) =>
    Array.isArray(groups)
      ? groups.flatMap(groupCommands).map((command): [string, string] => [event, command])
      : [],
  );
}

// Commands that name a contract script without being its bare absolute path.
function commandGrammarViolations(hooks: Record<string, unknown>): string[] {
  const found = new Set<string>();
  for (const [event, command] of hookCommands(hooks)) {
    for (const rule of Object.values(CLAUDE_EGRESS_CONTRACT.events)) {
      if (namesScript(command, rule.script) && !isBareScriptCommand(command, rule.script)) {
        found.add(
          `${event}: a hook command naming ${rule.script} is not its bare absolute path (no arguments, no shell quoting)`,
        );
      }
    }
  }
  return [...found];
}
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

// The egress hooks are staged until the cutover: Liaison's hook wrapper
// (liaison/egress/hooks/egress-hook) runs them only once it is on, and Liaison renders
// none while it is off. Same resolution as the wrapper, byte for byte:
// LIAISON_EGRESS_CUTOVER=1 is on, =0 is off, any other value leaves it to the marker
// file ${LIAISON_EGRESS_CUTOVER_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/liaison/egress-cutover},
// which counts when it exists.
export const LIAISON_EGRESS_CUTOVER_ENV = "LIAISON_EGRESS_CUTOVER";
export const LIAISON_EGRESS_CUTOVER_FILE_ENV = "LIAISON_EGRESS_CUTOVER_FILE";

export function liaisonEgressCutoverFile(env: NodeJS.ProcessEnv): string {
  const explicit = env[LIAISON_EGRESS_CUTOVER_FILE_ENV];
  if (explicit) {
    return explicit;
  }
  const state = env.XDG_STATE_HOME || `${env.HOME ?? ""}/.local/state`;
  return `${state}/liaison/egress-cutover`;
}

export function isLiaisonEgressCutoverOn(
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean = existsSync,
): boolean {
  const forced = env[LIAISON_EGRESS_CUTOVER_ENV];
  if (forced === "1") {
    return true;
  }
  if (forced === "0") {
    return false;
  }
  return exists(liaisonEgressCutoverFile(env));
}

const CONTRACT_SCRIPTS: ReadonlySet<string> = new Set(
  Object.values(CLAUDE_EGRESS_CONTRACT.events).map((rule) => rule.script),
);

// Whether any command hook, in any event or group, names a contract script, in any
// form (see the command grammar above).
function carriesEgressHook(hooks: Record<string, unknown>): boolean {
  return hookCommands(hooks).some(([, command]) =>
    [...CONTRACT_SCRIPTS].some((script) => namesScript(command, script)),
  );
}

// What a Claude session's settings must satisfy. Cutover on: the whole contract
// (contains mode). Cutover off: no egress hook is required, but a file that carries
// one carries the whole contract (no half-rendered file), and nothing disables hooks.
export function claudeEgressAdmissionViolations(
  settings: unknown,
  cutover: boolean,
  isUsable: CommandCheck = isExecutableFile,
): string[] {
  if (cutover || !isRecord(settings)) {
    return claudeEgressContractViolations(settings, false, isUsable);
  }
  const hooks = settings.hooks;
  if (hooks !== undefined && (!isRecord(hooks) || carriesEgressHook(hooks))) {
    return claudeEgressContractViolations(settings, false, isUsable);
  }
  return claudeDisablingKeys(settings).map((key) => `${key} disables hooks`);
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
  return [
    ...found,
    ...eventViolations(settings.hooks, exact, isUsable),
    ...commandGrammarViolations(settings.hooks),
  ];
}
