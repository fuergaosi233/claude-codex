// Dynamic tools: tools a client registers on thread/start for the model to
// call. Codex answers a call with the `item/tool/call` server request and
// records it as a `dynamicToolCall` item; the client runs the tool and sends
// back content items. The Codex App registers its own tools this way (the
// codex_app namespace: worktrees, artifacts and the like) on remote hosts.
//
// The adapter offers them to Claude as in-process MCP servers, one per
// namespace, when CLAUDE_CODEX_DYNAMIC_TOOLS=1. The helpers below read and
// check the specs as Codex does, and translate the client's answers.

import type {
  DynamicToolCallResponse,
  DynamicToolContentItem,
  DynamicToolFunctionSpec,
  DynamicToolServer,
  DynamicToolSpec,
} from './types.mjs'
import { debugLog } from './util.mjs'

// Off by default: the App's tools act on the user's desktop.
export function dynamicToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODEX_DYNAMIC_TOOLS === '1'
}

// The MCP server for tools registered without a namespace.
export const DYNAMIC_TOOLS_SERVER = 'dynamic_tools'

// Codex's answers for a call that went wrong. Claude reads them as the
// tool's result.
export const DYNAMIC_TOOL_REQUEST_FAILED = 'dynamic tool request failed'
export const DYNAMIC_TOOL_CANCELLED = 'dynamic tool call was cancelled before receiving a response'
const INVALID_RESPONSE = 'dynamic tool response was invalid'
const REMOTE_IMAGE_URL_ERROR = 'remote image URLs are not supported; use an inline data URL instead'
const INVALID_AUDIO_URL_ERROR = 'audio URLs must use an inline data URL'

// Codex's limits, set by the Responses API.
const NAME_MAX = 128
const NAMESPACE_MAX = 64
const NAMESPACE_DESCRIPTION_MAX = 1024
const IDENTIFIER_PATTERN = '^[a-zA-Z0-9_-]+$'
const IDENTIFIER = /^[a-zA-Z0-9_-]+$/
const RESERVED_NAMESPACES = new Set([
  'api_tool',
  'browser',
  'computer',
  'container',
  'file_search',
  'functions',
  'image_gen',
  'multi_tool_use',
  'python',
  'python_user_visible',
  'submodel_delegator',
  'terminal',
  'tool_search',
  'web',
])

// Claude's API takes tool names of at most 64 characters, and Claude Code
// names an MCP tool mcp__<server>__<tool>.
const CLAUDE_TOOL_NAME_MAX = 64

// Images Claude reads inline.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

// thread/start's dynamicTools, in Codex's canonical form. Like Codex, it
// takes the older flat form too ({namespace, name, description, inputSchema,
// deferLoading, exposeToContext}, grouped by namespace), and throws on specs
// Codex would reject.
export function parseDynamicTools(value: unknown): DynamicToolSpec[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('dynamicTools must be an array')
  const specs = normalizeSpecs(value)
  validateSpecs(specs)
  return specs
}

// The MCP servers Claude gets for a thread's tools: one per namespace, and
// one for the tools without a namespace. A tool whose full name would pass
// Claude's limit is left out.
export function dynamicToolServers(specs: readonly DynamicToolSpec[]): DynamicToolServer[] {
  const groups: Array<{
    server: string
    namespace: string | null
    description: string
    tools: DynamicToolFunctionSpec[]
  }> = []
  const loose: DynamicToolFunctionSpec[] = []
  for (const spec of specs) {
    if (spec.type === 'function') loose.push(spec)
    else
      groups.push({
        server: spec.name,
        namespace: spec.name,
        description: spec.description,
        tools: spec.tools,
      })
  }
  if (loose.length > 0) {
    if (groups.some((group) => group.server === DYNAMIC_TOOLS_SERVER))
      debugLog('dynamicTools.skipped', { server: DYNAMIC_TOOLS_SERVER, reason: 'namespace' })
    else
      groups.push({ server: DYNAMIC_TOOLS_SERVER, namespace: null, description: '', tools: loose })
  }
  const servers: DynamicToolServer[] = []
  for (const group of groups) {
    const tools: DynamicToolServer['tools'] = []
    for (const tool of group.tools) {
      if (`mcp__${group.server}__${tool.name}`.length > CLAUDE_TOOL_NAME_MAX) {
        debugLog('dynamicTools.skipped', { server: group.server, tool: tool.name, reason: 'name' })
        continue
      }
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: toolInputSchema(tool.inputSchema),
        deferLoading: tool.deferLoading === true,
      })
    }
    if (tools.length > 0)
      servers.push({
        server: group.server,
        namespace: group.namespace,
        description: group.description,
        tools,
      })
  }
  return servers
}

