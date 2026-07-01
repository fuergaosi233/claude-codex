# claude-codex-protocol

Experimental Rust protocol smoke crate for `claude-codex`.

This crate is not used by production. The TypeScript app-server adapter remains
the shipping runtime path. The crate only checks a small set of representative
Codex app-server JSON-RPC envelopes so future Rust-first protocol work has a
reviewable starting point.

Current scope:

- parse and serialize JSON-RPC envelope fixtures;
- identify request, notification, and response envelopes;
- keep fixture coverage intentionally small until a repeatable schema generation
  path exists.

Proposed follow-up: derive these fixtures from the generated Codex app-server
schema once a stable Rust or JSON-schema source is available.

