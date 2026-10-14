import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSettingsUnavailableError, CopilotAcpUnsupportedError } from "../errors.js";
import { readWindowsEnvValue, resolveWindowsExecutablePath } from "../spawn-command-options.js";
import { type AcpClientOptions } from "../types.js";
import {
  claudeEgressContractViolations,
  type CommandCheck,
  isExecutableFile,
} from "./claude-egress-contract.js";
import { basenameToken, splitCommandLine } from "./client-process.js";

const DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS = 100;
const QODER_AGENT_CLOSE_AFTER_STDIN_END_MS = 750;
const GEMINI_ACP_STARTUP_TIMEOUT_MS = 15_000;
const CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = 60_000;
const GEMINI_VERSION_TIMEOUT_MS = 2_000;
const GEMINI_ACP_FLAG_VERSION = [0, 33, 0] as const;
const COPILOT_HELP_TIMEOUT_MS = 2_000;
const CLAUDE_CODE_DEFAULT_SETTING_SOURCES = ["project", "local"] as const;

type AgentCommandContext = {
  env: NodeJS.ProcessEnv;
  readOutput: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
    diagnostic?: boolean,
  ) => Promise<string | undefined>;
};

type GeminiVersion = {
  raw: string;
  parts: [number, number, number];
};

const QODER_BENIGN_STDOUT_LINES = new Set([
  "Received interrupt signal. Cleaning up resources...",
  "Cleanup completed. Exiting...",
]);

export function resolveAgentCloseAfterStdinEndMs(agentCommand: string): number {
  const { command } = splitCommandLine(agentCommand);
  return basenameToken(command) === "qodercli"
    ? QODER_AGENT_CLOSE_AFTER_STDIN_END_MS
    : DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS;
}

export function shouldIgnoreNonJsonAgentOutputLine(
  agentCommand: string,
  trimmedLine: string,
): boolean {
  const { command } = splitCommandLine(agentCommand);
  return basenameToken(command) === "qodercli" && QODER_BENIGN_STDOUT_LINES.has(trimmedLine);
}

export function isGeminiAcpCommand(command: string, args: readonly string[]): boolean {
  return (
    basenameToken(command) === "gemini" &&
    (args.includes("--acp") || args.includes("--experimental-acp"))
  );
}

export function isClaudeAcpCommand(command: string, args: readonly string[]): boolean {
  const commandToken = basenameToken(command);
  if (commandToken === "claude-agent-acp") {
    return true;
  }
  return args.some((arg) => arg.includes("claude-agent-acp"));
}

// Package names the Claude Code ACP adapter reports in its initialize agentInfo,
// current and former (@zed-industries/claude-code-acp).
const CLAUDE_ADAPTER_NAMES = ["claude-agent-acp", "claude-code-acp"] as const;

export function isClaudeAgentInfoName(name: unknown): boolean {
  return typeof name === "string" && CLAUDE_ADAPTER_NAMES.some((adapter) => name.includes(adapter));
}

// Executables the global acpx config declares as Claude family
// (`agents.<name>.family: "claude"`), for wrappers whose name says nothing.
export function declaredClaudeFamilyExecutables(home: string = os.homedir()): Set<string> {
  const executables = new Set<string>();
  for (const entry of readGlobalConfigAgents(home)) {
    const executable = entry.family === "claude" ? agentEntryExecutable(entry) : undefined;
    if (executable) {
      executables.add(executable);
    }
  }
  return executables;
}

function readGlobalConfigAgents(home: string): Record<string, unknown>[] {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path.join(home, ".acpx", "config.json"), "utf8"));
  } catch {
    return []; // absent or invalid: the config loader reports it
  }
  const agents = isPlainObject(config) ? config.agents : undefined;
  return isPlainObject(agents) ? Object.values(agents).filter(isPlainObject) : [];
}

function agentEntryExecutable(entry: Record<string, unknown>): string | undefined {
  const argv: unknown = entry.argv;
  const executable: unknown = Array.isArray(argv)
    ? argv[0]
    : typeof entry.command === "string"
      ? splitCommandLine(entry.command.trim()).command
      : undefined;
  return typeof executable === "string" && executable.length > 0 ? executable : undefined;
}

