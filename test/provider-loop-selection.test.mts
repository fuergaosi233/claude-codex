import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveProviderLoopSelection } from '../src/provider-loop-selection.mjs'

test('provider loop selection resolves known provider ids to existing runtimes', () => {
  const selection = resolveProviderLoopSelection({
    providerId: 'codex',
    source: 'environment',
  })

  assert.equal(selection.providerId, 'codex')
  assert.equal(selection.loopId, 'codex-jsonl-proxy')
  assert.equal(selection.runtimeType, 'codex-proxy')
  assert.equal(selection.source, 'environment')
  assert.deepEqual(selection.issues, [])
})

test('provider loop selection resolves known loop ids to existing runtimes', () => {
  const selection = resolveProviderLoopSelection({
    loopId: 'native-claude-code-sdk',
    source: 'config',
  })

  assert.equal(selection.providerId, 'claude-code')
  assert.equal(selection.loopId, 'native-claude-code-sdk')
  assert.equal(selection.runtimeType, 'agent-sdk-sidecar')
  assert.equal(selection.source, 'config')
  assert.deepEqual(selection.issues, [])
})

test('provider loop selection reports mismatched provider and loop inputs', () => {
  const selection = resolveProviderLoopSelection({
    providerId: 'claude-code',
    loopId: 'codex-jsonl-proxy',
    source: 'environment',
  })

  assert.equal(selection.providerId, 'claude-code')
  assert.equal(selection.loopId, 'native-claude-code-sdk')
  assert.equal(selection.runtimeType, 'agent-sdk-sidecar')
  assert.deepEqual(
    selection.issues.map((issue) => issue.code),
    ['provider-loop-mismatch'],
  )
})

test('provider loop selection reports unknown values without exposing secrets', () => {
  const selection = resolveProviderLoopSelection({
    providerId: 'ANTHROPIC_API_KEY=sk-ant-fake000000000000000000000000000000',
    loopId: 'token=secret000000000000000000000000000000',
    source: 'config',
  })

  assert.equal(selection.providerId, 'claude-code')
  assert.equal(selection.runtimeType, 'agent-sdk-sidecar')
  assert.deepEqual(
    selection.issues.map((issue) => issue.message),
    [
      'unknown provider selection: ANTHROPIC_API_KEY=[redacted]',
      'unknown agent loop selection: token=[redacted]',
    ],
  )
})

test('provider loop selection keeps legacy runtime override precedence', () => {
  const selection = resolveProviderLoopSelection({
    providerId: 'codex',
    legacyRuntimeType: 'agent-http',
    source: 'environment',
  })

  assert.equal(selection.providerId, 'codex')
  assert.equal(selection.loopId, 'codex-jsonl-proxy')
  assert.equal(selection.runtimeType, 'agent-http')
  assert.equal(selection.source, 'legacy-runtime')
})

test('provider loop selection keeps mock precedence', () => {
  const selection = resolveProviderLoopSelection({
    providerId: 'codex',
    legacyRuntimeType: 'agent-http',
    mock: true,
    source: 'environment',
  })

  assert.equal(selection.providerId, 'codex')
  assert.equal(selection.loopId, 'codex-jsonl-proxy')
  assert.equal(selection.runtimeType, 'mock')
  assert.equal(selection.source, 'mock')
})
