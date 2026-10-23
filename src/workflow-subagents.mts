import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import {
  clipText,
  collapseWhitespace,
  firstPromptLine,
  isRelayedUserRequest,
  SUBAGENT_NAME_MAX_CHARS,
  workflowAgentPrompt,
} from './subagent-presentation.mjs'
import { isPathInside } from './util.mjs'

export interface WorkflowLaunchInfo {
  taskId: string
  runId: string
  transcriptDir: string
  transcriptRoot: string
  workflowName: string
  summary: string
}

export interface WorkflowJournalAgentStart {
  agentId: string
  prompt: string
  description: string
}

export interface WorkflowJournalAgentResult {
  agentId: string
  content: string
  isError: boolean
}

interface WorkflowJournalMonitorOptions {
  launch: WorkflowLaunchInfo
  pollIntervalMs?: number
  onStarted: (agent: WorkflowJournalAgentStart) => Promise<void>
  onResult: (agent: WorkflowJournalAgentResult) => Promise<void>
  onError?: (error: Error) => Promise<void> | void
}

interface WorkflowJournalEntry {
  type: 'started' | 'result'
  agentId: string
  result?: unknown
  // The name the workflow script gave the agent (its `label`), which the CLI
  // writes on the agent's started line: the script's own label, else one it
  // makes from the prompt.
  label?: string
}

const MAX_WORKFLOW_JOURNAL_BYTES = 8 * 1024 * 1024
const MAX_WORKFLOW_AGENT_TRANSCRIPT_BYTES = 4 * 1024 * 1024
const WORKFLOW_DRAIN_SETTLE_MS = 500

