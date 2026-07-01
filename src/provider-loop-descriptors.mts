export {
  credentialSourcesForProjection,
  hasSecretLikeText,
  redactSecretLikeText,
  validateProviderLoopDescriptors,
} from './provider-loop-descriptor-schema.mjs'
export type {
  CredentialSource,
  DescriptorValidationIssue,
  ProviderLoopDescriptor,
  ProviderLoopDescriptorDraft,
  UnsupportedCredentialSource,
} from './provider-loop-descriptor-types.mjs'
export {
  CREDENTIAL_SOURCES,
  DESCRIPTOR_STATUSES,
  EVENT_FIDELITY_LEVELS,
  GATEWAY_POLICIES,
  PROVIDER_FAMILIES,
  UNSUPPORTED_CREDENTIAL_SOURCES,
} from './provider-loop-descriptor-types.mjs'

import {
  type ProviderLoopDescriptor,
  UNSUPPORTED_CREDENTIAL_SOURCES,
} from './provider-loop-descriptor-types.mjs'

export const PROVIDER_LOOP_DESCRIPTORS = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    status: 'stable',
    providerFamily: 'anthropic',
    allowedCredentialSources: [
      'user-api-key',
      'cloud-provider',
      'organization-gateway',
      'local-cli-auth',
    ],
    gatewayPolicy: 'official-or-organization-managed',
    loopId: 'native-claude-code-sdk',
    eventFidelity: 'rich',
    approvalFidelity: 'native-file-diff',
    supportsSteer: true,
    supportsInterrupt: true,
    supportsResume: true,
    complianceNotes: [
      'Credentials stay on the user host, cloud provider chain, or organization gateway.',
      'Local CLI auth is local-only and not a productized credential distribution model.',
    ],
    unsupportedCredentialSources: UNSUPPORTED_CREDENTIAL_SOURCES,
  },
  {
    id: 'codex',
    displayName: 'Codex proxy',
    status: 'stable',
    providerFamily: 'openai',
    allowedCredentialSources: ['local-cli-auth'],
    gatewayPolicy: 'none',
    loopId: 'codex-jsonl-proxy',
    eventFidelity: 'jsonl',
    approvalFidelity: 'native-codex',
    supportsSteer: false,
    supportsInterrupt: true,
    supportsResume: true,
    complianceNotes: [
      'Auth remains owned by the local Codex CLI on the user host.',
      'The adapter does not collect or redistribute Codex subscription/session credentials.',
    ],
    unsupportedCredentialSources: UNSUPPORTED_CREDENTIAL_SOURCES,
  },
] as const satisfies readonly ProviderLoopDescriptor[]