// The client's item/tool/call answer, checked as Codex checks it: a malformed
// answer, a remote image URL or an audio URL that is not inline becomes a
// failed call with a message.
export function dynamicToolResponse(value: unknown): DynamicToolCallResponse {
  if (!isRecord(value) || !Array.isArray(value.contentItems) || typeof value.success !== 'boolean')
    return dynamicToolFailure(INVALID_RESPONSE)
  const contentItems: DynamicToolContentItem[] = []
  for (const raw of value.contentItems) {
    const item = contentItem(raw)
    if (!item) return dynamicToolFailure(INVALID_RESPONSE)
    contentItems.push(item)
  }
  if (contentItems.some((item) => item.type === 'inputImage' && isRemoteUrl(item.imageUrl)))
    return dynamicToolFailure(REMOTE_IMAGE_URL_ERROR)
  if (
    contentItems.some(
      (item) => item.type === 'inputAudio' && item.audioUrl.slice(0, 5).toLowerCase() !== 'data:',
    )
  )
    return dynamicToolFailure(INVALID_AUDIO_URL_ERROR)
  return { contentItems, success: value.success }
}

export function dynamicToolFailure(text: string): DynamicToolCallResponse {
  return { contentItems: [{ type: 'inputText', text }], success: false }
}

export type DynamicToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

// An answer as the MCP tool result Claude reads. Claude takes no audio, and
// only inline images of the kinds its API reads.
export function dynamicToolCallResult(response: DynamicToolCallResponse): {
  content: DynamicToolResultContent[]
  isError?: boolean
} {
  const content = response.contentItems.map((item): DynamicToolResultContent => {
    if (item.type === 'inputText') return { type: 'text', text: item.text }
    if (item.type === 'inputAudio') return { type: 'text', text: '[audio omitted]' }
    const image = inlineImage(item.imageUrl)
    return image ? { type: 'image', ...image } : { type: 'text', text: '[image omitted]' }
  })
  return response.success ? { content } : { content, isError: true }
}

function normalizeSpecs(values: unknown[]): DynamicToolSpec[] {
  const hasLegacyFields = (value: unknown) => {
    const spec = recordOf(value)
    return 'namespace' in spec || 'exposeToContext' in spec || !('type' in spec)
  }
  const legacy = values.some((value) => {
    const tools = recordOf(value).tools
    return hasLegacyFields(value) || (Array.isArray(tools) && tools.some(hasLegacyFields))
  })
  const canonical = values.some((value) => 'type' in recordOf(value))
  if (legacy && canonical)
    throw new Error('dynamic tools must use either canonical or legacy format consistently')
  if (!legacy) return values.map(canonicalSpec)
  // The flat form: tools of one namespace go together, in first-seen order.
  const specs: DynamicToolSpec[] = []
  const namespaces = new Map<string, DynamicToolFunctionSpec[]>()
  for (const value of values) {
    const spec = recordOf(value)
    const namespace = spec.namespace == null ? null : stringField(spec, 'namespace')
    const expose = spec.exposeToContext == null ? null : booleanField(spec, 'exposeToContext')
    const defer =
      spec.deferLoading == null ? expose === false : booleanField(spec, 'deferLoading') === true
    const tool = functionSpec({ ...spec, deferLoading: defer })
    if (namespace == null) {
      specs.push(tool)
      continue
    }
    const tools = namespaces.get(namespace)
    if (tools) {
      tools.push(tool)
      continue
    }
    const grouped = [tool]
    namespaces.set(namespace, grouped)
    specs.push({ type: 'namespace', name: namespace, description: '', tools: grouped })
  }
  return specs
}

function canonicalSpec(value: unknown): DynamicToolSpec {
  const spec = recordOf(value)
  if (spec.type === 'function') return functionSpec(spec)
  if (spec.type !== 'namespace') throw new Error(`unknown dynamic tool type: ${String(spec.type)}`)
  if (!Array.isArray(spec.tools)) throw new Error('dynamic tool namespace tools must be an array')
  return {
    type: 'namespace',
    name: stringField(spec, 'name'),
    description: stringField(spec, 'description'),
    tools: spec.tools.map((tool) => {
      const fn = recordOf(tool)
      if (fn.type !== 'function') throw new Error(`unknown dynamic tool type: ${String(fn.type)}`)
      return functionSpec(fn)
    }),
  }
}

function functionSpec(spec: Record<string, unknown>): DynamicToolFunctionSpec {
  if (!('inputSchema' in spec)) throw new Error('dynamic tool is missing inputSchema')
  const defer = spec.deferLoading == null ? false : booleanField(spec, 'deferLoading')
  return {
    type: 'function',
    name: stringField(spec, 'name'),
    description: stringField(spec, 'description'),
    inputSchema: spec.inputSchema,
    ...(defer ? { deferLoading: true } : {}),
  }
}