export function defaultWorkflowTranscriptRoots(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string[] {
  const configuredRoot = stringValue(env.CLAUDE_CONFIG_DIR)
  const home = stringValue(env.HOME) || homedir()
  return [resolve(cwd, configuredRoot || join(home, '.claude'))]
}

export function parseWorkflowLaunchInfo(
  value: unknown,
  transcriptRoots: string[] = defaultWorkflowTranscriptRoots(),
): WorkflowLaunchInfo | null {
  const launch = recordOrNull(value)
  if (!launch) return null
  if (launch.taskType == null) launch.taskType = launch.task_type
  if (launch.taskType == null) launch.taskType = 'local_workflow'
  if (launch.taskType === 'workflow') launch.taskType = 'local_workflow'
  if (launch.taskId == null) launch.taskId = launch.task_id
  if (launch.runId == null) launch.runId = launch.run_id
  if (launch.transcriptDir == null) launch.transcriptDir = launch.transcript_dir
  if (launch.workflowName == null) launch.workflowName = launch.workflow_name
  if (String(launch.status ?? '') !== 'async_launched') return null
  if (String(launch.taskType ?? '') !== 'local_workflow') return null

  const taskId = stringValue(launch.taskId)
  const runId = stringValue(launch.runId)
  const transcriptDir = stringValue(launch.transcriptDir)
  const normalizedTranscriptDir = normalize(transcriptDir)
  const transcriptRoot = trustedTranscriptRoot(normalizedTranscriptDir, transcriptRoots)
  if (
    !taskId ||
    !runId ||
    !transcriptDir ||
    !isWorkflowTranscriptDir(normalizedTranscriptDir, runId) ||
    !transcriptRoot
  ) {
    return null
  }

  return {
    taskId,
    runId,
    transcriptDir: normalizedTranscriptDir,
    transcriptRoot,
    workflowName: stringValue(launch.workflowName ?? launch.workflow_name),
    summary: stringValue(launch.summary),
  }
}

export class WorkflowJournalMonitor {
  private readonly launch: WorkflowLaunchInfo
  private readonly pollIntervalMs: number
  private readonly onStarted: WorkflowJournalMonitorOptions['onStarted']
  private readonly onResult: WorkflowJournalMonitorOptions['onResult']
  private readonly onError: WorkflowJournalMonitorOptions['onError']
  private readonly startedAgentIds = new Set<string>()
  private readonly completedAgentIds = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private pollPromise: Promise<void> | null = null
  private verifiedTranscriptDir: string | null = null
  private failure: Error | null = null
  private generation = 0
  private stopped = false

  constructor(options: WorkflowJournalMonitorOptions) {
    this.launch = options.launch
    this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 100)
    this.onStarted = options.onStarted
    this.onResult = options.onResult
    this.onError = options.onError
  }

  start(): void {
    if (this.stopped || this.timer) return
    this.timer = setInterval(() => {
      void this.flush()
    }, this.pollIntervalMs)
    this.timer.unref()
    void this.flush()
  }

  async flush(): Promise<void> {
    if (this.stopped || this.failure) return
    if (this.pollPromise) return this.pollPromise
    const generation = this.generation
    this.pollPromise = this.pollOnce(generation)
      .catch(async (error: unknown) => {
        this.fail(error)
        const failure = this.failure
        if (failure && this.onError) {
          // Monitoring runs from an unref'd interval. Never let a failure in
          // the cleanup callback become an unhandled rejection that leaves the
          // parent runtime promise pending as well.
          try {
            await this.onError(failure)
          } catch {}
        }
      })
      .finally(() => {
        this.pollPromise = null
      })
    return this.pollPromise
  }

  async drain(timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    let stableSince = Date.now()
    let lastStarted = this.startedAgentIds.size
    let lastCompleted = this.completedAgentIds.size
    while (Date.now() <= deadline) {
      const remaining = Math.max(0, deadline - Date.now())
      if (!(await settlesWithin(this.flush(), remaining))) return
      if (this.stopped || this.failure) return
      const now = Date.now()
      const started = this.startedAgentIds.size
      const completed = this.completedAgentIds.size
      if (started !== lastStarted || completed !== lastCompleted) {
        lastStarted = started
        lastCompleted = completed
        stableSince = now
      }
      if (started > 0 && completed >= started && now - stableSince >= WORKFLOW_DRAIN_SETTLE_MS) {
        return
      }
      if (now >= deadline) return
      await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - now)))
    }
  }

  async stop(timeoutMs = 500): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopped = true
    this.generation += 1
    if (this.pollPromise) {
      await settlesWithin(this.pollPromise, Math.max(0, timeoutMs))
    }
  }

  get startedCount(): number {
    return this.startedAgentIds.size
  }

  activeAgentIds(): string[] {
    return [...this.startedAgentIds].filter((agentId) => !this.completedAgentIds.has(agentId))
  }

  private async pollOnce(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return
    const transcriptDir = await this.resolveTranscriptDir()
    if (!transcriptDir || !this.isCurrent(generation)) return
    const entries = await readJournalEntries(join(transcriptDir, 'journal.jsonl'), transcriptDir)
    if (!this.isCurrent(generation)) return
    const labels = new Map<string, string>()
    for (const entry of entries) {
      if (entry.type === 'started' && entry.label && !labels.has(entry.agentId))
        labels.set(entry.agentId, entry.label)
    }
    for (const entry of entries) {
      if (!this.isCurrent(generation)) return
      const started = await this.ensureStarted(
        transcriptDir,
        entry.agentId,
        generation,
        labels.get(entry.agentId),
      )
      if (!this.isCurrent(generation)) return
      if (!started) continue
      if (entry.type !== 'result' || this.completedAgentIds.has(entry.agentId)) continue
      const result = await workflowAgentResult(transcriptDir, entry.agentId, entry.result)
      if (!result || !this.isCurrent(generation)) continue
      await this.onResult(result)
      if (!this.isCurrent(generation)) return
      this.completedAgentIds.add(entry.agentId)
    }
  }

  private async ensureStarted(
    transcriptDir: string,
    agentId: string,
    generation: number,
    label: string | undefined,
  ): Promise<boolean> {
    if (this.startedAgentIds.has(agentId)) return true
    const prompt = await readAgentPrompt(transcriptDir, agentId)
    if (!prompt || !this.isCurrent(generation)) return false
    await this.onStarted({
      agentId,
      prompt,
      description: workflowAgentDescription(prompt, agentId, label),
    })
    if (!this.isCurrent(generation)) return false
    this.startedAgentIds.add(agentId)
    return true
  }

  private async resolveTranscriptDir(): Promise<string | null> {
    if (this.verifiedTranscriptDir) return this.verifiedTranscriptDir
    let transcriptRoot: string
    let transcriptDir: string
    try {
      ;[transcriptRoot, transcriptDir] = await Promise.all([
        realpath(this.launch.transcriptRoot),
        realpath(this.launch.transcriptDir),
      ])
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
    if (
      !isPathInside(transcriptRoot, transcriptDir) ||
      !isWorkflowTranscriptDir(transcriptDir, this.launch.runId)
    ) {
      throw new Error('Workflow transcript directory is outside the trusted Claude config root')
    }
    this.verifiedTranscriptDir = transcriptDir
    return transcriptDir
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error))
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopped = true
    this.generation += 1
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && !this.failure && this.generation === generation
  }
}

function isWorkflowTranscriptDir(path: string, runId: string): boolean {
  if (!isAbsolute(path) || basename(normalize(path)) !== runId) return false
  const parts = normalize(path).split(sep).filter(Boolean)
  const workflowIndex = parts.lastIndexOf('workflows')
  return (
    workflowIndex > 0 &&
    workflowIndex === parts.length - 2 &&
    parts[workflowIndex - 1] === 'subagents'
  )
}

function trustedTranscriptRoot(path: string, roots: string[]): string | null {
  if (!isAbsolute(path)) return null
  const normalizedRoots = roots
    .map((root) => stringValue(root))
    .filter(Boolean)
    .map((root) => resolve(root))
    .sort((left, right) => right.length - left.length)
  return normalizedRoots.find((root) => isPathInside(root, path)) ?? null
}

