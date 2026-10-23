// A subagent's own work shown in its child thread: what it says and thinks,
// and its tool calls with their results, as items of the child's turn. The
// child's items take the shapes the parent's do (commands, file changes, MCP
// tool calls, web searches, image views), so the App draws the child the way
// it draws any conversation.
//
// Claude Code forwards a subagent's output as complete blocks, never as
// streamed deltas, so each piece shows at once. Output is kept bounded: a
// result keeps the caps the parent's items have, and a child turn shows at
// most MAX_SUBAGENT_ITEMS items of work.
import { appendCommandOutput } from './command-output.mjs'
import {
  parseExitCodeFromResult,
  todoWriteToPlanSteps,
  toolResultText,
  wrapMcpToolError,
  wrapMcpToolResult,
} from './server-helpers.mjs'
import type { SessionStore } from './store.mjs'
import { capOutput, EXPLORE_OUTPUT_LIMIT, isExploreTool } from './tool-items.mjs'
import type { RpcPeer, RuntimeEvent, SubagentOutput, ThreadItem } from './types.mjs'
import { debugLog, newId, nowMillis } from './util.mjs'
import { markVisualizeLines } from './visualize-lines.mjs'

// Items of work one child turn shows; what the subagent does after that is
// left out (its answer still shows).
export const MAX_SUBAGENT_ITEMS = 256

// A subagent's message, or its MCP tool result, is cut to this many
// characters, the cap of an exploration command's output.
const SUBAGENT_TEXT_LIMIT = EXPLORE_OUTPUT_LIMIT

// What an open tool item of the child says when the child ends without its
// result.
export const SUBAGENT_CALL_UNFINISHED = 'The subagent ended before this call finished.'

// Whether subagents' own work shows in their child threads. On unless
// CLAUDE_CODEX_SUBAGENT_ITEMS is `0`, which leaves a child thread with its
// prompt and its answer only.
export function subagentItemsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODEX_SUBAGENT_ITEMS?.trim() !== '0'
}

// The child turn a subagent's output goes to.
export interface SubagentItemsTarget {
  threadId: string
  turnId: string
  cwd: string
  // The MCP servers its tool calls may name (as for the parent's items).
  mcpServers?: string[]
}

type ToolUseEvent = Extract<RuntimeEvent, { type: 'tool_use' }>

export interface SubagentItemsHost {
  store: Pick<SessionStore, 'appendItem' | 'updateItem'>
  notify(peer: RpcPeer, notification: { method: string; params: unknown }): void
  // The item a tool call shows as, as the parent's calls show.
  toolItem(
    event: ToolUseEvent,
    cwd: string,
    options: { mcpServers?: Iterable<string>; imageView?: boolean },
  ): ThreadItem
  // Whether thinking shows as a reasoning summary (else raw content).
  reasoningVisible(): boolean
}

interface OpenTool {
  itemId: string
  startedAtMs: number
  explore: boolean
  // A failed image Read shows as this Read command instead.
  imageFallback: ThreadItem | null
}

interface ChildTurnState {
  target: SubagentItemsTarget
  // The message the subagent is writing: closes as commentary when it goes
  // on working, or as its answer. `head` is what a capped one kept of it.
  message: { id: string; text: string; head: string | null } | null
  tools: Map<string, OpenTool>
  // Tool calls already shown or left out, so a repeated frame adds nothing.
  calls: Set<string>
  items: number
  omitted: number
}

export class SubagentItems {
  private readonly host: SubagentItemsHost
  private readonly turns = new Map<string, ChildTurnState>()

  constructor(host: SubagentItemsHost) {
    this.host = host
  }

