# RFC: Provider and Multi-agent Loop Boundaries

## Summary

Claude Codex Adapter should separate three concerns that are currently easy to
discuss as one vague feature:

- **Runtime backends** execute a turn through Claude Code, Codex CLI, or a bridge.
- **Model providers** describe which model family, gateway, and credential source
  a backend may use.
- **Agent loops** describe the turn protocol and event semantics the adapter can
  project into Codex App.

The project can support user-provided API keys, supported cloud-provider
credentials, and organization-managed gateways. It must not collect,
redistribute, broker, or automate personal subscription/session credentials in a
productized way, and it must not document private proxies or bypasses for
provider terms.

The first implementation PR should be a small config/schema/test PR that names
provider and loop descriptors without changing runtime execution. It should not
rewrite `src/runtime-factory.mts`, add a new provider runtime, or change auth
behavior.

## Current state

The adapter is TS-first and routes all turns through a small `ClaudeRuntime`
interface:

- `src/runtime-config.mts` defines `RuntimeBackendType`: `agent-sdk-sidecar`,
  `agent-http`, `agentapi`, `claude-p`, `codex-proxy`, and `mock`.
- `src/runtime-factory.mts` resolves environment configuration, lazily
  instantiates backend modules, tracks the active runtime per thread, and has a
  local structured-summary fallback for HTTP-style bridges.
- `src/native-runtime.mts` uses `@anthropic-ai/claude-agent-sdk` and delegates
  auth to host state such as an API key, supported cloud credentials, or local
  Claude Code auth.
- `src/http-agent-runtime.mts` talks to local HTTP/SSE bridge processes such as
  agent-http or agentapi.
- `src/claude-p-runtime.mts` wraps one-shot `claude-p` transcript execution.
- `src/codex-proxy-runtime.mts` shells out to `codex exec --json` for threads
  routed to the real Codex CLI; auth stays owned by Codex CLI on the user's host.
- `src/mock-runtime.mts` exercises protocol behavior without credentials.
- `src/server.mts` exposes Codex-shaped `config/read` provider metadata for
  `claude-code` and, when available, a forwarded `codex` provider. The entries
  intentionally report `requires_openai_auth: false` because this adapter does
  not own OpenAI account auth.
- `docs/guide/configuration.md` documents env-driven backend/model/tool config.
- `docs/guide/backends.md` documents route switching and backend capability
  limits.
- `docs/rfcs/rust-first-runtime.md` is the existing RFC style: status-neutral,
  explicit about first PR shape, and scoped away from broad rewrites.

This shape is useful but not yet a provider abstraction. Backend names mix
transport, tool semantics, model family, and auth ownership. Future release work
needs clearer boundaries before adding new loops or subscription-aware provider
metadata.

## Goals

- Define provider, runtime, and loop boundaries before implementation.
- Keep current backends working while new descriptors are introduced.
- Allow compliant bring-your-own credentials:
  - user-provided API keys;
  - supported cloud-provider credentials such as Bedrock or Vertex where the
    upstream SDK/CLI supports them;
  - organization-managed gateways with explicit authorization and auditability.
- Make provider metadata safe to expose through Codex App config surfaces.
- Make multi-agent loop compatibility testable without committing to every loop
  as a first-class runtime.
- Define subscription and entitlement boundaries in terms of ownership,
  authorization, and provider terms.
- Keep the first implementation PR small, reviewable, and docs/config/test only.

## Non-goals

- No runtime/provider implementation in this RFC.
- No changes to `ClaudeRuntime`, `RuntimeBackendType`, or current backend
  modules in the RFC PR.
- No attempt to automate login flows for personal subscriptions.
- No collection, storage, redistribution, resale, pooling, or replay of personal
  subscription credentials, OAuth sessions, browser cookies, CLI state, or
  private tokens.
- No private proxy endpoint recommendations.
- No guidance for bypassing rate limits, entitlement checks, seat limits, or
  provider terms.
- No billing system, marketplace, or commercial entitlement enforcement design.
- No claim that multi-agent loops are interchangeable until event, approval, and
  persistence behavior is tested.

## Provider abstraction boundaries

Provider metadata should describe credential ownership and model availability;
runtime backends should keep executing turns through their existing interfaces.

| Layer | Owns | Must not own |
| --- | --- | --- |
| Provider descriptor | Provider id, display name, model family, allowed credential source types, gateway base URL policy, entitlement notes, compliance status. | Runtime process lifecycle, tool execution, hidden session material, subscription resale. |
| Runtime backend | Turn execution, streaming, approvals/diffs, interruptions, session resume, tool event mapping. | Billing authority, provider account ownership, credential collection outside documented env/secret-manager inputs. |
| Agent loop descriptor | Event vocabulary, streaming granularity, approval model, tool-result shape, steer/interrupt support, persistence semantics. | Provider terms interpretation, credential storage, account sharing. |
| Config/read projection | Codex App-compatible model provider and model list metadata derived from descriptors. | Secrets, hidden bearer tokens, private cookie/session data. |
| Secret source | References to env vars, cloud SDK default chains, local secret managers, or organization gateway configuration. | Raw secret values in docs, logs, config/read output, state.sqlite, debug.jsonl, or generated fixtures. |

