# Examples

These examples show safe local setup patterns. They intentionally use
placeholders and do not include real credentials.

## Local shell exports

Use your shell, a local secret manager, or your deployment system to inject
credentials at runtime. Do not commit `.env` files or resolved secrets.

```bash
export CLAUDE_CODEX_ADAPTER="$PWD/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="/absolute/path/to/node-24"

# Choose one authentication method managed by your own environment.
export ANTHROPIC_API_KEY="<your-anthropic-api-key>"
# or authenticate interactively on the host:
# claude /login
```

## Remote shim setup

```bash
mkdir -p "$HOME/bin"
cp scripts/codex-shim "$HOME/bin/codex"
chmod +x "$HOME/bin/codex"
export PATH="$HOME/bin:$PATH"
```

After building the adapter, point `CLAUDE_CODEX_ADAPTER` at the compiled entry
point on that host:

```bash
npm install
npm run build
export CLAUDE_CODEX_ADAPTER="$PWD/dist/src/adapter.mjs"
```

## Protocol-only local test

Use the mock runtime when you want to test the app-server protocol without live
Claude credentials:

```bash
CLAUDE_CODEX_MOCK=1 node dist/src/adapter.mjs app-server --listen ws://127.0.0.1:8788
```

See [../docs/guide/getting-started.md](../docs/guide/getting-started.md) and
[../docs/guide/deployment.md](../docs/guide/deployment.md) for the full setup
guide.