  add(peer: RpcPeer, target: SubagentItemsTarget, output: SubagentOutput): void {
    let state = this.turns.get(target.turnId)
    if (!state) {
      state = {
        target,
        message: null,
        tools: new Map(),
        calls: new Set(),
        items: 0,
        omitted: 0,
      }
      this.turns.set(target.turnId, state)
    }
    if (output.type === 'text') this.addText(peer, state, output.text)
    else if (output.type === 'reasoning') this.addReasoning(peer, state, output.text)
    else if (output.type === 'tool_use') this.startTool(peer, state, output)
    else this.completeTool(peer, state, output)
  }

  // A message reaches the running subagent: what it was saying ends there,
  // so what it says next goes after the message.
  interject(peer: RpcPeer, turnId: string): void {
    const state = this.turns.get(turnId)
    if (state) this.closeMessage(peer, state, 'commentary', null)
  }

  // The child turn ends: its open tool calls fail with `failure` and its open
  // message closes. True when that message is the subagent's `answer`, which
  // then needs no copy.
  finish(peer: RpcPeer, turnId: string, answer: string, failure: string): boolean {
    const state = this.turns.get(turnId)
    if (!state) return false
    this.turns.delete(turnId)
    for (const [, tool] of state.tools) this.failTool(peer, state, tool, failure)
    state.tools.clear()
    if (state.omitted > 0)
      debugLog('subagent.items.omitted', {
        threadId: state.target.threadId,
        turnId,
        omitted: state.omitted,
      })
    const message = state.message
    if (!message) return false
    const answered =
      answer.trim() !== '' &&
      (message.head == null ? sameText(message.text, answer) : startsWithText(answer, message.head))
    // Like the answer the child shows without its work, the reused message
    // carries the answer's own text and no phase.
    this.closeMessage(peer, state, answered ? null : 'commentary', answered ? answer : null)
    return answered
  }

  // Counts an item against the turn's limit; false when it is left out.
  private reserve(state: ChildTurnState): boolean {
    if (state.items >= MAX_SUBAGENT_ITEMS) {
      state.omitted += 1
      return false
    }
    state.items += 1
    return true
  }

  private emit(
    peer: RpcPeer,
    state: ChildTurnState,
    method: string,
    params: Record<string, unknown>,
  ): void {
    this.host.notify(peer, {
      method,
      params: { threadId: state.target.threadId, turnId: state.target.turnId, ...params },
    })
  }

  // `stored` is the item as the deltas that follow leave it, so that a
  // block that arrives whole is written once.
  private startItem(
    peer: RpcPeer,
    state: ChildTurnState,
    item: ThreadItem,
    stored: ThreadItem = item,
  ): void {
    this.host.store.appendItem(state.target.turnId, stored)
    this.emit(peer, state, 'item/started', { item, startedAtMs: nowMillis() })
  }

  private updateItem(
    state: ChildTurnState,
    itemId: string,
    updater: (item: ThreadItem) => ThreadItem,
  ): ThreadItem | null {
    const turn = this.host.store.updateItem(state.target.turnId, itemId, updater)
    return turn?.items.find((item) => item.id === itemId) ?? null
  }

  private completeItem(peer: RpcPeer, state: ChildTurnState, item: ThreadItem | null): void {
    if (item) this.emit(peer, state, 'item/completed', { item, completedAtMs: nowMillis() })
  }

  private addText(peer: RpcPeer, state: ChildTurnState, text: string): void {
    if (!text.trim()) return
    const open = state.message
    if (open) {
      // The message's next block goes on with it.
      if (open.head != null) return
      const joined = `${open.text}\n\n${text}`
      const kept = capOutput(joined, SUBAGENT_TEXT_LIMIT)
      const delta = kept.slice(open.text.length)
      open.text = kept
      if (kept !== joined) open.head = joined.slice(0, SUBAGENT_TEXT_LIMIT)
      this.updateItem(state, open.id, (item) =>
        item.type === 'agentMessage' ? { ...item, text: kept } : item,
      )
      this.emit(peer, state, 'item/agentMessage/delta', { itemId: open.id, delta })
      return
    }
    if (!this.reserve(state)) return
    const kept = capOutput(text, SUBAGENT_TEXT_LIMIT)
    const id = newId()
    const item: ThreadItem = {
      type: 'agentMessage',
      id,
      text: '',
      phase: null,
      memoryCitation: null,
    }
    this.startItem(peer, state, item, { ...item, text: kept })
    this.emit(peer, state, 'item/agentMessage/delta', { itemId: id, delta: kept })
    state.message = {
      id,
      text: kept,
      head: kept === text ? null : text.slice(0, SUBAGENT_TEXT_LIMIT),
    }
  }

