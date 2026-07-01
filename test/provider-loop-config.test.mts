import assert from 'node:assert/strict'
import test from 'node:test'
import { projectProviderLoopConfig } from '../src/provider-loop-config.mjs'

test('provider loop config projection exposes the inert public descriptor shape', () => {
  const projected = projectProviderLoopConfig()

  assert.deepEqual(
    projected.providers.map((provider) => provider.id),
    ['claude-code', 'codex'],
  )
  assert.deepEqual(projected.issues, [])
  assert.deepEqual(Object.keys(projected.providers[0] ?? {}).sort(), [
    'allowedCredentialSources',
    'approvalFidelity',
    'complianceNotes',
    'displayName',
    'eventFidelity',
    'gatewayPolicy',
    'id',
    'loopId',
    'providerFamily',
    'status',
    'supportsInterrupt',
    'supportsResume',
    'supportsSteer',
  ])
})

test('provider loop config projection filters unsupported credential labels', () => {
  const projected = projectProviderLoopConfig([
    {
      id: 'test-provider',
      displayName: 'Test Provider',
      status: 'experimental',
      providerFamily: 'anthropic',
      allowedCredentialSources: ['user-api-key', 'personal-session', 'browser-cookie'],
      gatewayPolicy: 'none',
      loopId: 'test-loop',
      eventFidelity: 'transcript',
      approvalFidelity: 'none',
      supportsSteer: false,
      supportsInterrupt: false,
      supportsResume: false,
      complianceNotes: ['fake descriptor for projection tests only'],
      unsupportedCredentialSources: ['personal-session', 'browser-cookie'],
    },
  ])

  assert.deepEqual(projected.providers[0]?.allowedCredentialSources, ['user-api-key'])
  assert.deepEqual(
    projected.issues.map((issue) => issue.code),
    ['unsupported-credential-source', 'unsupported-credential-source'],
  )
})

test('provider loop config projection redacts secret-like compliance notes', () => {
  const projected = projectProviderLoopConfig([
    {
      id: 'secret-provider',
      displayName: 'Secret Provider',
      status: 'experimental',
      providerFamily: 'anthropic',
      allowedCredentialSources: ['organization-gateway'],
      gatewayPolicy: 'official-or-organization-managed',
      loopId: 'secret-loop',
      eventFidelity: 'message-level',
      approvalFidelity: 'limited',
      supportsSteer: false,
      supportsInterrupt: true,
      supportsResume: false,
      complianceNotes: ['fake note token=secret000000000000000000000000000000'],
      unsupportedCredentialSources: ['private-proxy'],
    },
  ])

  assert.deepEqual(projected.providers[0]?.complianceNotes, ['fake note token=[redacted]'])
  assert.deepEqual(
    projected.issues.map((issue) => issue.code),
    ['secret-like-value'],
  )
})
