# RFC: Rust-first Runtime Boundaries

## Summary

Claude Codex Adapter should become Rust-first by moving the parts that most need
strict protocol typing, durable process boundaries, and host-level portability
behind narrow interfaces. The current TypeScript app-server adapter remains the
shipping product while Rust components are introduced as opt-in, testable
subsystems.

The first Rust pull request should be a scaffold only: a small workspace crate
that can ingest or mirror the generated Codex app-server schema and run a smoke
test against a few representative protocol shapes. It should not replace
`src/server.mts`, the Claude Agent SDK runtime, or the remote shim.

## Current State

The repository currently ships a TypeScript ESM adapter on Node.js 24:

- `src/adapter.mts` starts the app-server mode, installs daemon crash guards,
  owns Unix-socket singleton handling, and wires transport peers into the server.
- `src/server.mts` is the Codex app-server protocol layer. It dispatches JSON-RPC
  methods, owns Codex-shaped notifications, stores active turn state, bridges
  approvals, maps runtime events into `ThreadItem`s, and implements remote
  filesystem, command, process, MCP, fuzzy search, config, account, and plugin
  compatibility surfaces.
- `src/transports.mts` implements stdio, WebSocket, Unix-socket daemon listening,
  and `app-server proxy` byte forwarding.
- `src/store.mts` persists threads and turns in SQLite via Node's `node:sqlite`.
- `src/types.mts` defines local protocol/runtime records and the
  `ClaudeRuntime` interface.
- `src/runtime-factory.mts` selects runtime backends:
  `agent-sdk-sidecar`, `agent-http`, `agentapi`, `claude-p`, `codex-proxy`, and
  `mock`.
- Runtime modules translate between Claude Code / Codex CLI behavior and the
  adapter's small `RuntimeEvent` surface.
- `generated/codex-app-server/` contains TypeScript generated from the real
  Codex app-server schema with `npm run generate:schema`.
- Tests are `node:test` suites against compiled `dist/`, plus credentialed
  smoke and acceptance scripts under `scripts/`.

This is a functioning TS-first architecture. Rust-first work must respect that
release path and add seams that can be verified independently.

## Goals

- Define Rust boundaries that can be introduced one PR at a time.
- Keep the TypeScript server and runtime backends releasable during migration.
- Make Codex app-server wire compatibility easier to test against upstream
  schema changes.
- Reduce the amount of long-lived protocol and daemon behavior that depends on
  ad hoc JavaScript object shapes.
- Preserve the current `ClaudeRuntime` abstraction until a Rust-hosted runtime
  has equivalent test coverage.
- Keep authentication and provider behavior outside the Rust RFC except for the
  interface contracts they require.

## Non-goals

- No rewrite of `src/server.mts` in the first Rust PR.
- No replacement of `@anthropic-ai/claude-agent-sdk` in this RFC.
- No provider, subscription, billing, or entitlement model design.
- No claim that Rust improves performance, security, or reliability before a
  benchmark or failure-mode test proves it.
- No change to the Codex App Remote UX, shim contract, or Claude Code auth
  guidance.
- No change to the existing TypeScript release gate.

## Proposed Boundaries

| Boundary | Candidate Rust role | Keep in TypeScript for now | Why this boundary fits |
| --- | --- | --- | --- |
| Protocol codec and schema mirror | Parse/serialize JSON-RPC envelopes and generated Codex app-server shapes; validate representative request/notification/response fixtures. | Method dispatch and runtime event mapping. | The schema is upstream-owned and benefits from strict generated types without changing behavior. |
| Transport daemon and proxy | Own stdio/WebSocket/Unix-socket framing, socket path validation, pidfile lifecycle, and proxy byte forwarding. | `CodexClaudeAppServer` request handling. | Transport behavior is process/OS heavy and has a narrow JSON-RPC message boundary. |
| Store/session persistence | Provide a typed SQLite store for threads, turns, migrations, and stale-turn recovery. | In-memory active-turn state and runtime callbacks. | Persistence has stable CRUD boundaries and migration risk that can be tested with fixtures. |
| Diff/patch utilities | Compute file-change summaries and git/untracked diffs behind a CLI or native addon boundary. | Approval policy decisions and UI notification timing. | Diff behavior is deterministic and can be covered with fixture repositories. |
| CLI shim / host launcher | Eventually replace shell-heavy host helpers with a compiled launcher that locates Node/Rust binaries and forwards `codex app-server` calls. | Current `scripts/codex-shim` and `scripts/claude-codex-mode`. | Host bootstrap is platform-sensitive; it should move only after transport and packaging are understood. |
| Runtime hosting | Long-term: a Rust supervisor can host TS/SDK or subprocess runtimes via a stable event protocol. | Claude Agent SDK integration and all runtime modules. | Claude SDK semantics are still moving; runtime rewrite should wait until protocol and transport are stable. |

The first boundary should be protocol codec and schema mirror. It is the least
coupled to credentials, sockets, Claude Code process behavior, and GUI
acceptance.

## Migration Phases

### Phase 0: RFC and ownership

Document the target boundaries, testing gates, and non-goals. No runtime
behavior changes.

### Phase 1: Rust workspace scaffold and protocol smoke

Add a minimal Rust workspace under a proposed path such as `crates/` with:

- a protocol crate name such as `claude-codex-protocol`;
- a checked-in README explaining that it is not used by production yet;
- fixtures for a small set of Codex app-server envelopes, for example
  `initialize`, `thread/start`, `turn/started`, `turn/completed`, and
  `mcpServerStatus/list`;
- tests that parse and re-serialize those fixtures without losing required
  fields.