// Codex's validate_dynamic_tools, with its messages.
function validateSpecs(specs: readonly DynamicToolSpec[]): void {
  const seenTools = new Set<string>()
  const seenNamespaces = new Set<string>()
  for (const spec of specs) {
    if (spec.type === 'function') {
      validateFunction(spec, null, seenTools)
      continue
    }
    const name = spec.name.trim()
    if (!name) throw new Error('dynamic tool namespace must not be empty')
    if (name !== spec.name)
      throw new Error(
        `dynamic tool namespace has leading/trailing whitespace: ${escaped(spec.name)}`,
      )
    validateIdentifier(name, 'dynamic tool namespace', NAMESPACE_MAX)
    if ([...spec.description].length > NAMESPACE_DESCRIPTION_MAX)
      throw new Error(
        `dynamic tool namespace description must be at most ${NAMESPACE_DESCRIPTION_MAX} characters`,
      )
    if (name === 'mcp' || name.startsWith('mcp__'))
      throw new Error(`dynamic tool namespace is reserved: ${name}`)
    if (RESERVED_NAMESPACES.has(name))
      throw new Error(
        `dynamic tool namespace collides with a reserved Responses API namespace: ${name}`,
      )
    if (seenNamespaces.has(name)) throw new Error(`duplicate dynamic tool namespace: ${name}`)
    seenNamespaces.add(name)
    if (spec.tools.length === 0)
      throw new Error(`dynamic tool namespace must contain at least one tool: ${name}`)
    const seenNamespaceTools = new Set<string>()
    for (const tool of spec.tools) validateFunction(tool, name, seenNamespaceTools)
  }
}

function validateFunction(
  tool: DynamicToolFunctionSpec,
  namespace: string | null,
  seen: Set<string>,
): void {
  const name = tool.name.trim()
  if (!name) throw new Error('dynamic tool name must not be empty')
  if (name !== tool.name)
    throw new Error(`dynamic tool name has leading/trailing whitespace: ${escaped(tool.name)}`)
  validateIdentifier(name, 'dynamic tool name', NAME_MAX)
  if (name === 'mcp' || name.startsWith('mcp__'))
    throw new Error(`dynamic tool name is reserved: ${name}`)
  if (seen.has(name))
    throw new Error(
      namespace == null
        ? `duplicate dynamic tool name: ${name}`
        : `duplicate dynamic tool name in namespace ${namespace}: ${name}`,
    )
  seen.add(name)
  if (tool.deferLoading && namespace == null)
    throw new Error(`deferred dynamic tool must include a namespace: ${name}`)
  const schemaError = inputSchemaError(tool.inputSchema)
  if (schemaError)
    throw new Error(`dynamic tool input schema is not supported for ${name}: ${schemaError}`)
}

function validateIdentifier(value: string, label: string, max: number): void {
  if (!IDENTIFIER.test(value))
    throw new Error(
      `${label} must match ${IDENTIFIER_PATTERN} to match Responses API: ${escaped(value)}`,
    )
  if ([...value].length > max)
    throw new Error(
      `${label} must be at most ${max} characters to match Responses API: ${escaped(value)}`,
    )
}

// Claude's MCP tools take an object. Codex fills in a missing type the same
// way.
function inputSchemaError(schema: unknown): string | null {
  if (!isRecord(schema)) return 'the input schema must be a JSON object'
  if (schema.type !== undefined && schema.type !== 'object')
    return `the input schema must describe an object, not ${JSON.stringify(schema.type)}`
  return null
}

// The schema as the MCP server lists it. The SDK declares its own JSON
// Schema draft, and Claude Code refuses some others.
function toolInputSchema(schema: unknown): Record<string, unknown> {
  const { $schema: _draft, $id: _uri, id: _legacyId, ...rest } = recordOf(schema)
  return { ...rest, type: 'object' }
}

function contentItem(value: unknown): DynamicToolContentItem | null {
  if (!isRecord(value)) return null
  if (value.type === 'inputText' && typeof value.text === 'string')
    return { type: 'inputText', text: value.text }
  if (value.type === 'inputImage' && typeof value.imageUrl === 'string')
    return { type: 'inputImage', imageUrl: value.imageUrl }
  if (value.type === 'inputAudio' && typeof value.audioUrl === 'string')
    return { type: 'inputAudio', audioUrl: value.audioUrl }
  return null
}

function isRemoteUrl(url: string): boolean {
  const colon = url.indexOf(':')
  if (colon < 0) return false
  const scheme = url.slice(0, colon).toLowerCase()
  return scheme === 'http' || scheme === 'https'
}

function inlineImage(url: string): { data: string; mimeType: string } | null {
  const match = url.match(/^data:([^;,]+)((?:;[^;,]*)*),(.*)$/s)
  if (!match) return null
  const mimeType = (match[1] ?? '').toLowerCase()
  const base64 = (match[2] ?? '').split(';').includes('base64')
  if (!base64 || !IMAGE_TYPES.has(mimeType)) return null
  return { data: match[3] ?? '', mimeType }
}

function stringField(spec: Record<string, unknown>, field: string): string {
  const value = spec[field]
  if (typeof value !== 'string') throw new Error(`dynamic tool ${field} must be a string`)
  return value
}

function booleanField(spec: Record<string, unknown>, field: string): boolean {
  const value = spec[field]
  if (typeof value !== 'boolean') throw new Error(`dynamic tool ${field} must be a boolean`)
  return value
}

// Rust's escape_default, near enough for an error message.
function escaped(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}
