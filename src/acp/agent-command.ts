import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSettingsUnavailableError, CopilotAcpUnsupportedError } from "../errors.js";
import { readWindowsEnvValue, resolveWindowsExecutablePath } from "../spawn-command-options.js";
import { type AcpClientOptions } from "../types.js";
import {
  claudeDisablingKeys,
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

// Every built-in Claude session must run the egress hooks of the declared contract
// (src/acp/claude-egress-contract.ts). Isolated sessions get them from a dedicated
// file, never from the user settings; sessions that include user settings must find
// them there. No loaded settings source may disable hooks. Any failure refuses the
// session before a request is sent.
function assignClaudeCodeSettingIsolation(
  target: Record<string, unknown>,
  context: ClaudeSettingsContext,
): void {
  const settingSources = resolveClaudeCodeSettingSources(context.env);
  target.settingSources = settingSources;
  if (settingSources.includes("user")) {
    requireClaudeUserSettingsHooks(context);
  } else {
    target.settings = loadClaudeCodeSettingsFile(
      claudeCodeSettingsFilePath(context.home),
      context.isUsable,
    );
  }
  assertClaudeHooksNotDisabled(claudeOtherSettingsFiles(context));
}

export function claudeCodeSettingsFilePath(home: string = os.homedir()): string {
  return path.join(home, ".acpx", "claude-settings.json");
}

export function claudeUserSettingsFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDir ? configDir : path.join(home, ".claude"), "settings.json");
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

// Fail closed: a missing, unreadable or invalid file, or one that does not hold
// exactly the egress hook contract with usable commands, refuses the session.
export function loadClaudeCodeSettingsFile(
  filePath: string = claudeCodeSettingsFilePath(),
  isUsable: CommandCheck = isExecutableFile,
): Record<string, unknown> {
  const parsed = readSettingsJson(filePath, "Claude settings file");
  const problems = claudeEgressContractViolations(parsed, true, isUsable);
  if (problems.length > 0) {
    throw refuse(
      `Claude settings file does not hold the egress hook contract: ${filePath}: ${problems.join("; ")}. Built-in claude sessions without user settings require it; render it with \`liaison egress link --apply\``,
    );
  }
  return parsed as Record<string, unknown>;
}

function requireClaudeUserSettingsHooks(context: ClaudeSettingsContext): void {
  const filePath = claudeUserSettingsFilePath(context.env, context.home);
  const label = "Claude user settings (ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1)";
  const problems = claudeEgressContractViolations(
    readSettingsJson(filePath, label),
    false,
    context.isUsable,
  );
  if (problems.length > 0) {
    throw refuse(
      `${label} do not carry the egress hook contract: ${filePath}: ${problems.join("; ")}`,
    );
  }
}

// Project and local settings also load; either may disable hooks.
function claudeOtherSettingsFiles(context: ClaudeSettingsContext): string[] {
  if (!context.cwd) {
    return [];
  }
  return [
    path.join(context.cwd, ".claude", "settings.json"),
    path.join(context.cwd, ".claude", "settings.local.json"),
  ];
}

function readOptionalSettings(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined; // absent or invalid: Claude Code does not apply it either
  }
}

function assertClaudeHooksNotDisabled(files: string[]): void {
  for (const filePath of files) {
    const settings = readOptionalSettings(filePath);
    const disabling = settings ? claudeDisablingKeys(settings) : [];
    if (disabling.length > 0) {
      throw refuse(
        `${filePath} sets ${disabling.join(", ")}, which turns the required egress hooks off`,
      );
    }
  }
}

export function resolveClaudeCodeSettingSources(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS?.trim() === "1") {
    return ["user", ...CLAUDE_CODE_DEFAULT_SETTING_SOURCES];
  }
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
