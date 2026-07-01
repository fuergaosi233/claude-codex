# Security Policy

Claude Codex Adapter is a community project. Security reports are handled on a
best-effort basis by the maintainers.

## Reporting a vulnerability

If GitHub private vulnerability reporting is available for this repository, use
that channel for sensitive reports. If private reporting is not available and
the issue does not expose secrets or exploitable details, open a GitHub issue
with a minimal, non-sensitive summary and ask for a private coordination path.

Do not post API keys, OAuth session data, local credential files, private host
names, or reproducible exploit payloads in public issues, pull requests, logs,
or screenshots.

## Secret handling

This project should not contain user credentials. Keep these out of git:

- `ANTHROPIC_API_KEY`, provider API keys, bearer tokens, and OAuth refresh data.
- Claude Code login/session files, including local account state under user
  home directories.
- `.env`, shell history, copied `~/.zshenv` snippets with real values, and
  acceptance-test transcripts that include private paths or tokens.
- Private proxy URLs, internal hostnames, or subscription/account-sharing
  details.

Documentation examples use placeholders such as
`ANTHROPIC_API_KEY="<your-anthropic-api-key>"`. Replace them only in your local
shell or secret manager. Do not commit the resolved values.

## Authentication boundary

The adapter delegates Claude authentication to Claude Code / the Anthropic SDK
environment. Users may authenticate locally with their own API key, OAuth login,
or supported cloud-provider configuration. The adapter should not collect,
persist, print, or redistribute those credentials.

For tests that need real Claude access, run them only in an environment where
the required credentials are already provided by the user. Use
`CLAUDE_CODEX_MOCK=1` for protocol tests that do not require live credentials.