Provider descriptors should be declarative and boring. A descriptor can say
`anthropic-api-key`, `bedrock-default-chain`, `vertex-default-chain`, or
`organization-gateway` as a credential source. It should not say "reuse a user's
paid interactive session" as a product capability.

`RuntimeBackendType` may continue to select concrete execution routes during the
first phases. A later implementation can map `(provider, loop)` onto a runtime
only after tests prove that the provider's credential model and the loop's event
model are compatible with Codex App.

## Supported auth and compliance model

Supported future configurations:

- **Bring-your-own API key:** the user or organization supplies a provider API
  key through the host shell, secret manager, or CI secret. The adapter may read
  the variable name but must not persist the value.
- **Cloud provider credentials:** the host uses the upstream-supported default
  credential chain for services such as AWS Bedrock or Google Vertex AI. The
  adapter should document the provider-owned setup path and avoid copying
  credentials.
- **Organization gateway:** an organization runs an authorized gateway that owns
  billing, policy, rate limits, audit logs, and provider compliance. The adapter
  may support a configured gateway URL and header names, but real secret values
  stay in the host environment or secret manager.
- **Local CLI auth for local use:** existing backends may continue to rely on
  local Claude Code or Codex CLI auth state when the user is running the adapter
  on their own host. This is not a productized credential distribution model.

Unsupported configurations:

- Pooling or sharing personal subscriptions across users.
- Capturing, replaying, or synchronizing local subscription sessions, OAuth
  refresh tokens, browser cookies, or CLI state.
- Shipping a hosted service that asks users to upload personal subscription
  credentials for redistribution to other workers.
- Advertising private or unofficial endpoints as a way to avoid provider
  restrictions.
- Faking account/provider metadata in `config/read` to unlock UI affordances
  that the underlying provider entitlement does not allow.

Provider docs should use this language consistently: credentials are either
user-owned on the same host, organization-owned in an approved gateway, or
cloud-provider-owned through official SDK chains.

## Multi-agent loop compatibility

An "agent loop" is the behavioral contract between the adapter and an execution
engine. Provider support should not imply loop compatibility.

| Loop class | Examples in current or adjacent ecosystem | Compatibility requirements |
| --- | --- | --- |
| Native Claude Code SDK loop | Current `agent-sdk-sidecar` route. | Rich streaming, thinking/text/tool events, permission decisions, file-change approvals, interrupt, steer, resumable sessions. |
| HTTP/SSE bridge loop | Current `agent-http` / `agentapi` routes. | Message-level streaming or polling, bridge health, trust prompt handling, limited approval/file-change fidelity. |
| Transcript loop | Current `claude-p` route. | One-shot prompt/result transcript, optional resume only after command-specific verification, no rich mid-turn controls. |
| Codex JSONL loop | Current `codex-proxy` route. | JSONL event mapping, Codex session resume, native Codex approval/sandbox behavior, model family isolation from Claude routes. |
| Future organization gateway loop | A compliant internal gateway wrapping provider APIs or agent runtimes. | Official credentials, explicit policy ownership, documented event mapping, no hidden personal-session reuse. |
| Future multi-agent orchestrator loop | A supervisor that fans out subagents or delegates work. | Stable parent/child event semantics, visible approval routing, deterministic cancellation, clear persistence boundaries, no secret fan-out beyond allowed tools. |

Before a new loop is productized, the project should answer:

- Can the loop stream enough event detail for Codex App timelines?
- Where do approvals happen, and can file diffs be shown before mutation?
- Does `turn/steer` mean live input, queued next-turn input, or unsupported?
- Can interrupts cancel work without orphaning child agents?
- How are subagent outputs represented without leaking hidden tool context?
- Does the loop need workspace trust, and how is that surfaced to the user?
- Which credential sources are passed to child processes or subagents?

Multi-agent loops should inherit the least privilege needed for their tools.
Secrets should not be copied into subagent prompts, transcript fixtures, or
debug logs. If a loop fans out work to other processes, each process must have a
documented credential boundary and cancellation path.

## Subscription and entitlement boundaries

The adapter should treat subscriptions and entitlements as provider-owned facts,
not as resources the project can transform or resell.

- **API and cloud billing:** allowed when the user or organization controls the
  API/cloud account and supplies credentials through approved secret channels.
- **Organization gateways:** allowed when the gateway owner is responsible for
  authorization, rate limits, billing, audit, and provider terms.
- **Local personal sessions:** acceptable only as local, user-directed execution
  on the same host, matching the existing CLI/SDK expectation. Do not turn this
  into a shared hosted provider.
- **Entitlement display:** model lists and provider names should reflect what
  the configured backend can actually use. Do not label unavailable models as
  enabled to bypass UI gating.
- **Debugging and telemetry:** logs may include provider ids, loop ids, and
  redacted env var names. They must not include bearer tokens, OAuth sessions,
  cookies, API keys, private gateway headers, or subscription artifacts.

