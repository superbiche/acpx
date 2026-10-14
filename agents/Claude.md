# Claude

- Built-in name: `claude`
- Default command: `npx -y @agentclientprotocol/claude-agent-acp`
- Upstream: https://github.com/agentclientprotocol/claude-agent-acp
- ACPX pins the built-in package range so fresh installs pick up Claude model and ACP adapter fixes without depending on a global adapter binary.
- Update ACPX to pick up changes to the supported adapter range in `src/agent-registry.ts`.
- Sessions saved under an earlier ACPX-owned adapter range stay in the `claude` scope after an upgrade and resume on the current adapter. Records saved with a custom launcher keep it.
- Model switches can change the available effort controls. ACPX updates existing saved effort selections from the accepted response and removes selections whose controls disappear.
- Saved model and config selections are restored after reconnect, without replacing the conversation.

## Settings isolation

These rules apply to every Claude-family session: the Claude Code ACP adapter
however it is launched. acpx recognises it by the adapter's `initialize`
identity (`agentInfo.name` containing `claude-agent-acp` or `claude-code-acp`),
by a global config declaration (`agents.<name>.family: "claude"` in
`~/.acpx/config.json`, for wrapper scripts), or by the adapter's command name.
The same isolation and saved session options apply on creation, load, and
resume.

Claude-family sessions never load the user settings. They pass
`~/.acpx/claude-settings.json` to Claude Code as flag settings;
`liaison acpx link --install` renders it from the user settings. The file must
carry the egress hooks of Liaison's declared hook contract (vendored in
`src/acp/claude-egress-contract.ts`: five events, each with its script, timeout
and failure policy, every command an absolute path to an executable file) among
its other settings, and must not set `permissions.allow`,
`permissions.defaultMode` or a hook-disabling environment switch in `env`. When
it is missing, unreadable, not valid JSON, lacks a contract hook, or sets one of
those keys, acpx refuses to create, load, or resume the session and sends no
session request. acpx also refuses when the agent's environment sets
`ACPX_CLAUDE_INCLUDE_USER_SETTINGS`, or `CLAUDE_CODE_SIMPLE` or
`CLAUDE_CODE_SAFE_MODE` (both stop Claude Code from running settings hooks).

Nothing the session directory carries is executed or trusted. Claude Code reads
project configuration (`.claude/settings.json`, `.claude/settings.local.json`,
their hooks and permission rules, `.claude` skills, agents and commands, and
`.mcp.json`) from `~/.acpx/claude-project-config`, an empty directory acpx
creates and refuses to use when it is not empty or not a real directory.
`CLAUDE.md`, its imports (such as `@AGENTS.md`) and `.claude/rules` still load
from the session directory. Hooks see the empty directory as
`CLAUDE_PROJECT_DIR`; the session directory is in `ACPX_CLAUDE_PROJECT_DIR`.

The acpx permission policy (`--approve-all`, `--approve-reads`, `--deny-all`,
`--permission-policy`) decides every tool call Claude Code would ask about:

- acpx passes Claude Code a managed permission tier with
  `allowManagedPermissionRulesOnly`, so allow rules from the settings file and
  from `--allowed-tools` approve nothing; the deny and ask rules of the settings
  file move into that tier and keep applying. Bypass mode is never offered.
- A Claude-family session stays in the `default` permission mode, or `plan`.
  A session the adapter reports in another mode (it reads the user's
  `permissions.defaultMode` itself) is put back in `default` with
  `session/set_mode` before use, or refused. `set-mode`, `set mode`,
  `--config-option mode=...`, saved selections replayed on reconnect and queue
  owner controls cannot select another mode. When the agent switches itself to
  another mode during a turn, acpx cancels the turn and the prompt fails.
- acpx never answers a permission request with an "allow always" option when a
  one-time approval is offered, so no answer persists a rule or leaves plan mode
  for an auto-approving mode.

Claude Code ignores a parent-supplied managed tier when an administrator's
managed settings exist on the machine.

On Windows, native Claude executable discovery resolves relative `PATH` entries
from the selected session cwd. An explicit `CLAUDE_CODE_EXECUTABLE` still takes
precedence.

## System prompt overrides

Choose the system prompt when creating a named session, then select that session for later prompts:

```bash
acpx --system-prompt "You are a code reviewer who challenges every implicit assumption." \
  claude sessions new --name review
acpx claude -s review 'review the current diff'
```

Use `--append-system-prompt` instead to append instructions to Claude's default system prompt. The override is saved with the session. `-s` selects an existing session; running `sessions new` again in the same scope closes the prior local record and creates a fresh session.

Both system-prompt flags also apply to `flow run`, including persistent and isolated ACP nodes using Claude.

Embedded callers can supply raw nonempty replacement or append text through `SessionAgentOptions.systemPrompt`. ACPX preserves that text exactly in saved options and `session/new`, `session/load`, and `session/resume` metadata, including whitespace-only text. CLI prompt flags trim surrounding whitespace and reject whitespace-only values.

## Embedded inspection

Embedded inspection resolves the installed `claude-agent-acp` adapter or its installed `@agentclientprotocol/claude-agent-acp` package. Configure the adapter’s authentication before acquiring a model catalog or starting a session.

Inspection performs filesystem lookup only. See [embedded agent discovery](../docs/session-control.md#embedded-agent-discovery) for the registry contract and session lifecycle.
