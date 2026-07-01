export const CREDENTIAL_SOURCES = [
  'user-api-key',
  'cloud-provider',
  'organization-gateway',
  'local-cli-auth',
] as const

export const UNSUPPORTED_CREDENTIAL_SOURCES = [
  'personal-subscription',
  'personal-session',
  'browser-cookie',
  'oauth-session',
  'cli-session-export',
  'credential-sharing',
  'private-proxy',
  'provider-bypass',
] as const

export const DESCRIPTOR_STATUSES = ['stable', 'experimental'] as const
export const PROVIDER_FAMILIES = ['anthropic', 'openai'] as const
export const GATEWAY_POLICIES = ['none', 'official-or-organization-managed'] as const
export const EVENT_FIDELITY_LEVELS = ['rich', 'jsonl', 'message-level', 'transcript'] as const
export const APPROVAL_FIDELITY_LEVELS = [
  'native-file-diff',
  'native-codex',
  'limited',
  'none',
] as const

type DescriptorStatus = (typeof DESCRIPTOR_STATUSES)[number]
type ProviderFamily = (typeof PROVIDER_FAMILIES)[number]
type GatewayPolicy = (typeof GATEWAY_POLICIES)[number]
type EventFidelity = (typeof EVENT_FIDELITY_LEVELS)[number]
type ApprovalFidelity = (typeof APPROVAL_FIDELITY_LEVELS)[number]

export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number]
export type UnsupportedCredentialSource = (typeof UNSUPPORTED_CREDENTIAL_SOURCES)[number]

export interface ProviderLoopDescriptor {
  readonly id: string
  readonly displayName: string
  readonly status: DescriptorStatus
  readonly providerFamily: ProviderFamily
  readonly allowedCredentialSources: readonly CredentialSource[]
  readonly gatewayPolicy: GatewayPolicy
  readonly loopId: string
  readonly eventFidelity: EventFidelity
  readonly approvalFidelity: ApprovalFidelity
  readonly supportsSteer: boolean
  readonly supportsInterrupt: boolean
  readonly supportsResume: boolean
  readonly complianceNotes: readonly string[]
  readonly unsupportedCredentialSources: readonly UnsupportedCredentialSource[]
}

export interface ProviderLoopDescriptorDraft {
  readonly id?: unknown
  readonly displayName?: unknown
  readonly status?: unknown
  readonly providerFamily?: unknown
  readonly allowedCredentialSources?: readonly string[]
  readonly gatewayPolicy?: unknown
  readonly loopId?: unknown
  readonly eventFidelity?: unknown
  readonly approvalFidelity?: unknown
  readonly supportsSteer?: unknown
  readonly supportsInterrupt?: unknown
  readonly supportsResume?: unknown
  readonly complianceNotes?: readonly string[]
  readonly unsupportedCredentialSources?: readonly string[]
}

export interface DescriptorValidationIssue {
  readonly descriptorId: string
  readonly field: string
  readonly code:
    | 'missing-field'
    | 'invalid-value'
    | 'unsupported-credential-source'
    | 'secret-like-value'
  readonly message: string
}
