import fs from "node:fs/promises";
import path from "node:path";
import { CLAUDE_EGRESS_CONTRACT } from "../src/acp/claude-egress-contract.js";

// Claude settings as `liaison egress link` renders ~/.acpx/claude-settings.json:
// the contract's hooks, each command an executable under hookDir.
export function claudeEgressSettings(hookDir: string): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const [event, rule] of Object.entries(CLAUDE_EGRESS_CONTRACT.events)) {
    const hook: Record<string, unknown> = {
      type: "command",
      command: path.join(hookDir, rule.script),
      timeout: rule.timeout,
    };
    if ("onFailure" in rule) {
      hook.onFailure = rule.onFailure;
    }
    hooks[event] = [{ hooks: [hook] }];
  }
  return { hooks };
}

export async function writeClaudeEgressHookStubs(hookDir: string): Promise<void> {
  await fs.mkdir(hookDir, { recursive: true });
  for (const rule of Object.values(CLAUDE_EGRESS_CONTRACT.events)) {
    const stub = path.join(hookDir, rule.script);
    await fs.writeFile(stub, "#!/bin/sh\nexit 0\n");
    await fs.chmod(stub, 0o755);
  }
}

// Writes the hook stubs under <home>/egress-hooks, the settings file acpx requires
// for built-in Claude sessions, and an empty user instructions file (a user without a
// CLAUDE.md: nothing is appended to the system prompt); returns the settings.
export async function writeClaudeEgressSettings(home: string): Promise<Record<string, unknown>> {
  const hookDir = path.join(home, "egress-hooks");
  await writeClaudeEgressHookStubs(hookDir);
  const settings = claudeEgressSettings(hookDir);
  await fs.mkdir(path.join(home, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".acpx", "claude-settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
  await fs.writeFile(path.join(home, ".acpx", "claude-user-instructions.md"), "");
  return settings;
}