async function readJournalEntries(
  path: string,
  transcriptDir: string,
): Promise<WorkflowJournalEntry[]> {
  const text = await readRegularTextFile(path, transcriptDir, MAX_WORKFLOW_JOURNAL_BYTES)
  if (text === null) return []

  const entries: WorkflowJournalEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const entry = recordOrNull(parsed)
    if (!entry) continue
    const type = String(entry.type ?? '')
    const agentId = stringValue(entry.agentId)
    if ((type !== 'started' && type !== 'result') || !isWorkflowAgentId(agentId)) continue
    const label = type === 'started' ? collapseWhitespace(stringValue(entry.label)) : ''
    entries.push({
      type,
      agentId,
      ...(type === 'result' ? { result: entry.result } : {}),
      ...(label ? { label } : {}),
    })
  }
  return entries
}

async function readAgentPrompt(transcriptDir: string, agentId: string): Promise<string | null> {
  const text = await readRegularTextFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    transcriptDir,
    MAX_WORKFLOW_AGENT_TRANSCRIPT_BYTES,
  )
  if (text === null) return null

  // The messages the agent was started with come before its first reply.
  const userMessages: string[] = []
  let replied = false
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = recordOrNull(parsed)
    const message = recordOrNull(record?.message)
    if (message?.role === 'assistant') {
      replied = true
      break
    }
    if (message?.role !== 'user') continue
    const prompt = messageText(message.content)
    if (prompt) userMessages.push(prompt)
  }
  // The relayed user request comes first, the computed task right after it.
  // Until the task is there too (and the agent has not answered), wait for it
  // rather than show the relay as the agent's prompt.
  if (!replied && userMessages.length > 0 && userMessages.every(isRelayedUserRequest)) return null
  return workflowAgentPrompt(userMessages)
}

async function readRegularTextFile(
  path: string,
  transcriptDir: string,
  maxBytes: number,
): Promise<string | null> {
  let canonicalBefore: string
  try {
    canonicalBefore = await realpath(path)
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
  if (!isPathInside(transcriptDir, canonicalBefore)) {
    throw new Error('Workflow transcript file is outside the verified transcript directory')
  }

  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }

  try {
    const openedEntry = await handle.stat()
    if (!openedEntry.isFile()) {
      throw new Error('Workflow transcript entry is not a regular file')
    }
    if (openedEntry.size > maxBytes) {
      throw new Error('Workflow transcript entry exceeds the configured size limit')
    }
    const [canonicalAfter, currentEntry] = await Promise.all([realpath(path), lstat(path)])
    if (
      canonicalAfter !== canonicalBefore ||
      !isPathInside(transcriptDir, canonicalAfter) ||
      !currentEntry.isFile() ||
      currentEntry.isSymbolicLink() ||
      currentEntry.dev !== openedEntry.dev ||
      currentEntry.ino !== openedEntry.ino
    ) {
      throw new Error('Workflow transcript entry changed during validation')
    }
    return await handle.readFile('utf8')
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  } finally {
    await handle.close()
  }
}

async function workflowAgentResult(
  transcriptDir: string,
  agentId: string,
  result: unknown,
): Promise<WorkflowJournalAgentResult | null> {
  const resultRecord = recordOrNull(result)
  const status = String(resultRecord?.status ?? '')
    .trim()
    .toLowerCase()
  const isError =
    Boolean(resultRecord?.error) ||
    status === 'error' ||
    status === 'errored' ||
    status === 'failed' ||
    status === 'failure'
  const body = resultText(result) || (await readAgentResult(transcriptDir, agentId))
  if (!body) return null
  return {
    agentId,
    content: `${body}\nagentId: ${agentId}`,
    isError,
  }
}

async function readAgentResult(transcriptDir: string, agentId: string): Promise<string | null> {
  const text = await readRegularTextFile(
    join(transcriptDir, `agent-${agentId}.jsonl`),
    transcriptDir,
    MAX_WORKFLOW_AGENT_TRANSCRIPT_BYTES,
  )
  if (text === null) return null

  let finalText = ''
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = recordOrNull(parsed)
    const message = recordOrNull(record?.message)
    if (message?.role !== 'assistant') continue
    const content = messageText(message.content)
    if (content) finalText = content
  }
  return finalText || null
}

// What the agent is called in the App: the workflow's label for it, else the
// first line of its task.
export function workflowAgentDescription(
  prompt: string,
  agentId: string,
  label?: string | null,
): string {
  const name = collapseWhitespace(label ?? '') || firstPromptLine(prompt)
  return clipText(name || `Workflow agent ${agentId}`, SUBAGENT_NAME_MAX_CHARS)
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value
    .map((block) => {
      const record = recordOrNull(block)
      return record?.type === 'text' ? stringValue(record.text) : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function isWorkflowAgentId(value: string): boolean {
  return /^[0-9a-f]{8,32}$/i.test(value)
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR')
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