export type ClaudeFamilyEvidence = {
  command: string;
  args: readonly string[];
  agentInfoName?: unknown;
  home?: string;
};

// Claude family: the Claude Code ACP adapter however it is launched. Any one
// signal suffices: the adapter's own initialize identity, a declaration in the
// global acpx config, or the adapter's command name.
export function isClaudeFamilyAgent(evidence: ClaudeFamilyEvidence): boolean {
  return (
    isClaudeAgentInfoName(evidence.agentInfoName) ||
    declaredClaudeFamilyExecutables(evidence.home).has(evidence.command) ||
    isClaudeAcpCommand(evidence.command, evidence.args)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCopilotAcpCommand(command: string, args: readonly string[]): boolean {
  return basenameToken(command) === "copilot" && args.includes("--acp");
}

export function isQoderAcpCommand(command: string, args: readonly string[]): boolean {
  return basenameToken(command) === "qodercli" && args.includes("--acp");
}

export function isCursorAcpCommand(command: string, args: readonly string[]): boolean {
  const commandToken = basenameToken(command);
  return commandToken === "cursor-agent" || (commandToken === "agent" && args.includes("acp"));
}

export function isDevinAcpCommand(command: string, args: readonly string[]): boolean {
  return (
    basenameToken(command) === "devin" &&
    (args.includes("acp") || args.includes("--acp") || args.includes("--experimental-acp"))
  );
}

function hasCommandFlag(args: readonly string[], flagName: string): boolean {
  return args.some((arg) => arg === flagName || arg.startsWith(`${flagName}=`));
}

function normalizeQoderAllowedToolName(tool: string): string {
  switch (tool.trim().toLowerCase()) {
    case "bash":
    case "glob":
    case "grep":
    case "ls":
    case "read":
    case "write":
      return tool.trim().toUpperCase();
    default:
      return tool.trim();
  }
}

export function buildQoderAcpCommandArgs(
  initialArgs: readonly string[],
  options: Pick<AcpClientOptions, "sessionOptions">,
): string[] {
  const args = [...initialArgs];
  const sessionOptions = options.sessionOptions;

  if (typeof sessionOptions?.maxTurns === "number" && !hasCommandFlag(args, "--max-turns")) {
    args.push(`--max-turns=${sessionOptions.maxTurns}`);
  }

  if (
    Array.isArray(sessionOptions?.allowedTools) &&
    !hasCommandFlag(args, "--allowed-tools") &&
    !hasCommandFlag(args, "--disallowed-tools")
  ) {
    const encodedTools = sessionOptions.allowedTools.map(normalizeQoderAllowedToolName).join(",");
    args.push(`--allowed-tools=${encodedTools}`);
  }

  return args;
}

export function resolveGeminiAcpStartupTimeoutMs(): number {
  const raw = process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return GEMINI_ACP_STARTUP_TIMEOUT_MS;
}

export function resolveClaudeAcpSessionCreateTimeoutMs(): number {
  const raw = process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
}

function parseGeminiVersion(value: string | undefined): GeminiVersion | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  const match = normalized.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return undefined;
  }

  return {
    raw: normalized,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}

function compareVersionParts(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
}

async function detectGeminiVersion(
  command: string,
  context: AgentCommandContext,
  diagnostic = false,
): Promise<GeminiVersion | undefined> {
  const output = await context.readOutput(
    command,
    ["--version"],
    GEMINI_VERSION_TIMEOUT_MS,
    diagnostic,
  );
  const versionLine = output
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\d+\.\d+\.\d+/.test(line));
  return parseGeminiVersion(versionLine);
}

export async function resolveGeminiCommandArgs(
  command: string,
  args: readonly string[],
  context: AgentCommandContext,
): Promise<string[]> {
  if (basenameToken(command) !== "gemini" || !args.includes("--acp")) {
    return [...args];
  }

  const version = await detectGeminiVersion(command, context);
  if (version && compareVersionParts(version.parts, GEMINI_ACP_FLAG_VERSION) < 0) {
    return args.map((arg) => (arg === "--acp" ? "--experimental-acp" : arg));
  }

  return [...args];
}

