import type { ClaudeRuntime } from './types.mjs'
import { MockRuntime } from './mock-runtime.mjs'
import { ClaudeSdkSidecarRuntime } from './sidecar-runtime.mjs'
import { ClaudeSdkSocketRuntime } from './socket-runtime.mjs'

export function createRuntime(): ClaudeRuntime {
  if (process.env.CLAUDE_CODEX_MOCK === '1') return new MockRuntime()
  if (process.env.CLAUDE_CODEX_RUNTIME_SOCKET) return new ClaudeSdkSocketRuntime(process.env.CLAUDE_CODEX_RUNTIME_SOCKET)
  return new ClaudeSdkSidecarRuntime()
}
