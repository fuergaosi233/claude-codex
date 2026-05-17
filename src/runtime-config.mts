export type RuntimeBackendType =
  | 'mock'
  | 'agent-sdk-sidecar'
  | 'agent-sdk-socket'
  | 'agent-http'
  | 'agentapi'
  | 'claude-p'

export interface RuntimeConfig {
  type: RuntimeBackendType
  socketPath: string | null
  http: {
    baseUrl: string
    useSse: boolean
    pollIntervalMs: number
    timeoutMs: number
    sendInterruptRaw: boolean
    manageBridge: boolean
    modeCommand: string
  }
  claudeP: {
    command: string
    extraArgs: string[]
    timeoutMs: number
    skipPermissions: boolean
    resume: boolean
    stopTimeoutRetries: number
  }
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const explicit = normalizeRuntimeType(env.CLAUDE_CODEX_RUNTIME_TYPE ?? env.CLAUDE_CODEX_RUNTIME ?? env.CLAUDE_CODEX_BACKEND)
  const type =
    env.CLAUDE_CODEX_MOCK === '1'
      ? 'mock'
      : explicit ??
        (env.CLAUDE_CODEX_RUNTIME_SOCKET ? 'agent-sdk-socket' : 'agent-sdk-sidecar')

  return {
    type,
    socketPath: env.CLAUDE_CODEX_RUNTIME_SOCKET ?? null,
    http: {
      baseUrl: normalizeBaseUrl(
        env.CLAUDE_CODEX_HTTP_BASE_URL ??
          env.CLAUDE_CODEX_AGENT_HTTP_URL ??
          env.CLAUDE_CODEX_AGENTAPI_URL ??
          'http://127.0.0.1:3284',
      ),
      useSse: envFlag(env.CLAUDE_CODEX_HTTP_USE_SSE, true),
      pollIntervalMs: numericEnv(env.CLAUDE_CODEX_HTTP_POLL_MS, 500, 100, 60_000),
      timeoutMs: numericEnv(env.CLAUDE_CODEX_HTTP_TIMEOUT_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
      sendInterruptRaw: envFlag(env.CLAUDE_CODEX_HTTP_INTERRUPT_RAW, false),
      manageBridge: envFlag(env.CLAUDE_CODEX_HTTP_MANAGE_BRIDGE, false),
      modeCommand: env.CLAUDE_CODEX_MODE_COMMAND || 'claude-codex-mode',
    },
    claudeP: {
      command: env.CLAUDE_CODEX_CLAUDE_P_COMMAND || env.CLAUDE_P || 'claude-p',
      extraArgs: stringList(env.CLAUDE_CODEX_CLAUDE_P_ARGS),
      timeoutMs: numericEnv(env.CLAUDE_CODEX_CLAUDE_P_TIMEOUT_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
      skipPermissions: envFlag(env.CLAUDE_CODEX_CLAUDE_P_SKIP_PERMISSIONS, false),
      resume: envFlag(env.CLAUDE_CODEX_CLAUDE_P_RESUME, false),
      stopTimeoutRetries: numericEnv(env.CLAUDE_CODEX_CLAUDE_P_STOP_TIMEOUT_RETRIES, 1, 0, 5),
    },
  }
}

export function normalizeRuntimeType(value: string | undefined): RuntimeBackendType | null {
  const raw = (value ?? '').trim().toLowerCase()
  if (!raw) return null
  switch (raw) {
    case 'mock':
      return 'mock'
    case 'sdk':
    case 'agent-sdk':
    case 'agent-sdk-sidecar':
    case 'sidecar':
    case 'cloud-agent-sdk':
      return 'agent-sdk-sidecar'
    case 'agent-sdk-socket':
    case 'socket':
    case 'runtime-socket':
      return 'agent-sdk-socket'
    case 'agent-http':
    case 'channels':
    case 'channel':
    case 'http-channel':
      return 'agent-http'
    case 'agentapi':
    case 'agent-api':
      return 'agentapi'
    case 'claude-p':
    case 'claudep':
    case 'pty-transcript':
      return 'claude-p'
    default:
      throw new Error(`unknown CLAUDE_CODEX_RUNTIME_TYPE: ${value}`)
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback
  const raw = value.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function numericEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function stringList(value: string | undefined): string[] {
  if (!value || !value.trim()) return []
  const raw = value.trim()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
  } catch {}
  return raw.split(/\s+/).filter(Boolean)
}
