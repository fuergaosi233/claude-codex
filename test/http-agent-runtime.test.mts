import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { HttpAgentRuntime } from '../src/http-agent-runtime.mjs'
import type { RuntimeEvent, RuntimeHandlers, RuntimeTurnContext } from '../src/types.mjs'

// An agent-http bridge that records every POST /message and holds the first one
// until the test releases it, so a steer can arrive while the turn is starting.
async function startBridge() {
  const posts: string[] = []
  let releaseFirst!: () => void
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let firstArrived!: () => void
  const firstSeen = new Promise<void>((resolve) => {
    firstArrived = resolve
  })
  let stable = false
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/messages') return json({ messages: [] })
    if (req.method === 'GET' && req.url === '/status') {
      return json({ status: stable ? 'stable' : 'running' })
    }
    if (req.method === 'POST' && req.url === '/message') {
      let body = ''
      for await (const chunk of req) body += chunk
      const { content } = JSON.parse(body) as { content: string }
      const first = posts.length === 0
      posts.push(content)
      if (first) {
        firstArrived()
        await firstReleased
      }
      return json({ ok: true })
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    posts,
    firstSeen,
    releaseFirst,
    finish: () => {
      stable = true
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function turnContext(threadId: string, prompt: string): RuntimeTurnContext {
  return {
    threadId,
    turnId: 'turn-1',
    prompt,
    cwd: process.cwd(),
    runtimeType: null,
    model: null,
    effort: null,
    claudeSessionId: null,
    forkSession: false,
    mcpServers: null,
    allowedTools: null,
    imageInputs: [],
  } as unknown as RuntimeTurnContext
}

function handlers(events: RuntimeEvent[]): RuntimeHandlers {
  return {
    onEvent: (event) => {
      events.push(event)
    },
    onPermissionRequest: async () => ({ behavior: 'deny', message: 'test' }) as never,
  } as RuntimeHandlers
}

test('http runtime steers a turn only after its own prompt is posted', async () => {
  const bridge = await startBridge()
  const runtime = new HttpAgentRuntime({
    kind: 'agent-http',
    baseUrl: bridge.baseUrl,
    useSse: false,
    pollIntervalMs: 10,
    timeoutMs: 10_000,
    sendInterruptRaw: false,
    manageBridge: false,
    modeCommand: 'claude-codex-mode',
  })
  const events: RuntimeEvent[] = []
  try {
    assert.equal(await runtime.steer('unknown-thread', 'nobody runs me'), false)

    const turn = runtime.runTurn(turnContext('thread-1', 'the prompt'), handlers(events))
    await bridge.firstSeen
    assert.equal(await runtime.steer('thread-1', 'too early'), false)
    assert.deepEqual(bridge.posts, ['the prompt'])

    bridge.releaseFirst()
    let steered: boolean | undefined = false
    for (let i = 0; i < 200 && steered === false; i += 1) {
      steered = await runtime.steer('thread-1', 'in time')
      if (steered === false) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(steered, undefined)
    assert.equal(bridge.posts.length, 2)
    assert.equal(bridge.posts[0], 'the prompt')
    assert.match(bridge.posts[1] ?? '', /in time/)

    bridge.finish()
    await turn
    assert.ok(events.some((event) => event.type === 'completed' && event.success))
    assert.equal(await runtime.steer('thread-1', 'after the turn'), false)
    assert.equal(bridge.posts.length, 2)
  } finally {
    await runtime.stop()
    await bridge.close()
  }
})
