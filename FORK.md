# Temporary acpx fork

`@superbiche/acpx@0.17.0-fork.1` is based on upstream acpx 0.17.0
(commit `66208a78c4ea8be87e597013caeb214b15735359`) plus
[PR #618](https://github.com/openclaw/acpx/pull/618), adding the official
Antigravity ACP shortcut and cancelling native user questions before permission
approval can select an answer. The prior fork's
[one-shot configuration](https://github.com/openclaw/acpx/pull/533) and
[prompt metadata](https://github.com/openclaw/acpx/pull/537) changes are already
included in upstream.

## Install and use

```bash
npm install -g @superbiche/acpx@0.17.0-fork.1
acpx --version
```

The package installs the same `acpx` command. Existing acpx configuration and
sessions remain in their normal locations. Agent command overrides still take
precedence over builtins. Embedding imports use this distribution’s package name,
for example `@superbiche/acpx/runtime`. The fork also adjusts the shared runtime’s
CLI self-reference to that scoped name.

Follow [Antigravity setup](agents/Antigravity.md) for the official runtime,
matching helper and isolated personal Google OAuth profile. This package does
not install the runtime, sign in, or supply a subscription-only supervisor.
The operator's existing managed launcher can be kept as the `antigravity`
agent override. Select an exact model advertised by the signed-in account;
no model or billing-provider fallback is provided.

The question guard also applies to existing custom launchers identifying as
`antigravity-acp`: fixed-choice questions stop with an explicit user-answer-required
error, even with approve-all or an embedding permission handler. Ordinary tool
permissions retain their existing behavior. Use an interactive client to answer
these questions.

## Lifecycle

This prerelease is published under the `fork` npm dist-tag and should be installed
with its exact version. Retire it when PR #618 (or equivalent support) ships in
an upstream release, after verifying the fleet's model-selection and resume path.
Do not retire solely because the PR merges. The previous installation can be
restored by pinning `@superbiche/acpx@0.13.2-fork.2`.

The fork uses manual publication of the reviewed package archive. Upstream's
release workflow is unchanged and must not be triggered for this scoped prerelease.