export async function buildGeminiAcpStartupTimeoutMessage(
  command: string,
  context: AgentCommandContext,
): Promise<string> {
  const parts = [
    "Gemini CLI ACP startup timed out before initialize completed.",
    "This usually means the local Gemini CLI is waiting on interactive OAuth or has incompatible ACP subprocess behavior.",
  ];

  const version = await detectGeminiVersion(command, context, true);
  if (version) {
    parts.push(`Detected Gemini CLI version: ${version.raw}.`);
  }

  const env = context.env;
  if (!env.GEMINI_API_KEY && !env.GOOGLE_API_KEY) {
    parts.push("No GEMINI_API_KEY or GOOGLE_API_KEY was set for non-interactive auth.");
  }

  parts.push("Try upgrading Gemini CLI and using API-key-based auth for non-interactive ACP runs.");
  return parts.join(" ");
}

export function buildClaudeAcpSessionCreateTimeoutMessage(): string {
  return [
    "Claude ACP session creation timed out before session/new completed.",
    "This matches the known persistent-session stall seen with some Claude Code and @agentclientprotocol/claude-agent-acp combinations.",
    "In harnessed or non-interactive runs, prefer --approve-all with nonInteractivePermissions=deny, upgrade Claude Code and the Claude ACP adapter, or use acpx claude exec as a one-shot fallback.",
  ].join(" ");
}

function buildCopilotAcpUnsupportedMessage(): string {
  return [
    "GitHub Copilot CLI ACP stdio mode is not available in the installed copilot binary.",
    "acpx copilot expects a Copilot CLI release that supports --acp --stdio.",
    "Detected copilot --help output without --acp support.",
    "Upgrade GitHub Copilot CLI to a release with ACP stdio support, or use --agent with another ACP-compatible adapter in the meantime.",
  ].join(" ");
}

export async function ensureCopilotAcpSupport(
  command: string,
  context: AgentCommandContext,
): Promise<void> {
  const helpOutput = await context.readOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
  if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) {
    throw new CopilotAcpUnsupportedError(buildCopilotAcpUnsupportedMessage(), {
      retryable: false,
    });
  }
}

// Where a Claude session's settings come from. Defaults: the process environment,
// the user's home, no project directory.
export type ClaudeSettingsContext = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  isUsable?: CommandCheck;
};

export function buildClaudeCodeOptionsMeta(
  options: AcpClientOptions["sessionOptions"],
  isolateUserSettings = false,
  context: ClaudeSettingsContext = {},
): Record<string, unknown> | undefined {
  const claudeCodeOptions: Record<string, unknown> = {};
  if (isolateUserSettings) {
    assignClaudeCodeSettingIsolation(claudeCodeOptions, context);
  }
  if (options) {
    assignClaudeCodeOptions(claudeCodeOptions, options);
  }

  const meta: Record<string, unknown> = {};
  if (Object.keys(claudeCodeOptions).length > 0) {
    meta.claudeCode = { options: claudeCodeOptions };
  }

  assignClaudeCodeSystemPrompt(meta, options?.systemPrompt);

  if (Object.keys(meta).length === 0) {
    return undefined;
  }

  return meta;
}

