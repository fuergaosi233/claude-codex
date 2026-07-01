import {
  APPROVAL_FIDELITY_LEVELS,
  CREDENTIAL_SOURCES,
  type CredentialSource,
  DESCRIPTOR_STATUSES,
  type DescriptorValidationIssue,
  EVENT_FIDELITY_LEVELS,
  GATEWAY_POLICIES,
  PROVIDER_FAMILIES,
  type ProviderLoopDescriptorDraft,
  UNSUPPORTED_CREDENTIAL_SOURCES,
  type UnsupportedCredentialSource,
} from './provider-loop-descriptor-types.mjs'

const STRING_FIELDS = [
  'id',
  'displayName',
  'status',
  'providerFamily',
  'gatewayPolicy',
  'loopId',
  'eventFidelity',
  'approvalFidelity',
] as const

const BOOLEAN_FIELDS = ['supportsSteer', 'supportsInterrupt', 'supportsResume'] as const

type StringField = (typeof STRING_FIELDS)[number]

interface KnownStringCheck {
  readonly field: StringField
  readonly values: ReadonlySet<string>
}

const KNOWN_STRING_CHECKS: readonly KnownStringCheck[] = [
  { field: 'status', values: new Set(DESCRIPTOR_STATUSES) },
  { field: 'providerFamily', values: new Set(PROVIDER_FAMILIES) },
  { field: 'gatewayPolicy', values: new Set(GATEWAY_POLICIES) },
  { field: 'eventFidelity', values: new Set(EVENT_FIDELITY_LEVELS) },
  { field: 'approvalFidelity', values: new Set(APPROVAL_FIDELITY_LEVELS) },
]

const CREDENTIAL_SOURCE_SET: ReadonlySet<string> = new Set(CREDENTIAL_SOURCES)
const UNSUPPORTED_CREDENTIAL_SOURCE_SET: ReadonlySet<string> = new Set(
  UNSUPPORTED_CREDENTIAL_SOURCES,
)

const SECRET_ASSIGNMENT_PATTERN =
  /\b((?:[A-Z0-9_]*_)?(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET))\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi

const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-(?:ant|proj)?-[A-Za-z0-9_-]{8,}/gi,
  /\bgh[opsu]_[A-Za-z0-9_]{8,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
] as const

export function validateProviderLoopDescriptors(
  descriptors: readonly ProviderLoopDescriptorDraft[],
): readonly DescriptorValidationIssue[] {
  return descriptors.flatMap((descriptor) => validateProviderLoopDescriptor(descriptor))
}

export function credentialSourcesForProjection(
  descriptor: Pick<ProviderLoopDescriptorDraft, 'allowedCredentialSources'>,
): readonly CredentialSource[] {
  const projected: CredentialSource[] = []
  for (const source of descriptor.allowedCredentialSources ?? []) {
    if (isCredentialSource(source) && !projected.includes(source)) projected.push(source)
  }
  return projected
}

export function hasSecretLikeText(value: string): boolean {
  if (secretPatternMatches(SECRET_ASSIGNMENT_PATTERN, value)) return true
  return SECRET_VALUE_PATTERNS.some((pattern) => secretPatternMatches(pattern, value))
}

export function redactSecretLikeText(value: string): string {
  let redacted = value.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, keyName: string) => `${keyName}=[redacted]`,
  )
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0
    redacted = redacted.replace(pattern, '[redacted]')
  }
  return redacted
}

function validateProviderLoopDescriptor(
  descriptor: ProviderLoopDescriptorDraft,
): readonly DescriptorValidationIssue[] {
  const descriptorId = descriptorIdForIssue(descriptor)
  const issues: DescriptorValidationIssue[] = []

  for (const field of STRING_FIELDS) {
    const value = descriptor[field]
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({
        descriptorId,
        field,
        code: 'missing-field',
        message: 'required string field is missing',
      })
      continue
    }
    if (hasSecretLikeText(value)) {
      issues.push({
        descriptorId,
        field,
        code: 'secret-like-value',
        message: 'field contains a secret-like value',
      })
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    if (typeof descriptor[field] !== 'boolean') {
      issues.push({
        descriptorId,
        field,
        code: 'invalid-value',
        message: 'required boolean field is invalid',
      })
    }
  }

  for (const check of KNOWN_STRING_CHECKS) {
    const value = descriptor[check.field]
    if (typeof value === 'string' && value.trim() && !check.values.has(value)) {
      issues.push({
        descriptorId,
        field: check.field,
        code: 'invalid-value',
        message: `${value} is not a supported ${check.field} value`,
      })
    }
  }

  validateCredentialSources(descriptorId, descriptor.allowedCredentialSources, issues)
  validateUnsupportedCredentialSources(
    descriptorId,
    descriptor.unsupportedCredentialSources,
    issues,
  )
  validateComplianceNotes(descriptorId, descriptor.complianceNotes, issues)
  return issues
}

function validateCredentialSources(
  descriptorId: string,
  sources: readonly string[] | undefined,
  issues: DescriptorValidationIssue[],
): void {
  if (!sources) {
    issues.push({
      descriptorId,
      field: 'allowedCredentialSources',
      code: 'missing-field',
      message: 'allowed credential sources are missing',
    })
    return
  }
  for (const source of sources) {
    if (isUnsupportedCredentialSource(source)) {
      issues.push({
        descriptorId,
        field: 'allowedCredentialSources',
        code: 'unsupported-credential-source',
        message: `${source} cannot be projected as supported`,
      })
    } else if (!isCredentialSource(source)) {
      issues.push({
        descriptorId,
        field: 'allowedCredentialSources',
        code: 'invalid-value',
        message: `${source} is not a supported credential source label`,
      })
    }
  }
}

function validateUnsupportedCredentialSources(
  descriptorId: string,
  sources: readonly string[] | undefined,
  issues: DescriptorValidationIssue[],
): void {
  if (!sources) {
    issues.push({
      descriptorId,
      field: 'unsupportedCredentialSources',
      code: 'missing-field',
      message: 'unsupported credential sources are missing',
    })
    return
  }
  for (const source of sources) {
    if (!isUnsupportedCredentialSource(source)) {
      issues.push({
        descriptorId,
        field: 'unsupportedCredentialSources',
        code: 'invalid-value',
        message: `${source} is not an unsupported credential source label`,
      })
    }
  }
}

function validateComplianceNotes(
  descriptorId: string,
  notes: readonly string[] | undefined,
  issues: DescriptorValidationIssue[],
): void {
  if (!notes) {
    issues.push({
      descriptorId,
      field: 'complianceNotes',
      code: 'missing-field',
      message: 'compliance notes are missing',
    })
    return
  }
  for (const note of notes) {
    if (hasSecretLikeText(note)) {
      issues.push({
        descriptorId,
        field: 'complianceNotes',
        code: 'secret-like-value',
        message: 'compliance note contains a secret-like value',
      })
    }
  }
}

function descriptorIdForIssue(descriptor: ProviderLoopDescriptorDraft): string {
  return typeof descriptor.id === 'string' && descriptor.id.trim() ? descriptor.id : '<unknown>'
}

function secretPatternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0
  return pattern.test(value)
}

function isCredentialSource(value: string): value is CredentialSource {
  return CREDENTIAL_SOURCE_SET.has(value)
}

function isUnsupportedCredentialSource(value: string): value is UnsupportedCredentialSource {
  return UNSUPPORTED_CREDENTIAL_SOURCE_SET.has(value)
}
