import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSettingsUnavailableError } from "../errors.js";

// Claude-family sessions run without the user setting source, so Claude Code does
// not load the user CLAUDE.md or the files it imports. The operator's tooling renders
// them, flattened, to ~/.acpx/claude-user-instructions.md (Liaison: `liaison acpx
// link`), and acpx appends that text to the session system prompt on creation, load
// and resume. Like the settings file it is required: those instructions carry the
// operator's safety and approval rules, so a missing or unreadable file refuses the
// session before any request. An empty (or whitespace-only) file is valid, for a user
// without a CLAUDE.md, and appends nothing.

export function claudeUserInstructionsPath(home: string = os.homedir()): string {
  return path.join(home, ".acpx", "claude-user-instructions.md");
}

// The instructions to append, without trailing whitespace; undefined when the file is
// empty. Refuses when the file is missing or unreadable.
export function loadClaudeUserInstructions(home: string = os.homedir()): string | undefined {
  const file = claudeUserInstructionsPath(home);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new ClaudeSettingsUnavailableError(
      `Claude user instructions file is missing or unreadable: ${file}. Claude-family sessions require it; render it with \`liaison acpx link --install\`; refusing to start the session.`,
      { cause: error },
    );
  }
  const trimmed = text.trimEnd();
  return trimmed.trim().length > 0 ? trimmed : undefined;
}