// Every Claude-family session runs with one settings file, ~/.acpx/claude-settings.json,
// which carries the egress hooks of the declared contract
// (src/acp/claude-egress-contract.ts). Any failure refuses the session before a
// request is sent.
//
// The acpx permission policy decides every tool call Claude Code would ask about:
// - the managed tier makes Claude Code ignore allow rules from every other source
//   (the settings file, allowedTools); deny and ask rules move into it so they keep
//   applying. Bypass mode is never offered.
// - nothing the repository carries is executed or trusted: Claude Code reads project
//   configuration (.claude settings, hooks, skills, agents, commands, .mcp.json) from
//   an empty acpx-owned directory instead of the session directory. CLAUDE.md,
//   AGENTS.md imports and .claude/rules still load from the session directory.
//   Hooks see that directory as CLAUDE_PROJECT_DIR; the real one is in
//   ACPX_CLAUDE_PROJECT_DIR.
function assignClaudeCodeSettingIsolation(
  target: Record<string, unknown>,
  context: ClaudeSettingsContext,
): void {
  const env = context.env ?? process.env;
  assertClaudeIsolationNotEscaped(env);
  target.settingSources = resolveClaudeCodeSettingSources(env);
  const settings = loadClaudeCodeSettingsFile(
    claudeCodeSettingsFilePath(context.home),
    context.isUsable,
  );
  target.settings = settings;
  target.managedSettings = claudeManagedPermissionSettings(settings);
  target.allowDangerouslySkipPermissions = false;
  target.projectConfigRoot = ensureClaudeProjectConfigRoot(context.home);
  if (context.cwd) {
    target.env = { [CLAUDE_PROJECT_DIR_ENV]: context.cwd };
  }
}

export const CLAUDE_PROJECT_DIR_ENV = "ACPX_CLAUDE_PROJECT_DIR";

const LIFTED_PERMISSION_RULES = ["deny", "ask"] as const;

function claudeManagedPermissionSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const permissions = isPlainObject(settings.permissions) ? settings.permissions : {};
  const lifted: Record<string, string[]> = {};
  for (const key of LIFTED_PERMISSION_RULES) {
    const rules = permissions[key];
    if (rules === undefined) {
      continue;
    }
    if (!Array.isArray(rules) || !rules.every((rule) => typeof rule === "string")) {
      throw refuse(`Claude settings permissions.${key} is not a list of rules`);
    }
    lifted[key] = [...rules];
  }
  return { allowManagedPermissionRulesOnly: true, permissions: lifted };
}

export function claudeCodeSettingsFilePath(home: string = os.homedir()): string {
  return path.join(home, ".acpx", "claude-settings.json");
}

export function claudeProjectConfigRootPath(home: string = os.homedir()): string {
  return path.join(home, ".acpx", "claude-project-config");
}

// Created on first use; anything placed in it would be loaded as project
// configuration by every Claude session, so it must stay an empty real directory.
export function ensureClaudeProjectConfigRoot(home: string = os.homedir()): string {
  const dir = claudeProjectConfigRootPath(home);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw refuse(`Claude project configuration directory cannot be created: ${dir}`, error);
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw refuse(`Claude project configuration directory is not a real directory: ${dir}`);
  }
  const entries = readdirSync(dir);
  if (entries.length > 0) {
    throw refuse(
      `Claude project configuration directory must be empty, found ${entries.toSorted().join(", ")}: ${dir}`,
    );
  }
  return dir;
}

// Launch-environment switches that stop Claude Code from running settings-file
// hooks (and with them the egress hooks), or that bring back the user settings.
const CLAUDE_HOOK_SURFACE_SWITCHES = ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE"] as const;
const CLAUDE_INCLUDE_USER_SETTINGS_ENV = "ACPX_CLAUDE_INCLUDE_USER_SETTINGS";

function isSwitchSet(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && normalized !== "0" && normalized !== "false";
}

function assertClaudeIsolationNotEscaped(env: NodeJS.ProcessEnv): void {
  if (isSwitchSet(env[CLAUDE_INCLUDE_USER_SETTINGS_ENV])) {
    throw refuse(
      `${CLAUDE_INCLUDE_USER_SETTINGS_ENV} is set; Claude-family sessions run only with ~/.acpx/claude-settings.json (render it with \`liaison acpx link --install\`), never with the user settings`,
    );
  }
  const switches = CLAUDE_HOOK_SURFACE_SWITCHES.filter((name) => isSwitchSet(env[name]));
  if (switches.length > 0) {
    throw refuse(
      `${switches.join(", ")} set in the agent environment turns the Claude Code settings hooks off, including the required egress hooks`,
    );
  }
}

