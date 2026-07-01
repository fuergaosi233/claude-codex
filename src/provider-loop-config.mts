import {
  type CredentialSource,
  credentialSourcesForProjection,
  type DescriptorValidationIssue,
  PROVIDER_LOOP_DESCRIPTORS,
  type ProviderLoopDescriptorDraft,
  redactSecretLikeText,
  validateProviderLoopDescriptors,
} from './provider-loop-descriptors.mjs'

export interface ProviderLoopConfigProjection {
  readonly id: string
  readonly displayName: string
  readonly status: string
  readonly providerFamily: string
  readonly loopId: string
  readonly eventFidelity: string
  readonly approvalFidelity: string
  readonly supportsSteer: boolean
  readonly supportsInterrupt: boolean
  readonly supportsResume: boolean
  readonly allowedCredentialSources: readonly CredentialSource[]
  readonly gatewayPolicy: string
  readonly complianceNotes: readonly string[]
}

export interface ProviderLoopConfigProjectionResult {
  readonly providers: readonly ProviderLoopConfigProjection[]
  readonly issues: readonly DescriptorValidationIssue[]
}

interface ProjectableProviderLoopDescriptor extends ProviderLoopDescriptorDraft {
  readonly id: string
  readonly displayName: string
  readonly status: string
  readonly providerFamily: string
  readonly gatewayPolicy: string
  readonly loopId: string
  readonly eventFidelity: string
  readonly approvalFidelity: string
  readonly supportsSteer: boolean
  readonly supportsInterrupt: boolean
  readonly supportsResume: boolean
  readonly allowedCredentialSources: readonly string[]
  readonly complianceNotes: readonly string[]
}

export function projectProviderLoopConfig(
  descriptors: readonly ProviderLoopDescriptorDraft[] = PROVIDER_LOOP_DESCRIPTORS,
): ProviderLoopConfigProjectionResult {
  return {
    providers: descriptors.flatMap((descriptor) => projectDescriptor(descriptor)),
    issues: validateProviderLoopDescriptors(descriptors).map(projectValidationIssue),
  }
}

function projectDescriptor(
  descriptor: ProviderLoopDescriptorDraft,
): readonly ProviderLoopConfigProjection[] {
  if (!isProjectableDescriptor(descriptor)) return []
  return [
    {
      id: safeText(descriptor.id),
      displayName: safeText(descriptor.displayName),
      status: safeText(descriptor.status),
      providerFamily: safeText(descriptor.providerFamily),
      loopId: safeText(descriptor.loopId),
      eventFidelity: safeText(descriptor.eventFidelity),
      approvalFidelity: safeText(descriptor.approvalFidelity),
      supportsSteer: descriptor.supportsSteer,
      supportsInterrupt: descriptor.supportsInterrupt,
      supportsResume: descriptor.supportsResume,
      allowedCredentialSources: credentialSourcesForProjection(descriptor),
      gatewayPolicy: safeText(descriptor.gatewayPolicy),
      complianceNotes: descriptor.complianceNotes.map(safeText),
    },
  ]
}

function isProjectableDescriptor(
  descriptor: ProviderLoopDescriptorDraft,
): descriptor is ProjectableProviderLoopDescriptor {
  return (
    typeof descriptor.id === 'string' &&
    typeof descriptor.displayName === 'string' &&
    typeof descriptor.status === 'string' &&
    typeof descriptor.providerFamily === 'string' &&
    typeof descriptor.gatewayPolicy === 'string' &&
    typeof descriptor.loopId === 'string' &&
    typeof descriptor.eventFidelity === 'string' &&
    typeof descriptor.approvalFidelity === 'string' &&
    typeof descriptor.supportsSteer === 'boolean' &&
    typeof descriptor.supportsInterrupt === 'boolean' &&
    typeof descriptor.supportsResume === 'boolean' &&
    Array.isArray(descriptor.allowedCredentialSources) &&
    Array.isArray(descriptor.complianceNotes)
  )
}

function safeText(value: string): string {
  return redactSecretLikeText(value)
}

function projectValidationIssue(issue: DescriptorValidationIssue): DescriptorValidationIssue {
  return {
    descriptorId: safeText(issue.descriptorId),
    field: issue.field,
    code: issue.code,
    message: safeText(issue.message),
  }
}
