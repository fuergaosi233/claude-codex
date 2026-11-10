import { join } from 'node:path'
import type { ClaudeEffort } from './claude-models.mjs'
import { readTomlFile } from './codex-config.mjs'
import { readText } from './project-instructions.mjs'
import { codexHome } from './util.mjs'

// The three harnesses a chat can run on, picked by the model id in the App's
// model menu:
//   Claude Code        Claude Agent SDK, Claude (and gateway) model ids as is
//   Codex              real `codex app-server`, gpt-* ids, ChatGPT login
//   Codex+AsterGate    real `codex app-server` on a custom Responses provider,
//                      ids `codex-ag:<model>`
// Ids starting with `codex-` already route to the Codex backend
// (isCodexOpenAiModel), so the third family needs no other routing change.

export const AG_MODEL_PREFIX = 'codex-ag:'

export type HarnessKind = 'claude' | 'codex' | 'codex-ag'

// Codex threads run in a real `codex app-server` child instead of one
// `codex exec --json` per turn.
export function nativeCodexEnabled(): boolean {
  const value = (process.env.CLAUDE_CODEX_NATIVE_CODEX ?? '').trim().toLowerCase()
  return value === 'on' || value === '1' || value === 'true'
}

// Model menu labels name the harness ("Codex · GPT-6.1 Sol").
export function harnessLabelsEnabled(): boolean {
  const value = process.env.CLAUDE_CODEX_HARNESS_LABELS
  if (value === '0' || value === 'off') return false
  return value === '1' || value === 'on' || nativeCodexEnabled()
}

export function agProvider(): string {
  return process.env.CLAUDE_CODEX_CODEX_AG_PROVIDER?.trim() || 'astergate_claude'
}

export function isAgModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith(AG_MODEL_PREFIX)
}

// The Codex model provider a Codex thread on `model` runs on.
export function codexProviderForModel(model: string | null | undefined): string {
  return isAgModel(model) ? agProvider() : 'openai'
}

// The id the real codex knows the model by.
export function bareCodexModel(model: string): string {
  return isAgModel(model) ? model.slice(AG_MODEL_PREFIX.length) : model
}

export function harnessOfModel(model: string, codexBackend: boolean): HarnessKind {
  if (!codexBackend) return 'claude'
  return isAgModel(model) ? 'codex-ag' : 'codex'
}

export const HARNESS_LABELS: Record<HarnessKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  'codex-ag': 'Codex+AsterGate',
}

export function harnessDisplayName(kind: HarnessKind, name: string): string {
  return `${HARNESS_LABELS[kind]} · ${name}`
}

interface CatalogModel {
  readonly slug: string
  readonly displayName: string | null
  readonly description: string | null
  readonly efforts: readonly ClaudeEffort[]
}

const KNOWN_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

let catalogCache: { key: string; models: CatalogModel[] } | null = null

// The model catalog the real codex uses: config.toml's model_catalog_json,
// else $CODEX_HOME/model_catalog.json. Empty when there is none.
export function codexCatalogModels(): CatalogModel[] {
  const config = readTomlFile(join(codexHome(), 'config.toml'))
  const configured = typeof config?.model_catalog_json === 'string' ? config.model_catalog_json : ''
  const path = configured || join(codexHome(), 'model_catalog.json')
  const text = readText(path)
  const key = `${path}:${text?.length ?? -1}:${text?.slice(0, 64) ?? ''}`
  if (catalogCache?.key === key) return catalogCache.models
  let models: CatalogModel[] = []
  try {
    const parsed = text ? JSON.parse(text) : null
    const entries: unknown[] = Array.isArray(parsed?.models) ? parsed.models : []
    models = entries.flatMap((raw) => {
      const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const slug = typeof entry.slug === 'string' ? entry.slug : ''
      if (!slug || entry.visibility === 'hide') return []
      const levels = Array.isArray(entry.supported_reasoning_levels)
        ? entry.supported_reasoning_levels
        : []
      const efforts = KNOWN_EFFORTS.filter((effort) =>
        levels.some((level) => level && typeof level === 'object' && level.effort === effort),
      )
      return [
        {
          slug,
          displayName: typeof entry.display_name === 'string' ? entry.display_name : null,
          description: typeof entry.description === 'string' ? entry.description : null,
          efforts,
        },
      ]
    })
  } catch {
    models = []
  }
  catalogCache = { key, models }
  return models
}

export function catalogModel(slug: string): CatalogModel | null {
  return codexCatalogModels().find((model) => model.slug === slug) ?? null
}

function envList(name: string): string[] | null {
  const raw = process.env[name]
  if (!raw?.trim()) return null
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

// The Codex+AsterGate entries of the model menu: CLAUDE_CODEX_CODEX_AG_MODELS,
// else every catalog model that is not an OpenAI one. Only with the native
// Codex harness, which can run a thread on another provider.
export function agModelOptions(): Array<{
  id: string
  sdkModel: string | null
  displayName: string
  description: string
  isDefault?: boolean
}> {
  if (!nativeCodexEnabled()) return []
  const ids =
    envList('CLAUDE_CODEX_CODEX_AG_MODELS') ??
    codexCatalogModels()
      .map((model) => model.slug)
      .filter((slug) => !/^gpt[-_]/.test(slug) && !/^o[0-9]/.test(slug))
  return ids.map((slug) => {
    const entry = catalogModel(slug)
    return {
      id: `${AG_MODEL_PREFIX}${slug}`,
      sdkModel: slug,
      displayName: harnessDisplayName('codex-ag', entry?.displayName ?? slug),
      description: `${entry?.description ?? slug} Runs in Codex on the ${agProvider()} provider.`,
      isDefault: false,
    }
  })
}

// The efforts the catalog gives a Codex model, null when it has none.
export function codexModelEfforts(model: string): readonly ClaudeEffort[] | null {
  const entry = catalogModel(bareCodexModel(model))
  return entry && entry.efforts.length > 0 ? entry.efforts : null
}
