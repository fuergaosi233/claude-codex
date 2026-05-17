import type { ClaudeRuntime } from './types.mjs'
import { MockRuntime } from './mock-runtime.mjs'
import { NativeClaudeRuntime } from './native-runtime.mjs'

// Single in-process runtime. We used to shell out to a Python sidecar that
// wrapped the claude-agent-sdk Python package; now we call the TS edition
// (@anthropic-ai/claude-agent-sdk) directly. Same surface area, one fewer
// process boundary, no JSONL bridge to maintain.
export function createRuntime(): ClaudeRuntime {
  if (process.env.CLAUDE_CODEX_MOCK === '1') return new MockRuntime()
  return new NativeClaudeRuntime()
}
