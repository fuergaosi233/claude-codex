import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { buildSystemPromptAddendum } from '../src/server-helpers.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'
import { threadVisualizationDir } from '../src/util.mjs'

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

// An adapter whose runtime records each turn's context and completes it.
// `setup` prepares its home folder before it starts.
async function withPromptServer(
  body: (harness: {
    directory: string
    store: SessionStore
    request: (method: string, params: Record<string, unknown>) => Promise<any>
    turn: (threadId: string, params?: Record<string, unknown>) => Promise<RuntimeTurnContext>
  }) => Promise<void>,
  setup?: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-desktop-prompt-'))
  const previousHome = process.env.CLAUDE_CODEX_HOME
  const previousCodexHome = process.env.CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = directory
  process.env.CODEX_HOME = join(directory, 'codex-home')
  await setup?.(directory)
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
    await body({ directory, store, request, turn })
  } finally {
    if (timeout) clearTimeout(timeout)
    await server.stop()
    if (previousHome == null) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = previousHome
    if (previousCodexHome == null) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await rm(directory, { recursive: true, force: true })
  }
}

const instructions = {
  baseInstructions: 'Explain in Chinese.',
  developerInstructions: 'Use plain text when requested.',
  personality: 'pragmatic',
}

test('server scopes desktop guidance to normal turns and preserves fork prompt prefixes', async () => {
  await withPromptServer(async ({ directory, request, turn }) => {
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
  })
})

// The App's bundled marketplace with its visualize plugin, laid out under
// `directory/bundled`.
async function bundledMarketplace(directory: string) {
  const marketplace = join(directory, 'bundled')
  const manifest = join(marketplace, '.agents', 'plugins', 'marketplace.json')
  const root = join(marketplace, 'plugins', 'visualize')
  const skillFile = join(root, 'skills', 'visualize', 'SKILL.md')
  await mkdir(dirname(manifest), { recursive: true })
  await writeFile(
    manifest,
    JSON.stringify({
      name: 'bundled',
      plugins: [{ name: 'visualize', source: { source: 'local', path: './plugins/visualize' } }],
    }),
  )
  await mkdir(join(root, '.codex-plugin'), { recursive: true })
  await writeFile(join(root, '.codex-plugin', 'plugin.json'), '{"skills":"./skills/"}')
  await mkdir(dirname(skillFile), { recursive: true })
  await writeFile(skillFile, '---\nname: visualize\ndescription: Draw things.\n---\n')
  return { manifest, root, skillFile }
}

test('server lists installed App skills and each thread its own visualization folder', async () => {
  await withPromptServer(async ({ directory, store, request, turn }) => {
    const { manifest, root, skillFile } = await bundledMarketplace(directory)
    const skills = [
      { name: 'visualize', description: 'Draw things.', path: skillFile, plugin: 'visualize' },
    ]

    assert.deepEqual(
      await request('plugin/install', { marketplacePath: manifest, pluginName: 'visualize' }),
      { authPolicy: 'ON_USE', appsNeedingAuth: [] },
    )
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
    assert.deepEqual(config.appPlugins, [{ name: 'visualize', root }])

    const { thread } = await request('thread/start', {
      cwd: directory,
      model: 'sonnet',
      ...instructions,
    })
    const visualizations = threadVisualizationDir(thread.id)
    assert.ok(visualizations)
    assert.ok(visualizations.startsWith(join(directory, 'codex-home', 'visualizations')))
    const normal = await turn(thread.id)
    assert.equal(
      normal.systemPromptAddendum,
      buildSystemPromptAddendum({
        ...instructions,
        desktopPresentation: true,
        appSkills: skills,
        visualizationDir: visualizations,
      }),
    )
    assert.deepEqual(normal.readableRoots, [dirname(skillFile), visualizations])

    // Helper turns get neither the skills nor read access to them.
    const summary = await turn(thread.id, {
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
    })
    assert.equal(summary.systemPromptAddendum, buildSystemPromptAddendum(instructions))
    assert.deepEqual(summary.readableRoots, [])

    // A side conversation keeps its parent's system prompt and learns its own
    // folder from the turn prompt.
    const fork = await request('thread/fork', {
      threadId: thread.id,
      developerInstructions: 'Focus on the storage layer.',
    })
    const forkVisualizations = threadVisualizationDir(fork.thread.id)
    assert.ok(forkVisualizations)
    assert.notEqual(forkVisualizations, visualizations)
    const sidechat = await turn(fork.thread.id)
    assert.equal(sidechat.systemPromptAddendum, normal.systemPromptAddendum)
    assert.ok(
      sidechat.prompt.startsWith(
        `<side-conversation-instructions>\nFocus on the storage layer.\n\nSave the visualization fragments for this conversation in ${forkVisualizations}; the App reads them from there.\n</side-conversation-instructions>\n\n`,
      ),
    )
    assert.deepEqual(sidechat.readableRoots, [dirname(skillFile), forkVisualizations])

    // The App cannot show visualizations of threads with older, non-v7 ids.
    const legacyId = randomUUID()
    const record = store.getThread(thread.id)
    assert.ok(record)
    store.upsertThread({ ...record, id: legacyId, sessionId: legacyId, claudeSessionId: null })
    const legacy = await turn(legacyId)
    assert.equal(
      legacy.systemPromptAddendum,
      buildSystemPromptAddendum({ ...instructions, desktopPresentation: true }),
    )
    assert.deepEqual(legacy.readableRoots, [])

    assert.deepEqual(await request('plugin/uninstall', { pluginId: 'visualize@bundled' }), {})
    const uninstalled = await turn(thread.id)
    assert.equal(
      uninstalled.systemPromptAddendum,
      buildSystemPromptAddendum({ ...instructions, desktopPresentation: true }),
    )
    const updated = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
    assert.deepEqual(updated.appPlugins, [])
  })
})

test('server remembers the App plugins it installed across restarts', async () => {
  let skillFile = ''
  await withPromptServer(
    async ({ directory, request, turn }) => {
      const { thread } = await request('thread/start', { cwd: directory, model: 'sonnet' })
      const context = await turn(thread.id)
      assert.match(context.systemPromptAddendum ?? '', /\n- visualize: Draw things\. \(file: /)
      assert.deepEqual(context.readableRoots, [
        dirname(skillFile),
        threadVisualizationDir(thread.id),
      ])
    },
    async (directory) => {
      const marketplace = await bundledMarketplace(directory)
      skillFile = marketplace.skillFile
      await writeFile(
        join(directory, 'config.json'),
        JSON.stringify({ appPlugins: [{ name: 'visualize', root: marketplace.root }, 'broken'] }),
      )
    },
  )
})