If a provider requires interactive login or consumer subscription state, the RFC
default is "local-only, not productized" unless provider terms explicitly allow
automation for the intended deployment.

## Migration phases

### Phase 0: RFC and terminology

Add this RFC and link it from the docs sidebar. No runtime behavior changes.

### Phase 1: Config/schema/test descriptors

Add a small typed descriptor shape for providers and loops. The descriptor should
be static data plus validation tests, not a runtime dispatcher. Suggested fields:

- `id`, `displayName`, `status`;
- `providerFamily`, `allowedCredentialSources`, `gatewayPolicy`;
- `loopId`, `eventFidelity`, `approvalFidelity`, `supportsSteer`,
  `supportsInterrupt`, `supportsResume`;
- `complianceNotes`, `unsupportedCredentialSources`;
- mapping to the existing `config/read` provider projection.

Tests should verify that descriptors never expose secret values and that
unsupported credential source labels cannot be projected as supported.

### Phase 2: Read-only config projection

Project descriptor metadata into `config/read` and the model list while keeping
existing runtime selection unchanged. This phase should be a UI/config
compatibility change only.

### Phase 3: Explicit provider selection

Add env or config selection for provider descriptors, still mapped to existing
runtime backends. The runtime factory may read a selected descriptor only to
choose already-supported behavior. No new agent loop yet.

### Phase 4: One new compliant provider path

Introduce one provider path that uses official API/cloud/gateway credentials and
has tests for credential redaction, config projection, failure messaging, and
mock runtime behavior. Avoid adding a multi-agent orchestrator in the same PR.

### Phase 5: One new loop compatibility path

Introduce one loop descriptor and runtime integration after its event, approval,
interrupt, resume, and secret-boundary behavior are covered. This can be an
organization gateway loop or orchestrator loop, but not both at once.

## Testing strategy

| Scope | Required checks |
| --- | --- |
| RFC only | `npm run docs:build`; optional docs/link check if added later. |
| Descriptor schema | Unit tests for descriptor validation, secret redaction, and `config/read` projection. |
| Config projection | Existing protocol/config tests plus model/provider list snapshots or focused assertions. |
| Provider selection | Mock-runtime integration proving selected provider metadata does not change turn execution unless intentionally mapped. |
| New API/cloud/gateway provider | Mock credentials, failure-path tests with redacted errors, and one opt-in credentialed smoke path documented separately. |
| New agent loop | Event fixture tests, approval/file-change tests where supported, cancellation tests, resume tests, and docs updates for unsupported controls. |

Credentialed checks should remain opt-in. Default CI should use mock or fake
credential sources and should assert that no secret value appears in logs,
state, fixtures, or Codex App config responses.

## Risks

- **Scope creep:** provider, subscription, billing, and loop work can easily
  become a broad runtime rewrite. Mitigation: first implementation PR is
  descriptor schema plus tests only.
- **Compliance ambiguity:** "support subscriptions" can be misread as pooling or
  automating personal sessions. Mitigation: define supported credential sources
  and unsupported credential sources in code and docs.
- **UI metadata drift:** provider entries exposed through `config/read` may imply
  capabilities the runtime cannot satisfy. Mitigation: derive metadata from
  tested descriptors and keep runtime support explicit.
- **Loop mismatch:** a bridge may return text but lack approval, interrupt, or
  resume semantics users expect. Mitigation: document fidelity per loop and test
  unsupported controls.
- **Secret leakage:** descriptors, debug logs, or fixtures could accidentally
  include real credentials. Mitigation: use names/references only and add
  redaction tests before any provider implementation.
- **Provider lock-in:** designing only for one vendor's auth shape could make
  gateway/cloud support awkward. Mitigation: describe credential source classes
  rather than provider-specific session mechanics.

## Open questions

- Should provider and loop descriptors live in `src/runtime-config.mts`, a new
  `src/provider-descriptors.mts`, or generated config schema?
- Should `CLAUDE_CODEX_RUNTIME_TYPE` remain the primary selector, or should a
  later `CLAUDE_CODEX_PROVIDER` plus `CLAUDE_CODEX_AGENT_LOOP` pair become the
  stable user-facing model?
- Which credential source labels should be considered stable public API?
- Should organization gateway support require an allowlist of header env var
  names to prevent accidental secret projection?
- What config response fields does Codex App actually use for provider display
  versus account gating, and which should stay inert?
- Which single provider path is safest for the first post-schema implementation:
  Anthropic API key, cloud provider default chain, or organization gateway?
- Which single loop path is safest to add after provider descriptors: richer
  HTTP bridge, gateway loop, or a supervised multi-agent orchestrator?

## First implementation PR shape

The first implementation PR should be intentionally small:

- add a provider/loop descriptor schema or typed constant set;
- add tests that validate allowed and unsupported credential source labels;
- add tests that prove descriptor projection never includes secret values;
- add a docs note pointing from configuration/backends to this RFC;
- avoid changing runtime execution, auth flows, process spawning, or provider
  terms guidance.

This keeps provider/subscription work reviewable and prevents the release from
mixing compliance-sensitive credential behavior with a broad runtime rewrite.