function refuse(message: string, cause?: unknown): ClaudeSettingsUnavailableError {
  return new ClaudeSettingsUnavailableError(`${message}; refusing to start the session.`, {
    cause,
  });
}

function readSettingsJson(filePath: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw refuse(`${label} is missing or unreadable: ${filePath}`, error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw refuse(`${label} is not valid JSON: ${filePath}`, error);
  }
}

// Keys a Claude settings file for acpx must not carry: they would let Claude Code
// approve tool calls the acpx permission policy has not seen.
const CLAUDE_SETTINGS_FILE_FORBIDDEN = ["permissions.allow", "permissions.defaultMode"] as const;

function forbiddenClaudeSettings(settings: Record<string, unknown>): string[] {
  const permissions = isPlainObject(settings.permissions) ? settings.permissions : {};
  const forbidden: string[] = CLAUDE_SETTINGS_FILE_FORBIDDEN.filter(
    (key) => permissions[key.slice("permissions.".length)] !== undefined,
  );
  const env = isPlainObject(settings.env) ? settings.env : {};
  for (const name of [...CLAUDE_HOOK_SURFACE_SWITCHES, CLAUDE_INCLUDE_USER_SETTINGS_ENV]) {
    if (env[name] !== undefined) {
      forbidden.push(`env.${name}`);
    }
  }
  return forbidden;
}

// Fail closed: a missing, unreadable or invalid file, one without the egress hook
// contract (among its other settings) or one that carries allow rules, a default
// permission mode or a hook-disabling environment switch refuses the session.
export function loadClaudeCodeSettingsFile(
  filePath: string = claudeCodeSettingsFilePath(),
  isUsable: CommandCheck = isExecutableFile,
): Record<string, unknown> {
  const parsed = readSettingsJson(filePath, "Claude settings file");
  const problems = claudeEgressContractViolations(parsed, false, isUsable);
  if (problems.length > 0) {
    throw refuse(
      `Claude settings file does not carry the egress hook contract: ${filePath}: ${problems.join("; ")}. Claude-family sessions require it; render it with \`liaison acpx link --install\``,
    );
  }
  const settings = parsed as Record<string, unknown>;
  const forbidden = forbiddenClaudeSettings(settings);
  if (forbidden.length > 0) {
    throw refuse(
      `Claude settings file sets ${forbidden.join(", ")}, which would let tool calls or hooks escape the acpx permission policy: ${filePath}`,
    );
  }
  return settings;
}

export function resolveClaudeCodeSettingSources(env: NodeJS.ProcessEnv = process.env): string[] {
  assertClaudeIsolationNotEscaped(env);
  return [...CLAUDE_CODE_DEFAULT_SETTING_SOURCES];
}

function assignClaudeCodeOptions(
  target: Record<string, unknown>,
  options: NonNullable<AcpClientOptions["sessionOptions"]>,
): void {
  if (typeof options.model === "string" && options.model.trim().length > 0) {
    target.model = options.model;
  }
  if (Array.isArray(options.allowedTools)) {
    target.allowedTools = [...options.allowedTools];
  }
  if (typeof options.maxTurns === "number") {
    target.maxTurns = options.maxTurns;
  }
}

function assignClaudeCodeSystemPrompt(
  target: Record<string, unknown>,
  systemPrompt: NonNullable<AcpClientOptions["sessionOptions"]>["systemPrompt"] | undefined,
): void {
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    target.systemPrompt = systemPrompt;
    return;
  }
  if (isAppendSystemPrompt(systemPrompt)) {
    target.systemPrompt = { append: systemPrompt.append };
  }
}

function isAppendSystemPrompt(
  value: NonNullable<AcpClientOptions["sessionOptions"]>["systemPrompt"],
): value is { append: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.append === "string" &&
    value.append.length > 0
  );
}

export function resolveClaudeCodeExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): string | undefined {
  if (platform !== "win32") {
    return undefined;
  }
  if (readWindowsEnvValue(env, "CLAUDE_CODE_EXECUTABLE")) {
    return undefined;
  }
  return resolveWindowsExecutablePath("claude", env, cwd);
}
