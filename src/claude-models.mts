import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapterHome, debugLog } from './util.mjs'

// Claude Code knows which reasoning efforts each model takes: 'max' only on
// the models built for it, none at all on Haiku. It reports that per model
// when a session starts (Query.supportedModels()). The adapter merges those
// reports into a catalog under adapterHome, so model/list offers each model's
// own levels from the first request after a restart; the App refetches
// model/list only on window focus, and nothing tells it the list changed.
// Until a CLI has reported, and for CLIs too old to report effort support,
// every model keeps the static low...xhigh list.
// App rule: model-efforts

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// What model/list offered before Claude Code reported anything.
export const DEFAULT_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh']

const EFFORT_DESCRIPTIONS: Record<ClaudeEffort, string> = {
  low: 'Fast runtime response',
  medium: 'Balanced runtime response',
  high: 'Deeper runtime response',
  xhigh: 'Extra-high reasoning',
  max: 'Maximum reasoning',
}

export interface ClaudeModel {
  // Claude Code's picker value: 'default', 'opus', 'sonnet[1m]', a full id...
  readonly value: string
  // The model id that value runs on, when Claude Code says.
  readonly resolvedModel: string | null
  readonly displayName: string
  readonly description: string
  // [] when the model takes no effort setting.
  readonly efforts: readonly ClaudeEffort[]
}

let cache: { path: string; models: ClaudeModel[] } | null = null

function catalogPath(): string {
  return join(adapterHome(), 'claude-models.json')
}

export function listClaudeModels(): readonly ClaudeModel[] {
  const path = catalogPath()
  if (cache?.path === path) return cache.models
  let models: ClaudeModel[] = []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { models?: unknown }
    if (Array.isArray(parsed.models)) models = parsed.models.flatMap(storedModel)
  } catch {}
  cache = { path, models }
  return models
}

// `models` is Query.supportedModels(). Rows are merged by value: the CLI adds
// the session's own model when it is not one of its presets, so two sessions
// can report different lists. An empty report, or one in which no model says
// anything about effort (an older CLI), leaves the catalog alone.
export function noteClaudeModels(models: unknown): void {
  if (!Array.isArray(models) || !models.some(reportsEffort)) return
  const reported = models.flatMap(reportedModel)
  if (reported.length === 0) return
  const current = listClaudeModels()
  const next = [...current]
  for (const model of reported) {
    const index = next.findIndex((entry) => entry.value === model.value)
    if (index === -1) next.push(model)
    else next[index] = model
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return
  const path = catalogPath()
  cache = { path, models: next }
  try {
    mkdirSync(adapterHome(), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ models: next }, null, 2)}\n`)
  } catch (error) {
    debugLog('claudeModels.saveFailed', { message: (error as Error).message })
  }
  debugLog('claudeModels.updated', {
    models: next.map((model) => `${model.value}:${model.efforts.join('/') || 'none'}`),
  })
}

// The reported row for a model as the adapter passes it to Claude Code
// (null is Claude Code's own default). A picker value matches first, then the
// model id it resolves to, so a gateway alias pointing at a full model id
// still finds its row. 'sonnet[1m]' falls back to 'sonnet' for its efforts
// when the CLI does not list the 1M variant; the description is then left out
// because it would describe the other variant.
export function reportedClaudeModel(sdkModel: string | null): ClaudeModel | null {
  const models = listClaudeModels()
  if (models.length === 0) return null
  const wanted = (sdkModel ?? 'default').trim().toLowerCase()
  const exact = findModel(models, wanted)
  if (exact) return exact
  const base = wanted.replace(/\[1m\]$/, '')
  if (base === wanted) return null
  const fallback = findModel(models, base)
  return fallback ? { ...fallback, description: '' } : null
}

function findModel(models: readonly ClaudeModel[], wanted: string): ClaudeModel | null {
  const byValue = models.find((model) => model.value.toLowerCase() === wanted)
  if (byValue) return byValue
  const byResolved = models.filter((model) => model.resolvedModel?.toLowerCase() === wanted)
  return byResolved.find((model) => model.value !== 'default') ?? byResolved[0] ?? null
}

export function reasoningEffortOptions(
  efforts: readonly ClaudeEffort[],
): Array<{ reasoningEffort: ClaudeEffort; description: string }> {
  return efforts.map((effort) => ({
    reasoningEffort: effort,
    description: EFFORT_DESCRIPTIONS[effort],
  }))
}

// The configured default when the model takes it, else the closest level below
// it, else the model's lowest. A model without efforts gets 'none', which is
// what Codex reports for a model without reasoning levels.
export function defaultReasoningEffort(
  efforts: readonly ClaudeEffort[],
  preferred: string | null,
): ClaudeEffort | 'none' {
  const lowest = efforts[0]
  if (!lowest) return 'none'
  const rank = EFFORTS.indexOf(preferred as ClaudeEffort)
  if (rank === -1) return efforts.includes('medium') ? 'medium' : lowest
  return efforts.filter((effort) => EFFORTS.indexOf(effort) <= rank).at(-1) ?? lowest
}

function reportsEffort(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const record = entry as Record<string, unknown>
  return record.supportsEffort !== undefined || record.supportedEffortLevels !== undefined
}

// Claude Code leaves both effort fields out on a model that takes no effort.
function reportedModel(entry: unknown): ClaudeModel[] {
  if (!entry || typeof entry !== 'object') return []
  const record = entry as Record<string, unknown>
  return storedModel({
    value: record.value,
    resolvedModel: record.resolvedModel ?? null,
    displayName: record.displayName ?? '',
    description: record.description ?? '',
    efforts: reportedEfforts(record),
  })
}

function reportedEfforts(record: Record<string, unknown>): ClaudeEffort[] {
  const levels = Array.isArray(record.supportedEffortLevels)
    ? EFFORTS.filter((effort) => (record.supportedEffortLevels as unknown[]).includes(effort))
    : []
  if (levels.length > 0) return levels
  return record.supportsEffort === true ? [...DEFAULT_EFFORTS] : []
}

function storedModel(entry: unknown): ClaudeModel[] {
  if (!entry || typeof entry !== 'object') return []
  const record = entry as Record<string, unknown>
  if (typeof record.value !== 'string' || record.value.trim() === '') return []
  if (!Array.isArray(record.efforts)) return []
  return [
    {
      value: record.value,
      resolvedModel:
        typeof record.resolvedModel === 'string' && record.resolvedModel.length > 0
          ? record.resolvedModel
          : null,
      displayName: typeof record.displayName === 'string' ? record.displayName : '',
      description: typeof record.description === 'string' ? record.description : '',
      efforts: EFFORTS.filter((effort) => (record.efforts as unknown[]).includes(effort)),
    },
  ]
}