This phase may either mirror a small subset of the generated TypeScript schema
by hand or introduce a proposed generation command. If a generator is proposed
but not implemented, the command must be labelled proposed in docs.

### Phase 2: Schema generation experiment

Add a repeatable path from the real Codex schema to Rust protocol types. Possible
options:

- use upstream `codex app-server generate-ts --experimental` as the source of
  truth, then generate Rust fixtures from the TypeScript output;
- add a separate upstream command if Codex exposes Rust/JSON schema output later;
- maintain a small hand-written Rust protocol subset while validating against
  TS-generated fixtures.

This phase is successful only when CI can detect drift in the covered fixtures.

### Phase 3: Rust transport prototype

Add an opt-in transport binary that accepts JSON-RPC over stdio or a Unix socket
and forwards messages to the existing TypeScript server process. The goal is
not to replace the server; it is to prove socket lifecycle, framing, pidfile, and
proxy behavior can be tested independently.

The TypeScript transport remains the default until local remote and GUI SSH
acceptance pass through the Rust transport.

### Phase 4: Rust store prototype

Move session persistence behind a process or library boundary. Start with a
fixture-based migration test for existing `state.sqlite` rows and legacy enum
cleanup. Production uses TypeScript store until:

- stale in-progress turn recovery matches current behavior;
- thread list/read/turn list tests pass with the Rust store;
- downgrade/upgrade behavior is documented.

### Phase 5: Controlled runtime host

Only after protocol, transport, and store boundaries are covered should the
runtime host be considered. The first runtime-host PR should supervise the
existing TypeScript/SDK runtime as a child process or event stream. It should
not attempt to reimplement Claude Agent SDK semantics.

## Testing Strategy

Every Rust phase needs tests at the smallest boundary plus the existing TS
release gates.

| Phase | Required tests |
| --- | --- |
| RFC only | `npm run docs:build` |
| Rust scaffold | `cargo test` for the new crate, `npm run docs:build`, and no changes to `npm test` behavior |
| Protocol generation | `cargo test`, fixture drift test, `npm run generate:schema` comparison when available, `npm test` |
| Transport prototype | Rust transport unit tests, stdio/WebSocket/Unix socket integration tests, `npm test`, `npm run acceptance:local-remote`; GUI SSH acceptance before defaulting on |
| Store prototype | Rust migration/store tests using SQLite fixtures, current `SessionStore` parity tests, `npm test` |
| Runtime host | Mock runtime event contract tests, `npm test`, `npm run smoke:real`, and both acceptance scripts before replacing defaults |

Credentialed checks must keep their current boundary: real Claude checks require
Anthropic, Bedrock, or Vertex auth on the host. Mock tests remain the default
CI path.

## Compatibility With Existing Codex App-server Protocol

The Rust path must treat Codex app-server compatibility as a contract, not an
implementation detail.

- The advertised protocol version and user agent must remain controlled by the
  existing compatibility knobs until a Rust launcher owns them.
- Rust protocol fixtures should be derived from or checked against
  `generated/codex-app-server/`.
- JSON field names, optional/null behavior, and enum spellings must match the
  current TS adapter and upstream Codex schema.
- Compatibility-only surfaces should keep their current behavior: return stable
  inert responses where Claude Code has no equivalent, rather than failing the
  GUI capability probe.
- Any Rust transport must preserve the `codex app-server --listen unix://` and
  `codex app-server proxy` behavior used by Codex App Remote.
- Any Rust store must preserve existing SQLite data or ship a documented,
  tested migration.

## Risks

- **Scope creep:** moving runtime, provider, and transport at once would create a
  large PR that cannot be reviewed safely. Mitigation: first Rust PR is scaffold
  plus protocol smoke only.
- **Protocol drift:** hand-written Rust types can silently diverge from Codex.
  Mitigation: fixtures and generation/drift checks before production use.
- **Double maintenance:** TS and Rust protocol shapes may duplicate effort.
  Mitigation: keep the Rust subset small until generation is repeatable.
- **Packaging complexity:** remote hosts currently need only Node 24 and the
  built JS artifact. Rust binaries add platform artifacts. Mitigation: keep Rust
  optional until release packaging is proven.
- **False safety claims:** Rust can reduce classes of memory bugs but does not
  automatically make protocol behavior safer. Mitigation: require failure-mode
  tests and avoid unmeasured claims.
- **Auth boundary confusion:** Claude Code and Codex CLI auth remain owned by
  their respective CLIs. Mitigation: Rust components should pass through auth
  state and never store provider secrets.

## Open Questions

- Should the first Rust crate live in this repository under `crates/`, or should
  it be a separate package consumed by this adapter?
- What is the best upstream source for Rust protocol generation: TypeScript
  generated files, a future JSON schema export, or a direct Codex Rust crate?
- Should Rust components communicate with the TS server over JSON-RPC, stdio, or
  a native addon boundary?
- How should release packaging distribute optional Rust binaries for macOS and
  Linux while preserving the current Node-only deployment path?
- Which acceptance script should become the default gate before enabling any
  Rust component by default?

## First Rust PR Shape

The first implementation PR should be intentionally small:

- add `crates/claude-codex-protocol/` or equivalent;
- add a crate README and 3-5 JSON fixtures copied from existing mock protocol
  tests;
- add `cargo test` coverage for parsing and serializing those fixtures;
- add CI only if the crate exists and the command is fast;
- update docs to say the crate is experimental and not used in production.

It should not modify `src/server.mts`, `src/transports.mts`, `src/store.mts`, or
runtime modules. That keeps the current TypeScript release path intact while
making Rust-first work concrete and reviewable.
