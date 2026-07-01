import {
  type CredentialSource,
  credentialSourcesForProjection,
  type DescriptorValidationIssue,
  PROVIDER_LOOP_DESCRIPTORS,
  type ProviderLoopDescriptorDraft,
  redactSecretLikeText,
  validateProviderLoopDescriptors,
} from './provider-loop-descriptors.mjs'
import {
  type ProviderLoopSelectionInput,
  type ProviderLoopSelectionIssue,
  type ProviderLoopSelectionSource,
  resolveProviderLoopSelection,
} from './provider-loop-selection.mjs'

export type ProviderLoopConfigIssue = DescriptorValidationIssue | ProviderLoopSelectionIssue

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
  readonly selection: ProviderLoopConfigSelection
  readonly issues: readonly ProviderLoopConfigIssue[]
}

export interface ProviderLoopConfigSelection {
  readonly providerId: string
  readonly loopId: string
  readonly runtimeType: string
  readonly source: ProviderLoopSelectionSource
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
  selectionInput: ProviderLoopSelectionInput = {},
): ProviderLoopConfigProjectionResult {
  const selection = resolveProviderLoopSelection(selectionInput)
  return {
    providers: descriptors.flatMap((descriptor) => projectDescriptor(descriptor)),
    selection: {
      providerId: safeText(selection.providerId),
      loopId: safeText(selection.loopId),
      runtimeType: selection.runtimeType,
      source: selection.source,
    },
    issues: [
      ...validateProviderLoopDescriptors(descriptors).map(projectValidationIssue),
      ...selection.issues.map(projectSelectionIssue),
    ],
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

function projectSelectionIssue(issue: ProviderLoopSelectionIssue): ProviderLoopSelectionIssue {
  return {
    descriptorId: 'provider-loop-selection',
    field: issue.field,
    code: issue.code,
    message: safeText(issue.message),
  }
}
