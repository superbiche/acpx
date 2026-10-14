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
`permissions.defaultMode`, or in `env` any of the switches below or
`ACPX_CLAUDE_PROJECT_DIR`. When it is missing, unreadable, not valid JSON, lacks
a contract hook, or sets one of those keys, acpx refuses to create, load, or
resume the session and sends no session request. acpx also refuses when the
agent's environment sets `ACPX_CLAUDE_INCLUDE_USER_SETTINGS`, or
`CLAUDE_CODE_SIMPLE` or `CLAUDE_CODE_SAFE_MODE` (both stop Claude Code from
running settings hooks).

A launcher (a wrapper script, or `CLAUDE_CODE_*` variables inherited by the
adapter) can set variables acpx never sees. acpx therefore sets them in the
Claude Code process environment itself, through the session options' `env`,
which the adapter applies over its own environment: `CLAUDE_CODE_SIMPLE=0`,
`CLAUDE_CODE_SAFE_MODE=0` (either would turn settings hooks off),
`CLAUDE_CODE_SHELL_PREFIX=` (empty: it would run every hook command through a
program of its choice), `CLAUDE_CODE_PLUGIN_DIRS=` (empty: it would load
plugins, with their hooks, that acpx has not checked), and
`CLAUDE_CODE_DISABLE_CLAUDE_MDS=0` (it would drop the project instructions).
The launcher itself stays trusted: one that replaces the adapter or the Claude
Code executable (`CLAUDE_CODE_EXECUTABLE`) runs whatever it starts.

Nothing the session directory carries is executed or trusted. Claude Code reads
project configuration (`.claude/settings.json`, `.claude/settings.local.json`,
their hooks and permission rules, `.claude` skills, agents and commands, and
`.mcp.json`) from `~/.acpx/claude-project-config`, an empty directory acpx
creates and refuses to use when it is not empty or not a real directory.
`CLAUDE.md`, its imports (such as `@AGENTS.md`) and `.claude/rules` still load
from the session directory. Settings hooks start in the empty directory and see
it as `CLAUDE_PROJECT_DIR`; acpx passes the session directory as
`ACPX_CLAUDE_PROJECT_DIR`. The hooks Liaison renders run through a launcher that
enters that directory and sets `CLAUDE_PROJECT_DIR` to it, and refuses to run
the hook (exit 2) when it is unset, relative or missing.

The operator's own skills and agents reach Claude-family sessions as one local
plugin, `~/.acpx/claude-user-plugin` (Liaison renders it: one symlink per skill
directory, a copy of each agent file; Claude Code lists them as `user:<name>`).
acpx loads it when it exists, with MCP discovery off, and refuses the session
when the plugin itself is a symlink or holds anything but a
`.claude-plugin/plugin.json` manifest (name, description, version) and
`skills/` and `agents/`. This structure is checked again at every session start.

Skills and agents are delivered unfiltered: acpx does not read their
frontmatter. A skill's `allowed-tools`, a skill's or agent's `hooks`, and an
agent's `permissionMode` are passed to Claude Code as written, and Claude Code
can use them to pre-approve tool calls without sending acpx a permission
request. That pre-approval is Claude Code behavior, tracked upstream.
`liaison acpx link --check` reports skills and agents whose frontmatter appears
to declare one of these keys. The report is an advisory text match: it can miss
unusual YAML forms (escaped, flow-style or explicit keys) and flag text that is
not a grant, so zero findings is not proof that no delivered skill or agent
declares one.

What a Claude-family session loads, and what it does not:

| Surface                                                                                                                                                                 | Loaded                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Session directory `CLAUDE.md`, its imports, `.claude/rules`                                                                                                             | yes                                                                                    |
| `~/.acpx/claude-settings.json` (derived settings: egress, guard and memory hooks, deny and ask rules)                                                                   | yes                                                                                    |
| User skills and agents (`~/.claude/skills`, `~/.claude/agents`)                                                                                                         | yes, through the user plugin, as `user:<name>`, unfiltered (grant keys included)       |
| Built-in skills and agents of Claude Code                                                                                                                               | yes                                                                                    |
| User `CLAUDE.md` (`~/.claude/CLAUDE.md`) and its imports                                                                                                                | no                                                                                     |
| User settings and everything else Claude Code reads from `~/.claude` through the user setting source (commands, output styles, rules), user-enabled marketplace plugins | no                                                                                     |
| `skillOverrides` and other skill-listing settings                                                                                                                       | no effect: Claude Code reads them only from the user, project and local settings files |
| Repository `.claude` settings, hooks, permission rules, skills, agents, commands, `.mcp.json`                                                                           | no                                                                                     |
| Plugins named by `CLAUDE_CODE_PLUGIN_DIRS`                                                                                                                              | no                                                                                     |

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
managed settings exist on the machine. Tool calls pre-approved by a delivered
skill's or agent's grant keys (see the user plugin above) do not reach acpx.

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
