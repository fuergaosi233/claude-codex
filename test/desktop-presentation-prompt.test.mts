import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { buildSystemPromptAddendum } from '../src/server-helpers.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'

const noInstructions = {
  baseInstructions: null,
  developerInstructions: null,
  personality: null,
}

test('desktop presentation guidance works without project instructions and stays opt-in', () => {
  assert.equal(buildSystemPromptAddendum(noInstructions), null)
  const prompt = buildSystemPromptAddendum({ ...noInstructions, desktopPresentation: true })
  assert.ok(prompt)
  assert.match(prompt, /Codex desktop.*rich Markdown and fenced Mermaid diagrams/)
  assert.match(prompt, /Skip diagrams for trivial replies/)
  assert.match(prompt, /text-only preference/)
  assert.match(prompt, /not automatically executable artifacts/)
})

test('desktop guidance preserves project, developer and personality instructions', () => {
  const input = {
    baseInstructions: '  Explain in Chinese.  ',
    developerInstructions: '  Use plain text when requested.  ',
    personality: 'pragmatic',
  }
  const existing = buildSystemPromptAddendum(input)
  const desktop = buildSystemPromptAddendum({ ...input, desktopPresentation: true })
  assert.ok(existing)
  assert.ok(desktop)
  assert.ok(desktop.endsWith(existing))
  assert.match(existing, /# Project instructions\nExplain in Chinese\./)
  assert.match(existing, /# Developer instructions\nUse plain text when requested\./)
  assert.match(existing, /Personality: pragmatic/)
})

test('server scopes desktop guidance to normal turns and preserves fork prompt prefixes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-desktop-prompt-'))
  const previousHome = process.env.CLAUDE_CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = directory
  const store = new SessionStore(join(directory, 'state.sqlite'))
  const contexts: RuntimeTurnContext[] = []
  const responses = new Map<unknown, any>()
  let finish: (() => void) | undefined
  let timeout: NodeJS.Timeout | undefined
  const runtime: ClaudeRuntime = {
    runTurn: async (context, handlers) => {
      contexts.push(context)
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    steer: async () => {},
    interrupt: async () => {},
    stop: async () => {},
  }
  const server = new CodexClaudeAppServer(store, runtime)
  const peer: RpcPeer = {
    id: 'desktop-prompt-test',
    close: () => {},
    send: (message) => {
      if ('id' in message) responses.set(message.id, message)
      if ('method' in message && message.method === 'turn/completed') finish?.()
    },
  }
  let nextId = 0
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId
    await server.handle(peer, { id, method, params })
    const response = responses.get(id)
    assert.ok(response, `Missing ${method} response`)
    assert.equal(response.error, undefined)
    return response.result
  }
  const turn = async (threadId: string, params: Record<string, unknown> = {}) => {
    const completed = new Promise<void>((resolve) => {
      finish = resolve
    })
    await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Explain this architecture.' }],
      ...params,
    })
    await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Prompt turn timed out')), 5_000)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    const context = contexts.at(-1)
    assert.ok(context)
    return context
  }
  try {
    const instructions = {
      baseInstructions: 'Explain in Chinese.',
      developerInstructions: 'Use plain text when requested.',
      personality: 'pragmatic',
    }
    const { thread } = await request('thread/start', {
      cwd: directory,
      model: 'sonnet',
      ...instructions,
    })
    const normal = await turn(thread.id)
    assert.equal(normal.purpose, 'normal')
    assert.equal(
      normal.systemPromptAddendum,
      buildSystemPromptAddendum({ ...instructions, desktopPresentation: true }),
    )

    const summary = await turn(thread.id, {
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
    })
    assert.equal(summary.purpose, 'summary')
    assert.equal(summary.systemPromptAddendum, buildSystemPromptAddendum(instructions))

    const fork = await request('thread/fork', {
      threadId: thread.id,
      developerInstructions: 'Focus on the storage layer.',
    })
    const sidechat = await turn(fork.thread.id)
    assert.equal(sidechat.systemPromptAddendum, normal.systemPromptAddendum)
    assert.match(sidechat.prompt, /^<side-conversation-instructions>\nFocus on the storage layer\./)
  } finally {
    if (timeout) clearTimeout(timeout)
    await server.stop()
    if (previousHome == null) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
