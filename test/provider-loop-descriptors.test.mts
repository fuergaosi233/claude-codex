import assert from 'node:assert/strict'
import test from 'node:test'
import {
  credentialSourcesForProjection,
  hasSecretLikeText,
  PROVIDER_LOOP_DESCRIPTORS,
  redactSecretLikeText,
  validateProviderLoopDescriptors,
} from '../src/provider-loop-descriptors.mjs'

test('provider loop descriptors validate existing safe surfaces', () => {
  const issues = validateProviderLoopDescriptors(PROVIDER_LOOP_DESCRIPTORS)

  assert.deepEqual(issues, [])
  assert.deepEqual(
    PROVIDER_LOOP_DESCRIPTORS.map((descriptor) => descriptor.id),
    ['claude-code', 'codex'],
  )
})

test('credential projection excludes unsupported personal-session labels', () => {
  const projected = credentialSourcesForProjection({
    allowedCredentialSources: [
      'user-api-key',
      'personal-session',
      'browser-cookie',
      'organization-gateway',
    ],
  })

  assert.deepEqual(projected, ['user-api-key', 'organization-gateway'])
})

test('descriptor validation rejects unsupported credential sources as supported', () => {
  const issues = validateProviderLoopDescriptors([
    {
      id: 'invalid-provider',
      displayName: 'Invalid Provider',
      status: 'experimental',
      providerFamily: 'anthropic',
      allowedCredentialSources: ['personal-subscription'],
      gatewayPolicy: 'none',
      loopId: 'invalid-loop',
      eventFidelity: 'transcript',
      approvalFidelity: 'none',
      supportsSteer: false,
      supportsInterrupt: false,
      supportsResume: false,
      complianceNotes: ['fake descriptor for validation only'],
      unsupportedCredentialSources: ['personal-subscription'],
    },
  ])

  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['unsupported-credential-source'],
  )
})

test('descriptor validation detects and redacts secret-like values', () => {
  const fakeSecret = 'ANTHROPIC_API_KEY=sk-ant-fake000000000000000000000000000000'
  const issues = validateProviderLoopDescriptors([
    {
      id: 'secret-provider',
      displayName: 'Secret Provider',
      status: 'experimental',
      providerFamily: 'anthropic',
      allowedCredentialSources: ['user-api-key'],
      gatewayPolicy: 'none',
      loopId: 'secret-loop',
      eventFidelity: 'transcript',
      approvalFidelity: 'none',
      supportsSteer: false,
      supportsInterrupt: false,
      supportsResume: false,
      complianceNotes: [`fake note ${fakeSecret}`],
      unsupportedCredentialSources: ['personal-session'],
    },
  ])

  assert.equal(hasSecretLikeText(fakeSecret), true)
  assert.equal(redactSecretLikeText(fakeSecret), 'ANTHROPIC_API_KEY=[redacted]')
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['secret-like-value'],
  )
})
