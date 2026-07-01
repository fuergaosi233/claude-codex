import {
  PROVIDER_LOOP_DESCRIPTORS,
  type ProviderLoopDescriptor,
  redactSecretLikeText,
} from './provider-loop-descriptors.mjs'
import type { RuntimeBackendType } from './runtime-config.mjs'

export type ProviderLoopSelectionSource =
  | 'default'
  | 'environment'
  | 'config'
  | 'legacy-runtime'
  | 'mock'

export interface ProviderLoopSelectionInput {
  readonly providerId?: unknown
  readonly loopId?: unknown
  readonly legacyRuntimeType?: RuntimeBackendType | null
  readonly mock?: boolean
  readonly source?: 'environment' | 'config'
}

export interface ProviderLoopSelectionIssue {
  readonly descriptorId: 'provider-loop-selection'
  readonly field: 'provider' | 'loop'
  readonly code: 'unknown-provider' | 'unknown-loop' | 'provider-loop-mismatch'
  readonly message: string
}

export interface ProviderLoopSelectionResult {
  readonly providerId: string
  readonly loopId: string
  readonly runtimeType: RuntimeBackendType
  readonly source: ProviderLoopSelectionSource
  readonly issues: readonly ProviderLoopSelectionIssue[]
}

const PROVIDER_LOOP_SELECTION_CONFIG_KEYS = [
  'provider_loop_provider',
  'providerLoopProvider',
  'provider_loop_config.providerId',
  'provider_loop_agent_loop',
  'providerLoopAgentLoop',
  'provider_loop_config.loopId',
] as const

export function resolveProviderLoopSelection(
  input: ProviderLoopSelectionInput = {},
  descriptors: readonly ProviderLoopDescriptor[] = PROVIDER_LOOP_DESCRIPTORS,
): ProviderLoopSelectionResult {
  const defaultDescriptor = descriptors[0]
  if (!defaultDescriptor) {
    throw new Error('provider loop descriptors are empty')
  }

  const providerRaw = inputText(input.providerId)
  const loopRaw = inputText(input.loopId)
  const selectedByProvider = providerRaw
    ? descriptors.find((descriptor) => descriptor.id === providerRaw)
    : null
  const selectedByLoop = loopRaw
    ? descriptors.find((descriptor) => descriptor.loopId === loopRaw)
    : null
  const issues = selectionIssues(providerRaw, loopRaw, selectedByProvider, selectedByLoop)
  const descriptor =
    issues.length === 0
      ? (selectedByProvider ?? selectedByLoop ?? defaultDescriptor)
      : defaultDescriptor
  const runtimeType = input.mock
    ? 'mock'
    : (input.legacyRuntimeType ?? runtimeTypeForProviderLoop(descriptor))

  return {
    providerId: descriptor.id,
    loopId: descriptor.loopId,
    runtimeType,
    source: selectionSource(input, providerRaw, loopRaw),
    issues,
  }
}

export function providerLoopSelectionInputFromEnv(
  env: NodeJS.ProcessEnv,
  legacyRuntimeType: RuntimeBackendType | null = null,
): ProviderLoopSelectionInput {
  return {
    providerId: env.CLAUDE_CODEX_PROVIDER,
    loopId: env.CLAUDE_CODEX_AGENT_LOOP,
    legacyRuntimeType,
    mock: env.CLAUDE_CODEX_MOCK === '1',
    source: 'environment',
  }
}

export function providerLoopSelectionInputFromConfig(
  config: Record<string, unknown>,
  legacyRuntimeType: RuntimeBackendType | null = null,
  mock = false,
): ProviderLoopSelectionInput {
  return {
    providerId:
      config.provider_loop_provider ??
      config.providerLoopProvider ??
      config['provider_loop_config.providerId'],
    loopId:
      config.provider_loop_agent_loop ??
      config.providerLoopAgentLoop ??
      config['provider_loop_config.loopId'],
    legacyRuntimeType,
    mock,
    source: 'config',
  }
}

export function hasProviderLoopSelectionInput(input: ProviderLoopSelectionInput): boolean {
  return inputText(input.providerId) !== null || inputText(input.loopId) !== null
}

export function isProviderLoopSelectionConfigKey(key: string): boolean {
  return PROVIDER_LOOP_SELECTION_CONFIG_KEYS.some((candidate) => candidate === key)
}

function inputText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function selectionIssues(
  providerRaw: string | null,
  loopRaw: string | null,
  selectedByProvider: ProviderLoopDescriptor | null | undefined,
  selectedByLoop: ProviderLoopDescriptor | null | undefined,
): readonly ProviderLoopSelectionIssue[] {
  const issues: ProviderLoopSelectionIssue[] = []
  if (providerRaw && !selectedByProvider) {
    issues.push({
      descriptorId: 'provider-loop-selection',
      field: 'provider',
      code: 'unknown-provider',
      message: `unknown provider selection: ${redactSecretLikeText(providerRaw)}`,
    })
  }
  if (loopRaw && !selectedByLoop) {
    issues.push({
      descriptorId: 'provider-loop-selection',
      field: 'loop',
      code: 'unknown-loop',
      message: `unknown agent loop selection: ${redactSecretLikeText(loopRaw)}`,
    })
  }
  if (selectedByProvider && selectedByLoop && selectedByProvider.id !== selectedByLoop.id) {
    issues.push({
      descriptorId: 'provider-loop-selection',
      field: 'loop',
      code: 'provider-loop-mismatch',
      message: `provider ${selectedByProvider.id} does not support agent loop ${selectedByLoop.loopId}`,
    })
  }
  return issues
}

function runtimeTypeForProviderLoop(descriptor: ProviderLoopDescriptor): RuntimeBackendType {
  if (descriptor.id === 'codex' && descriptor.loopId === 'codex-jsonl-proxy') return 'codex-proxy'
  return 'agent-sdk-sidecar'
}

function selectionSource(
  input: ProviderLoopSelectionInput,
  providerRaw: string | null,
  loopRaw: string | null,
): ProviderLoopSelectionSource {
  if (input.mock) return 'mock'
  if (input.legacyRuntimeType) return 'legacy-runtime'
  if (providerRaw || loopRaw) return input.source ?? 'environment'
  return 'default'
}
