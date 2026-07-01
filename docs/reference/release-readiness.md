# Release Readiness

This page summarizes the current release baseline for maintainers and reviewers.
It describes what is shippable, what is guarded by tests, and what remains
experimental.

## Shippable baseline

The production path is still the TypeScript app-server adapter:

- Node.js 24 runs the adapter, SQLite store, transports, server dispatch, and
  runtime bridge modules.
- Codex App Remote still enters through the normal SSH, shim, `app-server
  --listen unix://`, and `app-server proxy` flow.
- The default runtime path is the Claude Agent SDK sidecar. Other backends remain
  selectable through documented environment configuration.

Rust work is present, but it is opt-in protocol boundary work. It does not
replace the TypeScript runtime, transport, store, or provider execution path.

## Verification matrix

| Gate | Default? | What it protects |
| --- | --- | --- |
| `npm run check` | CI | Biome formatting and linting for TypeScript, tests, and scripts. |
| `npm run typecheck` | CI | TypeScript compile-time protocol and adapter contracts. |
| `npm test` | CI | Compiled Node test suite, including protocol, runtime, config, store, and projection behavior. |
| `cargo test --workspace` | CI | Rust workspace tests for the experimental protocol crate. |
| `npm run check:rust-protocol-fixtures` | CI | Drift between pinned Codex app-server behavior and checked Rust protocol fixtures. |
| `npm run docs:build` | Release/docs PRs | VitePress documentation build and link rendering. |
| `npm run smoke:real` | Opt-in | Real Claude turn using host-owned Anthropic, Bedrock, or Vertex credentials. |
| `npm run acceptance:local-remote` | Opt-in | Local shim, daemon, proxy, and real Claude file-edit flow. |
| `npm run acceptance:gui-ssh-localhost` | Opt-in | Closest automated check to Codex App GUI Remote over SSH localhost. |

Default CI uses fake or mockable credentials. Credentialed smoke and acceptance
checks require credentials already owned by the local user or organization on
the host running the check.

## Rust-first status

The Rust-first direction is documented in
[Rust-first runtime boundaries](/rfcs/rust-first-runtime). Current status:

- RFC boundaries are written and scoped away from a broad rewrite.
- A Rust workspace scaffold exists under `crates/`.
- Representative app-server JSON fixtures are checked in.
- Rust tests parse and re-serialize the covered fixtures.
- CI runs `cargo test --workspace`.
- CI runs a pinned fixture drift check against `@openai/codex@0.142.3`.

Not claimed yet:

- no Rust production runtime;
- no Rust transport replacement;
- no Rust store replacement;
- no Rust provider or auth execution path;
- no default-on Rust launcher.

The next Rust PR should stay incremental, for example by extending fixture
coverage or generation around one protocol slice.

## Provider and multi-agent status

Provider and loop boundaries are documented in
[Provider and multi-agent loop boundaries](/rfcs/provider-and-agent-loop-boundaries).
Current implementation status:

- static provider/agent-loop descriptors exist;
- descriptor validation covers allowed and unsupported credential source labels;
- projection helpers redact secret-like text;
- `config/read` exposes a sanitized read-only `config.provider_loop_config`;
- adapter-level tests cover the `config/read` projection.

Not claimed yet:

- no broad runtime dispatch rewrite;
- no executable new provider loop beyond existing runtime backends;
- no new credential collection model;
- no subscription pooling, brokering, or redistribution support.

Future provider work should start with small config/schema/test changes before
any runtime behavior changes.

## Compliance boundaries

Supported credential ownership models:

- user-provided API keys supplied through the local host shell or secret manager;
- cloud-provider credentials supplied through official provider chains, such as
  Bedrock or Vertex where supported by the upstream SDK or CLI;
- organization-managed gateways that own authorization, billing, audit, rate
  limits, and provider compliance;
- local CLI auth for local user-directed execution on the same host.

Unsupported and out of scope:

- pooling, sharing, collecting, replaying, or redistributing personal
  subscriptions;
- browser cookie reuse, OAuth/session-token synchronization, or uploaded local
  CLI state;
- private or unofficial provider endpoints;
- bypassing provider rate limits, seat limits, entitlement checks, or terms;
- putting real tokens, session material, local account details, or secret values
  into docs, fixtures, logs, `config/read`, or generated artifacts.

Provider metadata should describe allowed credential source classes and loop
fidelity. It must not imply that unsupported subscriptions or sessions are
product features.

## Release blockers and next PRs

Before a public release, maintainers should confirm:

- versioning and changelog notes are present for the release;
- docs build succeeds after navigation changes;
- CI is green on `main`;
- any credentialed smoke or acceptance evidence was produced locally without
  committing logs or secrets;
- release notes do not claim Rust or provider behavior beyond implemented,
  tested surfaces.

Recommended next PR shapes:

- docs/versioning/changelog updates if release notes are still missing;
- one small provider config or selection slice that preserves existing runtime
  behavior;
- one Rust protocol generation or fixture coverage slice.

Avoid bundling those with a broad runtime rewrite.

## Reviewer checklist

For future release PRs:

- Code changes include focused tests for the behavior they add.
- Docs-only changes run `npm run docs:build`.
- No committed secrets, credentials, local account details, generated artifacts,
  acceptance logs, or private endpoint examples.
- Runtime claims match implemented and tested behavior.
- Rust claims remain protocol-boundary or opt-in unless production wiring and
  parity tests are present.
- Provider claims stay within supported local/API/cloud/organization credential
  ownership models.
- Unsupported credential sources are rejected, redacted, or omitted from public
  projections.
- Generated artifacts are produced by documented commands, not hand-edited.
