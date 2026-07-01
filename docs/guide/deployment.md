# Deployment

The deployment target is a remote SSH host with a `codex` shim earlier in the
login-shell `PATH`.

## Install the shim

Install `scripts/codex-shim` as `codex` on the remote host:

```bash
mkdir -p ~/bin
cp scripts/codex-shim ~/bin/codex && chmod +x ~/bin/codex
```

Then have the login shell export the adapter pointers. Put these in `~/.zshenv`
so non-interactive SSH sees them too:

```bash
export PATH="$HOME/bin:$PATH"
export ANTHROPIC_API_KEY="<your-anthropic-api-key>" # or sign in with `claude /login`
export CLAUDE_CODEX_ADAPTER="/opt/claude-codex-adapter/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="/absolute/path/to/node" # optional
export CODEX_REAL="/usr/local/bin/codex.real"     # optional native-Codex fallback
```

Keep credentials in the host environment or a secret manager. Do not commit
real API keys, OAuth/session state, `.env` files, copied shell snippets with
resolved secrets, or private infrastructure URLs.

Codex App keeps using its native SSH flow: it probes `codex --version`, starts
`codex app-server --listen unix://`, then connects via `codex app-server proxy`.
The shim routes only those app-server calls to the adapter.

::: tip Custom Anthropic endpoints
If your organization uses a supported custom Anthropic endpoint, configure
`ANTHROPIC_BASE_URL` in the host environment. Treat the endpoint value as
deployment configuration and avoid committing private URLs.
:::

## Bootstrapping a fresh host (no sudo / Homebrew)

A clean machine usually needs only four user-space tools:

```bash
# 1. Node 24 (stable node:sqlite) — pick your platform tarball from nodejs.org/dist.
curl -fsSL https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.xz | tar -xJ -C ~/.local

# 2. Claude Code CLI under a user prefix.
mkdir -p ~/.local/npm-global
~/.local/node-v24.11.0-darwin-arm64/bin/npm config set prefix ~/.local/npm-global
~/.local/npm-global/bin/npm install -g @anthropic-ai/claude-code
~/.local/npm-global/bin/claude /login        # interactive: claude.ai OAuth

# 3. Adapter checkout + build.
git clone https://github.com/fuergaosi233/claude-codex ~/claude-codex && cd ~/claude-codex
npm install && npm run build

# 4. Persist PATH + adapter pointers for non-interactive SSH.
cat >>~/.zshenv <<'EOF'
export PATH="$HOME/.local/npm-global/bin:$HOME/.local/node-v24.11.0-darwin-arm64/bin:$HOME/.local/bin:$PATH"
export CLAUDE_CODEX_ADAPTER="$HOME/claude-codex/dist/src/adapter.mjs"
export CLAUDE_CODEX_NODE="$HOME/.local/node-v24.11.0-darwin-arm64/bin/node"
EOF
cp scripts/codex-shim ~/.local/bin/codex && chmod +x ~/.local/bin/codex

npm run doctor       # all checks should be ok
npm run smoke:real   # round-trips a real Claude turn
```

Codex App's Remote connection then hits the shim first and is routed into the
adapter. Disconnecting reclaims the daemon so the adapter exits.

## Daemon lifecycle

The daemon owns the Unix socket while a client is connected. When the last
client disconnects it shuts down after an idle grace period (deferred if a turn
is still active; reconnecting during that window reattaches notifications). Tune
with `CLAUDE_CODEX_IDLE_EXIT_MS` (default `15000`; `0` keeps it running).

## Quick remote probe

```bash
ssh host 'command -v codex'
ssh host 'codex --version'
```
