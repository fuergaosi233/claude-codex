# Changelog

All notable public-facing changes for Claude Codex Adapter are summarized here.
The project is still private in `package.json`; this file tracks release notes
for maintainers preparing the next public release and does not change package
versioning or publishing metadata.

## Unreleased

### App-server and protocol compatibility

- The model picker reads the Codex model catalog from `CODEX_HOME` instead of
  `~/.codex`, so an App with its own home lists its catalog rather than the
  built-in fallback models.
- Updated the adapter to advertise Codex app-server protocol v2 compatibility at
  the current pinned Codex CLI compatibility version, while keeping a
  `claude-codex` suffix so hosts can distinguish the adapter from upstream
  Codex.
- Expanded Codex App Remote coverage across thread lifecycle, turn envelopes,
  item streaming, approvals, MCP status, fuzzy file search sessions, Claude
  skills/hooks, and `thread/turns/list` item views.
- A turn still finishing when the adapter stops (waiting on its final
  `git diff`, an approval or the runtime) no longer writes to the closed
  SQLite store, which crashed the process on the way out.
- When the adapter cannot record the turns it interrupts on shutdown (its
  database was deleted, for example), it still stops Claude and exits with
  status 1 instead of staying alive.
- A turn, review or compaction requested just before the adapter stops no
  longer starts afterwards: it launched Claude after the runtime had stopped,
  and a compaction crashed writing to the closed store.
- Added protocol fixture coverage for `config/read`, including the sanitized
  `config.provider_loop_config` shape, so the Rust fixture drift gate covers
  provider-loop config projection behavior.
- Kept compatibility-only account, plugin, marketplace, realtime, and other
  OpenAI-specific surfaces inert or schema-shaped where Claude Code has no
  equivalent.
- Goals, steer and the message queue follow the Codex App: `thread/goal/*`
  with continuation turns, token and time budgets and goal tools for Claude;
  steer errors in Codex's wording; `thread/queue/*`; and a `turn/start` that
  races a running turn joins it instead of orphaning it.
- The context gauge follows the main loop's latest API call, like Codex's
  `last_token_usage`, and tokens spent by subagents and workflows count toward
  the thread total without moving the gauge or goal progress.
- A turn that ends early completes the message still streaming and fails the
  tool calls still running before `turn/completed`, instead of leaving them
  in progress in the App.
- The adapter stops Claude CLI processes a previous adapter on the same state
  dir left running, matching pid, start time and command line before
  signalling (`CLAUDE_CODEX_REAP_ORPHANED_CLI=0` turns it off).
- The App's "/" popup offers Claude Code's built-in skills (`/simplify`,
  `/code-review`, …) from the list the CLI reports, and a picked one runs as
  the CLI's slash command.
- Every client request the Codex App can send now has a handler. New real
  ones: `project/*`, `thread/delete` (with its subagents), `thread/rollback`
  and `thread/revert` that also rewind Claude's session, `thread/search` and
  `thread/searchOccurrences`, item and timeline paging, `thread/attachment/*`,
  background shell listing and termination, `turn/settings/update`,
  `account/usage/read` from local history, import history, and server
  diagnostics. Remote control and passkey verification answer disabled and
  unavailable instead of failing.
- Fixed `thread/turns/list` paging and ordering, and `thread/list` /
  `thread/search` pages that skipped threads updated in the same second as the
  last one shown.

### Provider and multi-agent boundaries

- `/workflows` runs turn workflows on with the CLI's `CLAUDE_CODE_WORKFLOWS`
  switch instead of `--settings`, which pinned launchers reject, and respect a
  user's `enableWorkflows: false`.
- Added the provider and multi-agent loop boundaries RFC to separate runtime
  backends, provider metadata, agent-loop fidelity, credential ownership, and
  subscription/entitlement boundaries.
- Added static provider/agent-loop descriptors with validation for allowed and
  unsupported credential source labels.
- Added sanitized provider-loop projection helpers and exposed the read-only
  `config.provider_loop_config` field through `config/read`.
- Added explicit provider/agent-loop selection for known descriptor ids and loop
  ids. Selection maps only to existing runtime backends, preserves legacy
  runtime environment overrides and `CLAUDE_CODEX_MOCK=1` precedence, filters
  raw saved selection keys from public `config/read`, and exposes sanitized
  selection metadata through `config.provider_loop_config.selection`.
- Added tests proving built-in descriptors validate cleanly, unsupported
  credential labels are not projected as allowed, and secret-like descriptor
  text is redacted from public projection results.
- Background subagents (`run_in_background` Agent calls) keep running across
  turns, as Codex App 26.930 shows them: the Claude session stays open while
  they run, a finished agent's report wakes the parent with a new turn,
  `SendMessage` resumes an agent, and the child's Stop button ends it.
- Subagents behave the way the Codex App draws them: the parent's own tools
  beside an Agent call keep their cards, interrupts stop workflows and single
  children as Codex does, `SendMessage` / `TaskStop` map to agent calls, the
  CLI 2.1.283 hand-back report and usage trailer are parsed, and a finishing
  child no longer clears its still-running siblings from the roster.

### Rust-first protocol groundwork

- Added the Rust-first runtime boundaries RFC, keeping the TypeScript
  app-server adapter as the shipping runtime path while defining incremental
  Rust protocol, transport, store, and launcher boundaries.
- Added an experimental Rust workspace scaffold and protocol crate with
  representative Codex app-server JSON fixtures.
- Added Rust parse/reserialize tests for the covered fixtures.
- Added a pinned fixture drift check against the configured Codex CLI version
  and made it part of CI alongside `cargo test --workspace`.
- Extended fixture coverage to include config projection data without claiming a
  Rust production runtime, transport, store, or provider execution path.

### Release readiness and compliance docs

- Added open-source compliance documentation and release-readiness reference
  material for maintainers and reviewers.
- Clarified the README and documentation homepage around the TypeScript
  production path, Rust-first experimental boundaries, provider/agent-loop
  descriptor and selection boundaries, supported credential ownership models,
  unsupported subscription/session/private endpoint/bypass behavior, and release
  verification expectations.
- Documented provider selection configuration for `CLAUDE_CODEX_PROVIDER`,
  `CLAUDE_CODEX_AGENT_LOOP`, saved provider-loop config keys, precedence rules,
  and sanitized `config.provider_loop_config.selection` projection.
- Documented the current shippable baseline: TypeScript remains the production
  path; Rust pieces are opt-in protocol boundary work; provider/loop descriptors
  are read-only metadata, not runtime dispatch.
- Documented supported credential ownership models: local user-provided API
  keys, official cloud-provider credential chains, organization-managed
  gateways, and local CLI auth for same-host user-directed execution.
- Documented unsupported credential models, including personal subscription
  sharing, browser cookie/session-token reuse, private provider endpoints,
  bypass guidance, and credential redistribution.

### Validation and release gates

- Default CI runs Biome checks, TypeScript typechecking, the Node test suite,
  Rust workspace tests, and the pinned Rust protocol fixture drift gate.
- Documentation changes should run `npm run docs:build`.
- Credentialed smoke and acceptance checks remain opt-in and must use
  credentials already owned by the local user or organization on the host.

### Still experimental or not yet included

- No Rust production runtime, transport, store, provider execution path, or
  default-on Rust launcher is included.
- No executable new provider loop is included beyond the existing runtime
  backends.
- No broad runtime dispatch rewrite is included.
- No new credential collection model is included.
- No support is included for personal subscription sharing, credential pooling,
  browser cookie/session-token reuse, private provider endpoints, or provider
  bypass behavior.