  // `phase` null with `text` is the subagent's answer, in place of what
  // streamed.
  private closeMessage(
    peer: RpcPeer,
    state: ChildTurnState,
    phase: 'commentary' | null,
    text: string | null,
  ): void {
    const open = state.message
    if (!open) return
    state.message = null
    // App rule: visualize-line
    const item = this.updateItem(state, open.id, (current) =>
      current.type === 'agentMessage'
        ? { ...current, phase, text: markVisualizeLines(text ?? current.text) }
        : current,
    )
    this.completeItem(peer, state, item)
  }

  private addReasoning(peer: RpcPeer, state: ChildTurnState, text: string): void {
    if (!text.trim()) return
    this.closeMessage(peer, state, 'commentary', null)
    if (!this.reserve(state)) return
    const kept = capOutput(text, SUBAGENT_TEXT_LIMIT)
    // App rule: reasoning-summary
    const visible = this.host.reasoningVisible()
    const id = newId()
    const item: ThreadItem = {
      type: 'reasoning',
      id,
      summary: visible ? [kept] : [],
      content: visible ? [] : [kept],
    }
    this.startItem(
      peer,
      state,
      { ...item, summary: visible ? [''] : [], content: visible ? [] : [''] },
      item,
    )
    if (visible)
      this.emit(peer, state, 'item/reasoning/summaryPartAdded', { itemId: id, summaryIndex: 0 })
    this.emit(
      peer,
      state,
      visible ? 'item/reasoning/summaryTextDelta' : 'item/reasoning/textDelta',
      { itemId: id, delta: kept, ...(visible ? { summaryIndex: 0 } : { contentIndex: 0 }) },
    )
    this.completeItem(peer, state, item)
  }

  private startTool(
    peer: RpcPeer,
    state: ChildTurnState,
    output: Extract<SubagentOutput, { type: 'tool_use' }>,
  ): void {
    if (state.calls.has(output.toolUseId)) return
    state.calls.add(output.toolUseId)
    this.closeMessage(peer, state, 'commentary', null)
    const event: ToolUseEvent = {
      type: 'tool_use',
      toolUseId: output.toolUseId,
      toolName: output.toolName,
      input: output.input,
    }
    // The subagent's todo list is its thread's plan, as the parent's is.
    if (output.toolName === 'TodoWrite') {
      const plan = todoWriteToPlanSteps(output.input)
      if (plan) this.emit(peer, state, 'turn/plan/updated', { explanation: null, plan })
      return
    }
    if (!this.reserve(state)) return
    const options = { mcpServers: state.target.mcpServers ?? [] }
    const item = this.host.toolItem(event, state.target.cwd, options)
    const imageFallback =
      item.type === 'imageView'
        ? { ...this.host.toolItem(event, state.target.cwd, { imageView: false }), id: item.id }
        : null
    state.tools.set(output.toolUseId, {
      itemId: item.id,
      startedAtMs: nowMillis(),
      explore: isExploreTool(output.toolName),
      imageFallback,
    })
    this.startItem(peer, state, item)
    if (item.type === 'fileChange')
      this.emit(peer, state, 'item/fileChange/patchUpdated', {
        itemId: item.id,
        changes: item.changes,
      })
  }

  private completeTool(
    peer: RpcPeer,
    state: ChildTurnState,
    output: Extract<SubagentOutput, { type: 'tool_result' }>,
  ): void {
    const tool = state.tools.get(output.toolUseId)
    // A result whose call shows nowhere here (an agent the subagent
    // launched, a call left out) shows nowhere either.
    if (!tool) return
    state.tools.delete(output.toolUseId)
    const { isError, content } = output
    const durationMs = Math.max(0, nowMillis() - tool.startedAtMs)
    const resultText = toolResultText(content)
    // The App cuts a command's output this way; an exploration's is capped.
    const commandOutput = tool.explore
      ? capOutput(resultText)
      : resultText
        ? appendCommandOutput(null, resultText)
        : ''
    const exitCode = parseExitCodeFromResult(content) ?? (isError ? 1 : 0)
    const item = this.updateItem(state, tool.itemId, (current) => {
      if (current.type === 'commandExecution')
        return {
          ...current,
          status: isError ? 'failed' : 'completed',
          aggregatedOutput: commandOutput,
          exitCode,
          durationMs,
        }
      if (current.type === 'imageView' && isError)
        return failedImageRead(tool, commandOutput, exitCode, durationMs) ?? current
      if (current.type === 'fileChange')
        return { ...current, status: isError ? 'failed' : 'completed' }
      if (current.type === 'mcpToolCall')
        return {
          ...current,
          status: isError ? 'failed' : 'completed',
          result: isError ? null : cappedMcpResult(content, resultText),
          error: isError ? cappedMcpError(content) : null,
          durationMs,
        }
      return current
    })
    // A failed image Read's output arrives with its completed item.
    if (item?.type === 'commandExecution' && commandOutput && !tool.imageFallback)
      this.emit(peer, state, 'item/commandExecution/outputDelta', {
        itemId: tool.itemId,
        delta: commandOutput,
      })
    this.completeItem(peer, state, item)
  }

  private failTool(peer: RpcPeer, state: ChildTurnState, tool: OpenTool, failure: string): void {
    const durationMs = Math.max(0, nowMillis() - tool.startedAtMs)
    const item = this.updateItem(state, tool.itemId, (current) => {
      if (current.type === 'commandExecution') return { ...current, status: 'failed', durationMs }
      if (current.type === 'imageView')
        return failedImageRead(tool, null, null, durationMs) ?? current
      if (current.type === 'fileChange') return { ...current, status: 'failed' }
      if (current.type === 'mcpToolCall')
        return { ...current, status: 'failed', error: { message: failure }, durationMs }
      return current
    })
    this.completeItem(peer, state, item)
  }
}

function failedImageRead(
  tool: OpenTool,
  output: string | null,
  exitCode: number | null,
  durationMs: number,
): ThreadItem | null {
  const fallback = tool.imageFallback
  if (fallback?.type !== 'commandExecution') return null
  return { ...fallback, status: 'failed', aggregatedOutput: output, exitCode, durationMs }
}

// An MCP result as the parent's items carry it, unless it is too big to keep
// (a large page, an image): then its text, capped.
function cappedMcpResult(
  content: unknown,
  resultText: string,
): ReturnType<typeof wrapMcpToolResult> {
  const result = wrapMcpToolResult(content)
  if (JSON.stringify(result).length <= SUBAGENT_TEXT_LIMIT) return result
  return {
    content: [{ type: 'text', text: capOutput(resultText, SUBAGENT_TEXT_LIMIT) }],
    structuredContent: null,
    _meta: null,
  }
}

function cappedMcpError(content: unknown): { message: string } {
  return { message: capOutput(wrapMcpToolError(content).message, SUBAGENT_TEXT_LIMIT) }
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

// The same words, however the lines are broken.
function sameText(a: string, b: string): boolean {
  return flat(a) === flat(b)
}

// Whether `text` begins with the words of `head`, however the lines are
// broken.
function startsWithText(text: string, head: string): boolean {
  const start = flat(head)
  return start !== '' && flat(text).startsWith(start)
}
