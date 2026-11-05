import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { QUIET_TURN_HEARTBEAT } from '../src/quiet-turns.mjs'
import { SessionStore } from '../src/store.mjs'
import {
  adapter,
  completedAgentMessages,
  JsonLineReader,
  json,
  readUntil,
  spawnMockAdapter,
  startMockThread,
  textInput,
} from './support/adapter-harness.mjs'

test('Task subagent emits the canonical activity lifecycle and leaves wait as the terminal display state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: home,
      CLAUDE_CODEX_MOCK: '1',
      CLAUDE_CODEX_SUBAGENT_COMPLETED: '1',
      NODE_NO_WARNINGS: '1',
    },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 0,
        method: 'initialize',
        params: {
          clientInfo: { name: 'codex-test-modern', title: 'Codex test', version: 'modern' },
          capabilities: { subAgentActivityCompleted: true },
        },
      }),
    )
    await reader.nextResponse(0)
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), experimentalRawEvents: false, persistExtendedHistory: false },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'subagent check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)

    type Lifecycle = { started?: any; completed?: any }
    const collabByTool: Record<string, Lifecycle> = {}
    let agentMessageText = ''
    let childThreadStarted: any = null
    let childTurnStarted: any = null
    let childPromptStarted: any = null
    let childPromptCompleted: any = null
    let childAgentStarted: any = null
    let childAgentCompleted: any = null
    let childAgentMessageText = ''
    let childTurnCompleted: any = null
    let liveChildRead: any = null
    let childTokenUsage: any = null
    let leakedInnerItems = 0
    const subagentActivityStarted = new Map<string, any>()
    const subagentActivities: any[] = []
    const parentCompletedOrder: string[] = []
    for (let i = 0; i < 300; i += 1) {
      const message = await reader.next()
      if (message.id === 50) liveChildRead = message.result.thread
      if (
        message.method === 'thread/started' &&
        message.params.thread?.threadSource === 'subagent'
      ) {
        childThreadStarted = message.params.thread
      }
      if (message.method === 'turn/started' && message.params.threadId !== threadId) {
        childTurnStarted = message.params.turn
        proc.stdin.write(
          json({
            id: 50,
            method: 'thread/read',
            // The bundled Codex App panel uses includeTurns:false while it
            // opens a child. The adapter must still hydrate this subagent.
            params: { threadId: message.params.threadId, includeTurns: false },
          }),
        )
      }
      if (message.method === 'item/started') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptStarted = item
        } else if (message.params.threadId !== threadId && item.type === 'agentMessage') {
          childAgentStarted = item
        } else if (item.type === 'subAgentActivity') {
          subagentActivityStarted.set(item.id, item)
        } else if (item.type === 'collabAgentToolCall') {
          const bucket = (collabByTool[item.tool] ??= {})
          bucket.started = item
        } else if (
          item.type === 'commandExecution' ||
          (item.type === 'mcpToolCall' && item.tool !== 'Task')
        ) {
          leakedInnerItems += 1
        }
      }
      if (message.method === 'item/completed') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptCompleted = item
        } else if (message.params.threadId !== threadId && item.type === 'agentMessage') {
          childAgentCompleted = item
        } else if (item.type === 'subAgentActivity') {
          subagentActivities.push(item)
          parentCompletedOrder.push(`activity:${item.kind}`)
        } else if (item.type === 'collabAgentToolCall') {
          const bucket = (collabByTool[item.tool] ??= {})
          bucket.completed = item
          parentCompletedOrder.push(`collab:${item.tool}`)
        }
      }
      if (message.method === 'item/agentMessage/delta') {
        if (message.params.threadId === threadId) {
          agentMessageText += String(message.params.delta ?? '')
        } else {
          childAgentMessageText += String(message.params.delta ?? '')
        }
      }
      if (message.method === 'turn/completed') {
        if (message.params.threadId === threadId) break
        childTurnCompleted = message.params.turn
      }
      if (message.method === 'thread/tokenUsage/updated' && message.params.threadId !== threadId)
        childTokenUsage = message.params.tokenUsage
    }
    // The `<usage>subagent_tokens: N` trailer becomes the child's usage.
    assert.equal(childTokenUsage?.total.totalTokens, 4242)
    // Native V2 uses activity items for liveness and leaves wait/completed as
    // the final parent item. Closing an already-finished child makes older App
    // reducers discard that completed state and fall back to "started".
    for (const tool of ['spawnAgent', 'wait']) {
      const lc = collabByTool[tool]
      assert.ok(lc?.started, `expected item/started for ${tool}`)
      assert.ok(lc?.completed, `expected item/completed for ${tool}`)
      assert.equal(lc.started.id, lc.completed.id, `${tool} begin/end must share a single item id`)
      assert.equal(
        lc.completed.status,
        'completed',
        `${tool} should complete with status=completed`,
      )
    }
    const spawnEnd = collabByTool.spawnAgent!.completed!
    assert.equal(spawnEnd.senderThreadId, threadId)
    assert.equal(
      spawnEnd.receiverThreadIds.length,
      1,
      'spawnAgent end should reference exactly one child thread',
    )
    const childThreadId = spawnEnd.receiverThreadIds[0]!
    assert.deepEqual(
      subagentActivities.map((item) => item.kind),
      ['started', 'completed'],
      'subagent activity must transition from started to completed',
    )
    assert.equal(subagentActivities[0].agentThreadId, childThreadId)
    assert.equal(subagentActivities[1].agentThreadId, childThreadId)
    assert.equal(subagentActivities[0].agentPath, subagentActivities[1].agentPath)
    assert.match(subagentActivities[0].agentPath, /^\/root\/[A-Za-z0-9_-]+$/)
    assert.equal(subagentActivityStarted.size, 2)
    for (const completedActivity of subagentActivities) {
      assert.deepEqual(
        subagentActivityStarted.get(completedActivity.id),
        completedActivity,
        `${completedActivity.kind} activity must emit item/started and item/completed with the same id`,
      )
    }
    assert.ok(
      parentCompletedOrder.indexOf('activity:completed') <
        parentCompletedOrder.indexOf('collab:wait'),
      'completed activity must arrive before wait/completed so the bundled App keeps the final done state',
    )
    assert.equal(
      collabByTool.closeAgent,
      undefined,
      'a naturally completed child must not receive a synthetic closeAgent lifecycle',
    )
    assert.ok(childThreadStarted, 'subagent must emit child thread/started for live navigation')
    assert.equal(childThreadStarted.id, childThreadId)
    // Child ids are UUIDv7 like every thread id; the nickname takes the
    // random tail, not the timestamp shared by agents spawned together.
    assert.match(childThreadId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    assert.equal(
      childThreadStarted.agentNickname,
      `agent-${childThreadId.replace(/-/g, '').slice(-12)}`,
    )
    assert.equal(
      childThreadStarted.parentThreadId,
      threadId,
      'subagent thread metadata must identify its parent thread',
    )
    assert.equal(childThreadStarted.recencyAt, childThreadStarted.updatedAt)
    assert.deepEqual(childThreadStarted.source, {
      subAgent: {
        thread_spawn: {
          parent_thread_id: threadId,
          depth: 1,
          agent_path: null,
          agent_nickname: childThreadStarted.agentNickname,
          agent_role: 'general-purpose',
        },
      },
    })
    assert.ok(childTurnStarted, 'subagent must emit child turn/started before its result')
    assert.equal(childTurnStarted.status, 'inProgress')
    assert.equal(childTurnStarted.itemsView, 'notLoaded')
    assert.deepEqual(childTurnStarted.items, [])
    assert.ok(childPromptStarted, 'subagent prompt must emit child userMessage item/started')
    assert.ok(childPromptCompleted, 'subagent prompt must emit child userMessage item/completed')
    assert.equal(childPromptStarted.id, childPromptCompleted.id)
    assert.equal(childPromptCompleted.content[0].text, 'investigate')
    assert.ok(liveChildRead, 'opening a running subagent must return its child turn')
    assert.equal(liveChildRead.turns.length, 1)
    assert.equal(liveChildRead.turns[0].status, 'inProgress')
    const liveItems = liveChildRead.turns[0].items
    assert.equal(
      liveItems.find((item: any) => item.type === 'userMessage').content[0].text,
      'investigate',
    )
    assert.equal(
      liveItems.some((item: any) => item.type === 'agentMessage'),
      false,
    )
    assert.ok(childAgentStarted, 'subagent result must emit child agentMessage item/started')
    assert.equal(childAgentStarted.text, '')
    assert.match(childAgentMessageText, /subagent final summary/)
    assert.ok(childAgentCompleted, 'subagent result must emit child agentMessage item/completed')
    assert.equal(childAgentCompleted.id, childAgentStarted.id)
    assert.match(childAgentCompleted.text, /subagent final summary/)
    assert.ok(
      childTurnCompleted,
      'subagent must emit child turn/completed before parent completion',
    )
    assert.equal(childTurnCompleted.id, childTurnStarted.id)
    assert.equal(childTurnCompleted.status, 'completed')
    assert.equal(
      childTurnCompleted.itemsView,
      'summary',
      'completed subagent turns must carry their final response in the terminal envelope',
    )
    assert.equal(childTurnCompleted.items.length, 1)
    assert.equal(childTurnCompleted.items[0].type, 'agentMessage')
    assert.equal(childTurnCompleted.items[0].id, childAgentCompleted.id)
    assert.match(childTurnCompleted.items[0].text, /subagent final summary/)
    // After spawnAgent ends the subagent is now running; wait/completed is the
    // terminal display snapshot after the activity completion event.
    assert.equal(spawnEnd.agentsStates[childThreadId]!.status, 'running')
    assert.equal(collabByTool.wait!.started!.receiverThreadIds[0], childThreadId)
    assert.equal(collabByTool.wait!.completed!.agentsStates[childThreadId]!.status, 'completed')
    // collabAgentToolCall.model carries the SDK model the subagent runs on,
    // NOT Claude's subagent_type — the App's "Agent · model" badge depends
    // on this. The mock runs without a subagent_type so the parent's model
    // (default 'sonnet') flows through unchanged.
    assert.equal(
      spawnEnd.model,
      'sonnet',
      'collabAgentToolCall.model should be the parent thread model when no Task input.model is set',
    )

    // Codex App reads agentRole/agentNickname off the child thread to render
    // its native subagent identity. The mock has no subagent_type so we fall
    // back to "general-purpose"; agentNickname mirrors Claude's `agent-{hex}`
    // shape so the App can show a stable handle for this subagent instance.
    proc.stdin.write(json({ id: 5, method: 'thread/read', params: { threadId: childThreadId } }))
    const childRead = await reader.nextResponse(5)
    const childThread = childRead.result.thread
    assert.equal(childThread.threadSource, 'subagent')
    assert.equal(childThread.ephemeral, true)
    assert.equal(childThread.agentRole, 'general-purpose')
    // The Task tool_result carried an `agentId: deadbeefcafef00d` trailer
    // (mock mirrors the real claude-agent-sdk format). The server should
    // strip it from the visible text and overwrite the synthetic
    // `agent-{hex}` nickname with the SDK-assigned id.
    assert.equal(childThread.agentNickname, 'deadbeefcafef00d')
    assert.equal(
      childThread.forkedFromId,
      threadId,
      'subagent thread should be forked from the parent user thread',
    )

    // Trailer is stripped from the child thread's visible agentMessage.
    proc.stdin.write(
      json({ id: 6, method: 'thread/turns/list', params: { threadId: childThreadId } }),
    )
    const childTurns = await reader.nextResponse(6)
    assert.equal(childTurns.result.data.length, 1, 'subagent should use one live child turn')
    const childTurnItems = (childTurns.result.data[0] as any).items
    const childPrompt = childTurnItems.find((i: any) => i.type === 'userMessage')
    assert.equal(childPrompt.content[0].text, 'investigate')
    const childAgent = childTurnItems.find((i: any) => i.type === 'agentMessage')
    assert.ok(childAgent, 'child thread should have an agentMessage with the subagent result')
    assert.doesNotMatch(
      childAgent.text,
      /agentId:/,
      '`agentId:` trailer should be stripped from the visible body',
    )
    assert.doesNotMatch(
      childAgent.text,
      /<usage>/,
      '`<usage>` block should be stripped from the visible body',
    )
    assert.match(
      childAgent.text,
      /subagent final summary/,
      'the real subagent body must still be there',
    )
    assert.equal(
      childAgent.text,
      'subagent final summary\n\n```\nindented detail\n```',
      'the hand-back frame and its indentation should be gone',
    )

    // A reload replays the activity cards this client saw live, in order, so
    // the completed marker still lands before wait/completed.
    proc.stdin.write(
      json({ id: 8, method: 'thread/turns/list', params: { threadId, itemsView: 'full' } }),
    )
    const liveParentTurns = await reader.nextResponse(8)
    const replayed = (liveParentTurns.result.data as any[])
      .flatMap((turn: any) => turn.items ?? [])
      .filter(
        (item: any) => item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall',
      )
      .map((item: any) =>
        item.type === 'subAgentActivity' ? `activity:${item.kind}` : `collab:${item.tool}`,
      )
    assert.deepEqual(
      replayed.filter((entry: string) => entry.startsWith('activity:')),
      ['activity:started', 'activity:completed'],
      'parent history must keep the activity cards the client saw live',
    )
    assert.ok(replayed.indexOf('activity:completed') < replayed.indexOf('collab:wait'))

    assert.equal(leakedInnerItems, 0, 'inner Bash tool calls should not appear at the parent level')
    assert.doesNotMatch(
      agentMessageText,
      /subagent thinking aloud/,
      'subagent text should not bleed into the main agent message',
    )
    assert.match(
      agentMessageText,
      /main agent summary/,
      'main agent text after subagent should still appear',
    )

    // Ephemeral child thread is hidden from the default list, exposed with includeEphemeral.
    proc.stdin.write(json({ id: 3, method: 'thread/list', params: {} }))
    const list = await reader.nextResponse(3)
    const ids = (list.result.data as any[]).map((t) => t.id)
    assert.ok(
      !ids.includes(childThreadId),
      'subagent child thread should be hidden from thread/list',
    )
    assert.ok(ids.includes(threadId), 'parent user thread should remain visible')

    proc.stdin.write(json({ id: 4, method: 'thread/list', params: { includeEphemeral: true } }))
    const listAll = await reader.nextResponse(4)
    const allIds = (listAll.result.data as any[]).map((t) => t.id)
    assert.ok(
      allIds.includes(childThreadId),
      'includeEphemeral=true should surface the subagent child thread',
    )

    // Codex App discovers subagents after reconnect through the standard
    // parent/source filters, without setting includeEphemeral explicitly.
    proc.stdin.write(
      json({
        id: 7,
        method: 'thread/list',
        params: {
          parentThreadId: threadId,
          sourceKinds: ['subAgentThreadSpawn'],
          sortDirection: 'desc',
          sortKey: 'created_at',
          useStateDbOnly: true,
          limit: 200,
        },
      }),
    )
    const discovered = await reader.nextResponse(7)
    assert.deepEqual(
      discovered.result.data.map((thread: any) => thread.id),
      [childThreadId],
      'standard subagent discovery must return the child for its parent',
    )

    // Generic and thread-spawn source kinds are representable by this
    // adapter. The omitted sortKey also exercises the protocol default
    // (created_at). Other variants are intentionally unsupported because the
    // persisted schema has no discriminator for them.
    for (const [index, sourceKind] of ['subAgent', 'subAgentThreadSpawn'].entries()) {
      const id = 80 + index
      proc.stdin.write(
        json({
          id,
          method: 'thread/list',
          params: {
            parentThreadId: threadId,
            sourceKinds: [sourceKind],
            limit: 200,
          },
        }),
      )
      const variant = await reader.nextResponse(id)
      assert.deepEqual(
        variant.result.data.map((thread: any) => thread.id),
        [childThreadId],
        `${sourceKind} should discover the subagent child`,
      )
    }
    for (const [index, sourceKind] of [
      'subAgentReview',
      'subAgentCompact',
      'subAgentOther',
    ].entries()) {
      const id = 90 + index
      proc.stdin.write(
        json({
          id,
          method: 'thread/list',
          params: { parentThreadId: threadId, sourceKinds: [sourceKind], limit: 200 },
        }),
      )
      const variant = await reader.nextResponse(id)
      assert.deepEqual(
        variant.result.data.map((thread: any) => thread.id),
        [],
        `${sourceKind} should not mislabel a thread-spawn child`,
      )
    }

    // Restart the adapter and replay the parent turn from SQLite. The bundled
    // App reduces items in persisted order, so wait/completed must still be
    // the last subagent state after a cold restart. This connection never
    // initializes, so it reads like a legacy client and gets no started or
    // completed activity markers it could not have been sent live.
    const exited = once(proc, 'exit')
    proc.kill()
    await exited
    const restarted = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
    })
    const restartedReader = new JsonLineReader(restarted)
    try {
      restarted.stdin.write(
        json({
          id: 1,
          method: 'thread/turns/list',
          params: { threadId, itemsView: 'full' },
        }),
      )
      const persistedTurns = await restartedReader.nextResponse(1)
      const persistedItems = persistedTurns.result.data[0].items.filter(
        (item: any) => item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall',
      )
      assert.deepEqual(
        persistedItems.map((item: any) =>
          item.type === 'subAgentActivity'
            ? `activity:${item.kind}`
            : `collab:${item.tool}:${item.status}`,
        ),
        ['collab:spawnAgent:completed', 'collab:wait:completed'],
        'cold-open history must not retain a started activity marker after wait/completed',
      )

      restarted.stdin.write(
        json({
          id: 2,
          method: 'thread/list',
          params: {
            parentThreadId: threadId,
            sourceKinds: ['subAgentThreadSpawn'],
            sortDirection: 'desc',
            sortKey: 'created_at',
            useStateDbOnly: true,
            limit: 200,
          },
        }),
      )
      const rediscovered = await restartedReader.nextResponse(2)
      assert.deepEqual(
        rediscovered.result.data.map((thread: any) => thread.id),
        [childThreadId],
        'a cold App connection must rediscover the persisted subagent child',
      )
      assert.equal(rediscovered.result.data[0].status.type, 'idle')
      assert.equal(rediscovered.result.data[0].isPinned, false)

      restarted.stdin.write(
        json({
          id: 3,
          method: 'thread/read',
          // Cold-open follows the same metadata-only request as the Codex App.
          params: { threadId: childThreadId, includeTurns: false },
        }),
      )
      const coldChild = (await restartedReader.nextResponse(3)).result.thread
      assert.equal(coldChild.turns.length, 1)
      assert.equal(coldChild.turns[0].status, 'completed')
      assert.equal(coldChild.turns[0].itemsView, 'full')
      assert.equal(
        coldChild.turns[0].items.find((item: any) => item.type === 'userMessage').content[0].text,
        'investigate',
      )
      assert.match(
        coldChild.turns[0].items.find((item: any) => item.type === 'agentMessage').text,
        /subagent final summary/,
      )

      restarted.stdin.write(
        json({
          id: 4,
          method: 'thread/read',
          params: { threadId, includeTurns: false },
        }),
      )
      const metadataOnlyParent = (await restartedReader.nextResponse(4)).result.thread
      assert.equal(
        metadataOnlyParent.turns.length,
        0,
        'ordinary thread/read includeTurns:false must remain metadata-only',
      )
    } finally {
      restarted.kill()
    }
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('Codex App 26.818 settles subagents without the unsupported completed activity kind', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 0,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'Codex Desktop',
            title: 'Codex Desktop',
            version: '26.818.61809',
          },
          capabilities: { experimentalApi: true },
        },
      }),
    )
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'subagent check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    const activityKinds: string[] = []
    let childThreadId = ''
    let childPromptStarted: any = null
    let childPromptCompleted: any = null
    let waitCompleted: any = null
    let sawCloseAgent = false
    for (let i = 0; i < 300; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/started') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptStarted = item
        }
        if (item.type === 'collabAgentToolCall' && item.tool === 'closeAgent') sawCloseAgent = true
      }
      if (message.method === 'item/completed') {
        const item = message.params.item
        if (message.params.threadId !== threadId && item.type === 'userMessage') {
          childPromptCompleted = item
        }
        if (item.type === 'subAgentActivity') activityKinds.push(item.kind)
        if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
          childThreadId = String(item.receiverThreadIds[0] ?? '')
        }
        if (item.type === 'collabAgentToolCall' && item.tool === 'wait') waitCompleted = item
        if (item.type === 'collabAgentToolCall' && item.tool === 'closeAgent') sawCloseAgent = true
      }
      if (message.method === 'turn/completed' && message.params.threadId === threadId) break
    }

    assert.deepEqual(
      activityKinds,
      [],
      'Codex App 26.818 must use spawnAgent/wait lifecycle instead of an unsupported started marker',
    )
    assert.ok(childPromptStarted)
    assert.ok(childPromptCompleted)
    assert.equal(childPromptStarted.id, childPromptCompleted.id)
    assert.equal(childPromptCompleted.content[0].text, 'investigate')
    assert.ok(childThreadId)
    assert.ok(waitCompleted)
    assert.equal(waitCompleted.status, 'completed')
    assert.equal(waitCompleted.agentsStates[childThreadId].status, 'completed')
    assert.equal(
      sawCloseAgent,
      false,
      'successful legacy subagents must keep wait/completed as the visible terminal state',
    )

    proc.stdin.write(
      json({
        id: 3,
        method: 'thread/read',
        params: { threadId: childThreadId, includeTurns: false },
      }),
    )
    const legacyChild = (await reader.nextResponse(3)).result.thread
    assert.equal(legacyChild.turns.length, 1)
    assert.equal(legacyChild.turns[0].status, 'completed')
    assert.equal(legacyChild.turns[0].itemsView, 'full')
    assert.equal(
      legacyChild.turns[0].items.find((item: any) => item.type === 'userMessage').content[0].text,
      'investigate',
    )
    assert.match(
      legacyChild.turns[0].items.find((item: any) => item.type === 'agentMessage').text,
      /subagent final summary/,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('subagent without a terminal result emits interrupted activity and failed wait', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(
      json({
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      }),
    )
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'orphan subagent check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let childThreadId = ''
    let waitStatus = ''
    let sawClose = false
    const activityKinds: string[] = []
    let childTurnCompleted: any = null
    for (let i = 0; i < 200; i += 1) {
      const message = await reader.next()
      if (message.method === 'item/completed') {
        const item = message.params.item
        if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent')
          childThreadId = String(item.receiverThreadIds[0] ?? '')
        if (item.type === 'collabAgentToolCall' && item.tool === 'wait') waitStatus = item.status
        if (item.type === 'collabAgentToolCall' && item.tool === 'closeAgent') sawClose = true
        if (item.type === 'subAgentActivity') activityKinds.push(item.kind)
      }
      if (message.method === 'turn/completed' && message.params.threadId !== threadId)
        childTurnCompleted = message.params.turn
      if (message.method === 'turn/completed' && message.params.threadId === threadId) break
    }

    assert.ok(childThreadId)
    assert.equal(waitStatus, 'failed')
    assert.equal(
      sawClose,
      true,
      'legacy Codex App needs closeAgent to clear an orphaned child spinner',
    )
    assert.deepEqual(activityKinds, ['interrupted'])
    assert.ok(childTurnCompleted)
    assert.equal(childTurnCompleted.status, 'failed')
    assert.equal(childTurnCompleted.itemsView, 'notLoaded')
    assert.deepEqual(childTurnCompleted.items, [])
    proc.stdin.write(
      json({ id: 3, method: 'thread/turns/list', params: { threadId: childThreadId } }),
    )
    const childTurns = await reader.nextResponse(3)
    assert.equal(childTurns.result.data[0].status, 'failed')

    // Read back, each client gets what it got live: the closeAgent kept for
    // the legacy App would hide the child from a current one.
    const isClose = (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'closeAgent'
    const closesIn = async (
      client: ChildProcessWithoutNullStreams,
      clientReader: JsonLineReader,
      firstId: number,
    ) => {
      const request = async (id: number, method: string, params: unknown) => {
        client.stdin.write(json({ id, method, params }))
        return (await clientReader.nextResponse(id)).result
      }
      const items = (thread: any) => thread.turns.flatMap((turn: any) => turn.items)
      const read = await request(firstId, 'thread/read', { threadId, includeTurns: true })
      const listed = await request(firstId + 1, 'thread/items/list', { threadId })
      const updated = await request(firstId + 2, 'thread/metadata/update', { threadId })
      return {
        read: items(read.thread).filter(isClose),
        listed: listed.data.map((entry: any) => entry.item).filter(isClose),
        updated: items(updated.thread).filter(isClose),
      }
    }
    const kept = await closesIn(proc, reader, 4)
    assert.equal(kept.read.length, 1)
    assert.deepEqual(kept.listed, kept.read)
    assert.deepEqual(kept.updated, kept.read)
    assert.equal('legacyOnly' in kept.read[0], false)

    // The same thread read by a current App, after a restart.
    const exited = once(proc, 'exit')
    proc.kill()
    await exited
    const current = spawnMockAdapter(home)
    try {
      const currentReader = new JsonLineReader(current)
      current.stdin.write(json(codex930Initialize(0)))
      await currentReader.nextResponse(0)
      assert.deepEqual(await closesIn(current, currentReader, 1), {
        read: [],
        listed: [],
        updated: [],
      })
    } finally {
      const currentExited = once(current, 'exit')
      current.kill()
      await currentExited
    }
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('server stop keeps a background report from opening a parent turn after it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  try {
    const result = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `
      import { join } from 'node:path'
      import { CodexClaudeAppServer } from './dist/src/server.mjs'
      import { SessionStore } from './dist/src/store.mjs'

      process.env.CLAUDE_CODEX_HOME = ${JSON.stringify(home)}
      let listener
      let launches = 0
      const server = new CodexClaudeAppServer(
        new SessionStore(join(${JSON.stringify(home)}, 'state.sqlite')),
        {
          setBackgroundListener: (value) => {
            listener = value
          },
          hasPendingContinuation: () => true,
          runTurn: async (context) => {
            launches += 1
            if (launches > 1) return new Promise(() => {})
            // A background agent reports while this turn runs, so its
            // continuation waits for the turn to clear.
            listener.onAutonomousTurn(context.threadId)
            throw new Error('turn failed')
          },
          async steer() {},
          async interrupt() {},
          async stop() {},
        },
      )
      const messages = []
      let stopping
      const peer = {
        id: 'peer',
        send: (message) => {
          messages.push(message)
          // The adapter stops the moment the turn ends, before the
          // continuation's tick.
          if (message.method === 'turn/completed') stopping ??= server.stop()
        },
        close() {},
      }
      await server.handle(peer, {
        id: 1,
        method: 'thread/start',
        params: { cwd: process.cwd(), persistExtendedHistory: false },
      })
      const threadId = messages.find((message) => message.id === 1).result.thread.id
      await server.handle(peer, {
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'go', text_elements: [] }] },
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      await stopping
      process.stdout.write(JSON.stringify({ stopped: Boolean(stopping), launches }))
    `,
      ],
      { cwd: resolve('.'), encoding: 'utf8', stdio: 'pipe' },
    )
    assert.deepEqual(JSON.parse(result), { stopped: true, launches: 1 })
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('background Agent outlives the parent turn, wakes the parent, and resumes on SendMessage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  const parentTurnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'background subagent check delay=600', text_elements: [] }],
        },
      }),
    )
    const firstTurnId = (await reader.nextResponse(2)).result.turn.id

    // The launching turn settles while the child keeps running.
    const launch = await readUntil(reader, parentTurnCompleted(threadId))
    const spawned = launch.find(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'spawnAgent',
    )
    const childThreadId = String(spawned?.params.item.receiverThreadIds[0] ?? '')
    assert.ok(childThreadId)
    assert.equal(
      launch.some(
        (m) =>
          (m.method === 'item/started' || m.method === 'item/completed') &&
          m.params.item.tool === 'wait',
      ),
      false,
      'a run_in_background agent gets no wait: nothing waits on it, and closing one marks it done',
    )
    assert.equal(launch.some(parentTurnCompleted(childThreadId)), false)
    assert.deepEqual(activityKinds(launch, threadId), ['started'])

    // The report completes the child, then Claude answers in a turn of its own.
    const report = await readUntil(reader, parentTurnCompleted(threadId))
    const childDone = report.findIndex(parentTurnCompleted(childThreadId))
    assert.ok(childDone >= 0)
    assert.equal(report[childDone].params.turn.status, 'completed')
    assert.ok(
      report.some(
        (m) =>
          m.method === 'item/agentMessage/delta' &&
          m.params.threadId === childThreadId &&
          m.params.delta === 'background report body',
      ),
    )
    const wake = report.findIndex(
      (m) => m.method === 'turn/started' && m.params.threadId === threadId,
    )
    assert.ok(wake > childDone, 'Claude answering the report opens a new parent turn')
    const wakeTurnId = report[wake].params.turn.id
    assert.notEqual(wakeTurnId, firstTurnId)
    const wakeItems = report
      .filter(
        (m) =>
          m.method === 'item/completed' &&
          m.params.threadId === threadId &&
          m.params.turnId === wakeTurnId,
      )
      .map((m) => m.params.item)
    assert.ok(
      wakeItems.some(
        (item) =>
          item.type === 'subAgentActivity' &&
          item.kind === 'completed' &&
          item.agentThreadId === childThreadId,
      ),
    )
    assert.ok(
      wakeItems.some(
        (item) =>
          item.type === 'agentMessage' &&
          /Background agent reported: background report body/.test(item.text),
      ),
    )
    assert.equal(report.at(-1).params.turn.status, 'completed')

    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const parent = (await reader.nextResponse(3)).result.thread
    assert.equal(parent.turns.length, 2)
    assert.equal(
      parent.turns[0].items.some(
        (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
      ),
      false,
      'no dangling wait in persisted history',
    )
    proc.stdin.write(json({ id: 4, method: 'thread/read', params: { threadId: childThreadId } }))
    const child = (await reader.nextResponse(4)).result.thread
    assert.equal(child.agentNickname, 'a0b1c2d3e4f5a6b7')
    assert.equal(child.turns[0].status, 'completed')

    // SendMessage to the agent is Codex's sendInput and reopens the child.
    proc.stdin.write(
      json({
        id: 5,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'background message check delay=600', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(5)
    const sent = await readUntil(reader, parentTurnCompleted(threadId))
    const sendInput = sent.find(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'sendInput',
    )?.params.item
    assert.ok(sendInput)
    assert.deepEqual(sendInput.receiverThreadIds, [childThreadId])
    assert.equal(sendInput.prompt, 'dig deeper')
    assert.equal(sendInput.agentsStates[childThreadId].status, 'running')
    assert.equal(
      sent.some((m) => m.method === 'item/started' && m.params.item.type === 'mcpToolCall'),
      false,
      'SendMessage must not render as a generic tool call',
    )
    const resumed = sent.find(
      (m) => m.method === 'turn/started' && m.params.threadId === childThreadId,
    )
    assert.ok(resumed)
    assert.ok(
      sent.some(
        (m) =>
          m.method === 'item/completed' &&
          m.params.threadId === childThreadId &&
          m.params.item.type === 'userMessage' &&
          m.params.item.content[0].text === 'dig deeper',
      ),
    )
    assert.deepEqual(activityKinds(sent, threadId), ['interacted'])

    const followUp = await readUntil(reader, parentTurnCompleted(threadId))
    const resumedDone = followUp.find(parentTurnCompleted(childThreadId))
    assert.equal(resumedDone?.params.turn.id, resumed.params.turn.id)
    assert.equal(resumedDone?.params.turn.status, 'completed')
    assert.ok(
      followUp.some(
        (m) =>
          m.method === 'item/completed' &&
          m.params.threadId === threadId &&
          m.params.item.type === 'agentMessage' &&
          /follow-up report/.test(m.params.item.text),
      ),
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

const PLAIN_VISUALIZE_REPLY =
  'Here is the chart.\n\nvisualize{"path":"/tmp/chart.html","mode":"wide"}'

const MARKED_VISUALIZE_REPLY =
  'Here is the chart.\n\n\uE200visualize\uE202{"path":"/tmp/chart.html","mode":"wide"}\uE201'

test('a visualize line Claude writes without the marks completes with them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('visualize line check') },
      }),
    )
    const seen = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    // The deltas stream the line as written; the App shows the completed
    // item in their place.
    const deltas = seen.filter((m) => m.method === 'item/agentMessage/delta')
    assert.equal(deltas.map((m) => m.params.delta).join(''), PLAIN_VISUALIZE_REPLY)
    assert.deepEqual(
      completedAgentMessages(seen, threadId).map((item) => item.text),
      [MARKED_VISUALIZE_REPLY],
    )

    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const [turn] = (await reader.nextResponse(3)).result.thread.turns
    assert.equal(
      turn.items.findLast((item: any) => item.type === 'agentMessage')?.text,
      MARKED_VISUALIZE_REPLY,
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('history reads add the marks to a visualize line stored without them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  await mkdir(join(home, 'claude-codex-adapter'), { recursive: true })
  const store = new SessionStore(join(home, 'claude-codex-adapter', 'state.sqlite'))
  const threadId = randomUUID()
  const turnId = randomUUID()
  const agentItemId = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  // A fenced copy is an example, not a visualization.
  const fenced = '```\nvisualize{"path":"/tmp/chart.html"}\n```'
  store.upsertThread({
    id: threadId,
    sessionId: threadId,
    forkedFromId: null,
    preview: 'chart',
    name: null,
    archived: false,
    cwd: process.cwd(),
    model: 'sonnet',
    reasoningEffort: null,
    modelProvider: 'claude-code',
    claudeSessionId: null,
    source: 'appServer',
    createdAt: now - 2,
    updatedAt: now - 1,
    status: { type: 'idle' },
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    ephemeral: false,
    threadSource: 'user',
    agentRole: null,
    agentNickname: null,
    baseInstructions: null,
    developerInstructions: null,
    personality: null,
    runtimeBackend: 'claude',
    codexSessionId: null,
  })
  store.upsertTurn({
    id: turnId,
    threadId,
    status: 'completed',
    startedAt: now - 2,
    completedAt: now - 1,
    durationMs: 1000,
    items: [
      {
        type: 'userMessage',
        id: randomUUID(),
        content: [{ type: 'text', text: 'chart', text_elements: [] }],
      },
      {
        type: 'agentMessage',
        id: agentItemId,
        text: `${PLAIN_VISUALIZE_REPLY}\n\n${fenced}`,
        phase: 'final_answer',
        memoryCitation: null,
      },
    ],
    diff: '',
    error: null,
  })
  store.close()

  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const expected = `${MARKED_VISUALIZE_REPLY}\n\n${fenced}`
  const agentText = (items: any[]) => items.find((item) => item.id === agentItemId)?.text
  const entryItems = (entries: any[]) => entries.flatMap((entry) => entry.item ?? [])
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)

    proc.stdin.write(json({ id: 1, method: 'thread/read', params: { threadId } }))
    const [read] = (await reader.nextResponse(1)).result.thread.turns
    assert.equal(agentText(read.items), expected)

    proc.stdin.write(json({ id: 2, method: 'thread/turns/list', params: { threadId } }))
    const [listed] = (await reader.nextResponse(2)).result.data
    assert.equal(agentText(listed.items), expected)

    proc.stdin.write(
      json({ id: 3, method: 'thread/turns/items/list', params: { threadId, turnId } }),
    )
    assert.equal(agentText((await reader.nextResponse(3)).result.data), expected)

    proc.stdin.write(json({ id: 4, method: 'thread/items/list', params: { threadId } }))
    assert.equal(agentText(entryItems((await reader.nextResponse(4)).result.data)), expected)

    proc.stdin.write(json({ id: 5, method: 'thread/timeline/list', params: { threadId } }))
    assert.equal(agentText(entryItems((await reader.nextResponse(5)).result.data)), expected)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

function heartbeatDeltas(messages: any[]): any[] {
  return messages.filter(
    (m) => m.method === 'item/agentMessage/delta' && /heartbeat/.test(m.params.delta),
  )
}

test('a turn that leaves a background agent running ends quiet, and the report does not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, { CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '' })
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('background subagent check delay=600') },
      }),
    )
    await reader.nextResponse(2)

    // The launching turn's answer ends with the App's DONT_NOTIFY heartbeat,
    // sent only in the completed item: the App shows a streaming message raw.
    const launch = await readUntil(reader, turnCompleted(threadId))
    const launched = completedAgentMessages(launch, threadId)
    assert.equal(launched.length, 1)
    assert.equal(launched[0].text, `agent launched in background\n\n${QUIET_TURN_HEARTBEAT}`)
    assert.equal(launched[0].phase, 'final_answer')
    assert.deepEqual(heartbeatDeltas(launch), [])

    // Nothing runs once the agent reported, so its turn lights the dot; the
    // child's own message never carries the block either.
    const report = await readUntil(reader, turnCompleted(threadId))
    const reported = completedAgentMessages(report, threadId)
    assert.ok(reported.some((item) => /Background agent reported/.test(item.text)))
    assert.equal(
      report.some(
        (m) =>
          m.method === 'item/completed' &&
          m.params.item.type === 'agentMessage' &&
          /heartbeat/.test(m.params.item.text),
      ),
      false,
    )
    assert.deepEqual(heartbeatDeltas(report), [])

    // History keeps what the App was sent.
    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const turns = (await reader.nextResponse(3)).result.thread.turns
    assert.equal(turns.length, 2)
    const lastText = (turn: any) =>
      turn.items.findLast((item: any) => item.type === 'agentMessage')?.text
    assert.equal(lastText(turns[0]), launched[0].text)
    assert.doesNotMatch(lastText(turns[1]), /heartbeat/)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// Starts a turn and returns its id with the agent messages it completed.
async function runQuietCheckTurn(
  reader: JsonLineReader,
  proc: ChildProcessWithoutNullStreams,
  threadId: string,
  id: number,
  text: string,
): Promise<{ turnId: string; messages: any[] }> {
  proc.stdin.write(json({ id, method: 'turn/start', params: { threadId, input: textInput(text) } }))
  const turnId = (await reader.nextResponse(id)).result.turn.id
  const seen = await readUntil(
    reader,
    (m) => m.method === 'turn/completed' && m.params.turn.id === turnId,
  )
  assert.equal(seen.at(-1).params.turn.status, 'completed')
  assert.deepEqual(heartbeatDeltas(seen), [])
  return { turnId, messages: completedAgentMessages(seen, threadId) }
}

test('quiet turns follow the background workflows of the thread', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, { CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '' })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    let nextId = 10
    const runTurn = (text: string) => runQuietCheckTurn(reader, proc, threadId, nextId++, text)

    // Nothing runs: the turn lights the dot.
    const plain = await runTurn('hello')
    assert.equal(plain.messages.length, 1)
    assert.doesNotMatch(plain.messages[0].text, /heartbeat/)

    // Claude's only text came before the Workflow call and completed as
    // commentary; it is completed again, same item, with the heartbeat.
    const textFirst = await runTurn('background workflow check text first')
    assert.deepEqual(
      textFirst.messages.map((item) => [item.id, item.phase, item.text]),
      [
        [textFirst.messages[0].id, 'commentary', 'starting the review workflow'],
        [
          textFirst.messages[0].id,
          'commentary',
          `starting the review workflow\n\n${QUIET_TURN_HEARTBEAT}`,
        ],
      ],
    )

    // The workflow still runs, so the next turn is quiet as well.
    const meanwhile = await runTurn('hello again')
    assert.equal(meanwhile.messages.length, 1)
    assert.ok(meanwhile.messages[0].text.endsWith(`\n\n${QUIET_TURN_HEARTBEAT}`))

    // A turn without a message has nothing to carry the block, and a
    // message of the heartbeat alone would show as a bubble of its own.
    const silent = await runTurn('background workflow check silent')
    assert.deepEqual(silent.messages, [])

    // Once the workflows stop, the turn lights the dot again.
    const stopped = await runTurn('workflow stop check')
    assert.deepEqual(
      stopped.messages.map((item) => item.text),
      ['workflows stopped'],
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a background shell alone never keeps a turn quiet', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, { CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '' })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)

    // A dev server can run for the rest of the chat: the turn that starts it,
    // and every turn while it runs, light the dot.
    const started = await runQuietCheckTurn(reader, proc, threadId, 10, 'background shell check')
    assert.deepEqual(
      started.messages.map((item) => item.text),
      ['dev server started'],
    )
    const meanwhile = await runQuietCheckTurn(reader, proc, threadId, 11, 'hello')
    assert.equal(meanwhile.messages.length, 1)
    assert.doesNotMatch(meanwhile.messages[0].text, /heartbeat/)
    proc.stdin.write(
      json({ id: 12, method: 'thread/backgroundTerminals/list', params: { threadId } }),
    )
    assert.equal((await reader.nextResponse(12)).result.data.length, 1)
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('CLAUDE_CODEX_QUIET_BACKGROUND_TURNS=0 lets every turn light the dot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home, { CLAUDE_CODEX_QUIET_BACKGROUND_TURNS: '0' })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    const started = await runQuietCheckTurn(reader, proc, threadId, 2, 'background workflow check')
    assert.deepEqual(
      started.messages.map((item) => item.text),
      ['review workflow started'],
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('SendMessage to a finished foreground agent reopens it like a background one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'subagent check', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(2)
    const ran = await readUntil(reader, turnCompleted(threadId))
    const childThreadId = String(
      ran.find((m) => m.method === 'item/completed' && m.params.item.tool === 'spawnAgent')?.params
        .item.receiverThreadIds[0] ?? '',
    )
    assert.ok(childThreadId)

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'foreground message check delay=300', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(3)
    const sent = await readUntil(reader, turnCompleted(threadId))
    const sendInput = sent.find(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'sendInput',
    )?.params.item
    assert.ok(sendInput, 'SendMessage to a foreground agent is a sendInput, not a plain card')
    assert.deepEqual(sendInput.receiverThreadIds, [childThreadId])
    assert.equal(
      sent.some((m) => m.method === 'item/started' && m.params.item.type === 'mcpToolCall'),
      false,
    )
    const reopened = sent.find(
      (m) => m.method === 'turn/started' && m.params.threadId === childThreadId,
    )
    assert.ok(reopened, 'the child gets a new turn for the message')
    assert.deepEqual(activityKinds(sent, threadId), ['interacted'])

    // The report settles the reopened turn and wakes the parent.
    const report = await readUntil(reader, turnCompleted(threadId))
    const reopenedDone = report.find(turnCompleted(childThreadId))
    assert.equal(reopenedDone?.params.turn.id, reopened.params.turn.id)
    assert.equal(reopenedDone?.params.turn.status, 'completed')
    assert.ok(
      report.some(
        (m) =>
          m.method === 'item/completed' &&
          m.params.threadId === threadId &&
          m.params.item.type === 'subAgentActivity' &&
          m.params.item.kind === 'completed' &&
          m.params.item.agentThreadId === childThreadId,
      ),
    )

    proc.stdin.write(json({ id: 4, method: 'thread/read', params: { threadId: childThreadId } }))
    const child = (await reader.nextResponse(4)).result.thread
    assert.deepEqual(
      child.turns.map((turn: any) => turn.status),
      ['completed', 'completed'],
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// The item/completed notifications that name a child: its collab tool calls
// and its activity markers.
function itemsNaming(messages: any[], childThreadId: string): any[] {
  return messages.filter(
    (m) =>
      m.method === 'item/completed' &&
      (m.params.item.receiverThreadIds?.includes(childThreadId) ||
        m.params.item.agentThreadId === childThreadId),
  )
}

// Where those items went, as `threadId/turnId`.
function placesOf(messages: any[]): string[] {
  return [...new Set(messages.map((m) => `${m.params.threadId}/${m.params.turnId}`))]
}

// The child thread an agent got, found by its prompt.
function childByPrompt(messages: any[], prompt: string): any {
  return messages.find((m) => m.method === 'thread/started' && m.params.thread.preview === prompt)
    ?.params.thread
}

test("an agent another agent launches hangs off that agent's child thread", async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('nested subagent check') },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id
    const seen = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const outer = childByPrompt(seen, 'plan the work')
    const inner = childByPrompt(seen, 'check one file')
    assert.ok(outer && inner)
    const outerTurnId = seen.find(
      (m) => m.method === 'turn/started' && m.params.threadId === outer.id,
    )?.params.turn.id
    assert.ok(outerTurnId)
    assert.equal(outer.parentThreadId, threadId)
    assert.equal(inner.parentThreadId, outer.id)
    assert.equal(inner.source.subAgent.thread_spawn.parent_thread_id, outer.id)
    assert.equal(inner.source.subAgent.thread_spawn.depth, 2)

    // The App finds a child through the spawn item of the conversation the
    // child names as its parent: the inner agent's items live in the outer
    // child's turn, sent by the outer child.
    const innerItems = itemsNaming(seen, inner.id)
    assert.deepEqual(placesOf(innerItems), [`${outer.id}/${outerTurnId}`])
    const innerCollab = innerItems
      .map((m) => m.params.item)
      .filter((item) => item.type === 'collabAgentToolCall')
    assert.deepEqual(
      innerCollab.map((item) => [item.tool, item.senderThreadId]),
      [
        ['spawnAgent', outer.id],
        ['wait', outer.id],
      ],
    )
    assert.equal(innerCollab[1].status, 'completed')
    const innerActivity = innerItems
      .map((m) => m.params.item)
      .find((item) => item.type === 'subAgentActivity')
    assert.match(innerActivity.agentPath, /^\/root\/[^/]+\/[^/]+$/)
    // The parent turn shows the outer agent only.
    assert.deepEqual(placesOf(itemsNaming(seen, outer.id)), [`${threadId}/${turnId}`])
    assert.equal(
      seen.some(
        (m) =>
          m.params?.threadId === threadId &&
          JSON.stringify(m.params.item ?? null).includes(inner.id),
      ),
      false,
    )

    // History and the topology queries agree.
    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId: outer.id } }))
    const outerRead = (await reader.nextResponse(3)).result.thread
    assert.ok(
      outerRead.turns[0].items.some(
        (item: any) => item.tool === 'spawnAgent' && item.receiverThreadIds[0] === inner.id,
      ),
    )
    const list = async (id: number, params: Record<string, unknown>) => {
      proc.stdin.write(
        json({
          id,
          method: 'thread/list',
          params: { ...params, sourceKinds: ['subAgentThreadSpawn'], limit: 200 },
        }),
      )
      return (await reader.nextResponse(id)).result.data.map((thread: any) => thread.id).sort()
    }
    assert.deepEqual(await list(4, { parentThreadId: threadId }), [outer.id])
    assert.deepEqual(await list(5, { parentThreadId: outer.id }), [inner.id])
    assert.deepEqual(await list(6, { ancestorThreadId: threadId }), [outer.id, inner.id].sort())
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('without the agent ids every agent hangs off the parent thread, as before', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('nested subagent check without ids') },
      }),
    )
    const turnId = (await reader.nextResponse(2)).result.turn.id
    const seen = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    for (const prompt of ['plan the work', 'check one file']) {
      const child = childByPrompt(seen, prompt)
      assert.equal(child.parentThreadId, threadId)
      assert.equal(child.source.subAgent.thread_spawn.depth, 1)
      const items = itemsNaming(seen, child.id)
      assert.deepEqual(placesOf(items), [`${threadId}/${turnId}`])
      for (const { params } of items) {
        if (params.item.type === 'collabAgentToolCall')
          assert.equal(params.item.senderThreadId, threadId)
        else assert.match(params.item.agentPath, /^\/root\/[^/]+$/)
      }
    }
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('agents a turn leaves running end with it, a nested one inside its host first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('nested subagent check without results') },
      }),
    )
    await reader.nextResponse(2)
    const seen = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const outer = childByPrompt(seen, 'plan the work')
    const inner = childByPrompt(seen, 'check one file')
    assert.ok(outer && inner)
    assert.equal(inner.parentThreadId, outer.id)
    const outerTurnId = seen.find(
      (m) => m.method === 'turn/started' && m.params.threadId === outer.id,
    )?.params.turn.id
    assert.ok(outerTurnId)

    // The inner agent ends, and its wait closes in the outer agent's turn,
    // before that turn ends.
    const at = (predicate: (m: any) => boolean) => seen.findIndex(predicate)
    const innerEnd = at((m) => m.method === 'turn/completed' && m.params.threadId === inner.id)
    const innerWait = at(
      (m) =>
        m.method === 'item/completed' &&
        m.params.item.tool === 'wait' &&
        m.params.item.receiverThreadIds?.[0] === inner.id,
    )
    const outerEnd = at((m) => m.method === 'turn/completed' && m.params.threadId === outer.id)
    assert.ok(innerEnd >= 0 && innerWait >= 0 && outerEnd >= 0)
    assert.ok(innerEnd < outerEnd && innerWait < outerEnd)
    assert.equal(seen[innerWait].params.threadId, outer.id)
    assert.equal(seen[innerWait].params.turnId, outerTurnId)
    assert.equal(seen[innerWait].params.item.status, 'failed')
    assert.equal(seen[innerEnd].params.turn.status, 'failed')
    assert.equal(seen[outerEnd].params.turn.status, 'failed')

    // Read back, nothing anywhere in the tree is left in progress.
    let id = 3
    for (const readId of [threadId, outer.id, inner.id]) {
      proc.stdin.write(
        json({ id, method: 'thread/read', params: { threadId: readId, includeTurns: true } }),
      )
      const read = (await reader.nextResponse(id)).result.thread
      id += 1
      assert.ok(read.turns.length > 0)
      for (const turn of read.turns) {
        assert.notEqual(turn.status, 'inProgress')
        for (const item of turn.items) assert.notEqual(item.status, 'inProgress', item.type)
      }
    }
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('an agent SendMessage resumes keeps its child thread, and the agents it launches hang off it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('subagent check') },
      }),
    )
    await reader.nextResponse(2)
    const ran = await readUntil(reader, turnCompleted(threadId))
    const childThreadId = String(
      ran.find((m) => m.method === 'item/completed' && m.params.item.tool === 'spawnAgent')?.params
        .item.receiverThreadIds[0] ?? '',
    )
    assert.ok(childThreadId)

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/start',
        params: { threadId, input: textInput('foreground message nested check delay=300') },
      }),
    )
    await reader.nextResponse(3)
    const sent = await readUntil(reader, turnCompleted(threadId))
    const sendInput = sent.find(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'sendInput',
    )?.params.item
    assert.deepEqual(sendInput?.receiverThreadIds, [childThreadId])
    const reopened = sent.find(
      (m) => m.method === 'turn/started' && m.params.threadId === childThreadId,
    )
    assert.ok(reopened, 'the message reopens the same child thread')
    const nested = childByPrompt(sent, 'check one file')
    assert.equal(nested?.parentThreadId, childThreadId)
    assert.equal(nested.source.subAgent.thread_spawn.depth, 2)
    const nestedItems = itemsNaming(sent, nested.id)
    assert.deepEqual(placesOf(nestedItems), [`${childThreadId}/${reopened.params.turn.id}`])
    assert.deepEqual(
      nestedItems
        .map((m) => m.params.item)
        .filter((item) => item.type === 'collabAgentToolCall')
        .map((item) => [item.tool, item.senderThreadId]),
      [
        ['spawnAgent', childThreadId],
        ['wait', childThreadId],
      ],
    )

    // The report settles the reopened turn: one child thread throughout.
    const report = await readUntil(reader, turnCompleted(threadId))
    assert.equal(report.find(turnCompleted(childThreadId))?.params.turn.id, reopened.params.turn.id)
    proc.stdin.write(json({ id: 4, method: 'thread/read', params: { threadId: childThreadId } }))
    const child = (await reader.nextResponse(4)).result.thread
    assert.deepEqual(
      child.turns.map((turn: any) => turn.status),
      ['completed', 'completed'],
    )
    assert.ok(
      child.turns[1].items.some(
        (item: any) => item.tool === 'spawnAgent' && item.receiverThreadIds[0] === nested.id,
      ),
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('TaskStop on a background agent is a closeAgent that ends the child as interrupted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    const startTurn = (id: number, text: string) =>
      proc.stdin.write(
        json({
          id,
          method: 'turn/start',
          params: { threadId, input: [{ type: 'text', text, text_elements: [] }] },
        }),
      )
    startTurn(2, 'background subagent check delay=5000')
    await reader.nextResponse(2)
    const launch = await readUntil(reader, turnCompleted(threadId))
    const childThreadId = String(
      launch.find((m) => m.method === 'item/completed' && m.params.item.tool === 'spawnAgent')
        ?.params.item.receiverThreadIds[0] ?? '',
    )
    assert.ok(childThreadId)

    startTurn(3, 'background close check')
    await reader.nextResponse(3)
    const stopped = await readUntil(reader, turnCompleted(threadId))
    const close = stopped.find(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'closeAgent',
    )?.params.item
    assert.ok(close, 'TaskStop on an agent is a closeAgent, not a plain card')
    assert.equal(close.status, 'completed')
    assert.deepEqual(close.receiverThreadIds, [childThreadId])
    assert.equal(close.agentsStates[childThreadId].status, 'interrupted')
    assert.equal(
      stopped.some((m) => m.method === 'item/started' && m.params.item.type === 'mcpToolCall'),
      false,
    )
    assert.equal(stopped.find(turnCompleted(childThreadId))?.params.turn.status, 'interrupted')
    assert.deepEqual(activityKinds(stopped, threadId), ['interrupted'])
    assert.equal(stopped.at(-1).params.turn.status, 'completed')

    proc.stdin.write(json({ id: 4, method: 'thread/read', params: { threadId: childThreadId } }))
    const child = (await reader.nextResponse(4)).result.thread
    assert.equal(child.turns.at(-1).status, 'interrupted')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a tool Claude runs beside an Agent call keeps its own card', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startMockThread(reader, proc)
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('parallel agent tool check') },
      }),
    )
    await reader.nextResponse(2)
    const turn = await readUntil(
      reader,
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
    )
    const parentItems = turn
      .filter((m) => m.method === 'item/completed' && m.params.threadId === threadId)
      .map((m) => m.params.item)
    const shell = parentItems.find((item) => item.type === 'commandExecution')
    assert.equal(shell?.status, 'completed', 'the parallel Bash call must not be swallowed')
    assert.ok(parentItems.some((item) => item.tool === 'spawnAgent'))
    assert.ok(parentItems.some((item) => item.tool === 'wait' && item.status === 'completed'))
    assert.ok(
      parentItems.some((item) => item.type === 'agentMessage' && item.text === 'both finished'),
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('an agent backgrounded mid-wait closes the wait without marking the child done', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'auto background check delay=600', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    const launch = await readUntil(reader, turnCompleted(threadId))
    const waits = launch.filter(
      (m) =>
        (m.method === 'item/started' || m.method === 'item/completed') &&
        m.params.item.tool === 'wait',
    )
    assert.deepEqual(
      waits.map((m) => `${m.method}:${m.params.item.status}`),
      ['item/started:inProgress', 'item/completed:failed'],
      'the wait began and must end, not vanish',
    )
    const waitEnd = waits[1].params.item
    const childThreadId = waitEnd.receiverThreadIds[0]
    // A completed wait would mark every working agent done in the App roster.
    assert.equal(waitEnd.agentsStates[childThreadId].status, 'running')
    assert.equal(launch.some(turnCompleted(childThreadId)), false)

    const report = await readUntil(reader, turnCompleted(threadId))
    assert.equal(report.find(turnCompleted(childThreadId))?.params.turn.status, 'completed')

    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const parent = (await reader.nextResponse(3)).result.thread
    const persistedWait = parent.turns[0].items.find(
      (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
    )
    assert.equal(persistedWait?.status, 'failed', 'reload shows the wait the App saw close')
    assert.equal(persistedWait?.agentsStates[childThreadId].status, 'running')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('stopping a background child interrupts it without waking the parent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            { type: 'text', text: 'background subagent check delay=30000', text_elements: [] },
          ],
        },
      }),
    )
    await reader.nextResponse(2)
    const launch = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const childStarted = launch.find(
      (m) => m.method === 'turn/started' && m.params.threadId !== threadId,
    )
    const childThreadId = childStarted.params.threadId

    // Codex sends turn/interrupt to every child with an in-progress turn.
    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/interrupt',
        params: { threadId: childThreadId, turnId: childStarted.params.turn.id },
      }),
    )
    const stopped = await readUntil(reader, (m) => m.id === 3 && m.method == null)
    const childDone = stopped.find(
      (m) => m.method === 'turn/completed' && m.params.threadId === childThreadId,
    )
    assert.equal(childDone?.params.turn.status, 'interrupted')

    // The parent had no turn to carry the activity; the next one does.
    proc.stdin.write(
      json({
        id: 4,
        method: 'turn/start',
        params: { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }] },
      }),
    )
    await reader.nextResponse(4)
    const next = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    assert.deepEqual(activityKinds(next, threadId), ['interrupted'])
    assert.equal(
      next.filter((m) => m.method === 'turn/started' && m.params.threadId === threadId).length,
      1,
      'only the user turn runs; a stopped agent does not wake Claude',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('deleting a thread stops its running background child and ends the child turn first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [
            { type: 'text', text: 'background subagent check delay=30000', text_elements: [] },
          ],
        },
      }),
    )
    await reader.nextResponse(2)
    const launch = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const childThreadId = launch.find(
      (m) => m.method === 'turn/started' && m.params.threadId !== threadId,
    ).params.threadId

    proc.stdin.write(json({ id: 3, method: 'thread/delete', params: { threadId } }))
    const deleted = await readUntil(reader, (m) => m.id === 3 && m.method == null)
    assert.equal(deleted.at(-1).error, undefined)
    const childDone = deleted.findIndex(
      (m) => m.method === 'turn/completed' && m.params.threadId === childThreadId,
    )
    const childGone = deleted.findIndex(
      (m) => m.method === 'thread/deleted' && m.params.threadId === childThreadId,
    )
    assert.notEqual(childDone, -1, 'the running child turn must end')
    assert.equal(deleted[childDone].params.turn.status, 'interrupted')
    assert.ok(childDone < childGone, 'the child turn ends before its thread goes')
    assert.ok(deleted.some((m) => m.method === 'thread/deleted' && m.params.threadId === threadId))
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('stopping a foreground child ends it as interrupted and the parent carries on', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: { threadId, input: textInput('foreground stop check') },
      }),
    )
    await reader.nextResponse(2)
    const launch = await readUntil(
      reader,
      (m) => m.method === 'item/started' && m.params.item?.tool === 'wait',
    )
    const childStarted = launch.find(
      (m) => m.method === 'turn/started' && m.params.threadId !== threadId,
    )
    const childThreadId = childStarted.params.threadId

    proc.stdin.write(
      json({
        id: 3,
        method: 'turn/interrupt',
        params: { threadId: childThreadId, turnId: childStarted.params.turn.id },
      }),
    )
    const rest = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const childDone = rest.filter(
      (m) => m.method === 'turn/completed' && m.params.threadId === childThreadId,
    )
    assert.deepEqual(
      childDone.map((m) => m.params.turn.status),
      ['interrupted'],
      'the child ends once, as interrupted, and its late result does not overwrite it',
    )
    const parentDone = rest.find(
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    assert.equal(parentDone.params.turn.status, 'completed', 'the parent turn keeps going')
    const waitEnd = rest.find(
      (m) => m.method === 'item/completed' && m.params.item?.tool === 'wait',
    ).params.item
    assert.equal(waitEnd.agentsStates[childThreadId].status, 'interrupted')
    assert.deepEqual(activityKinds(rest, threadId), ['interrupted'])

    proc.stdin.write(
      json({
        id: 4,
        method: 'thread/read',
        params: { threadId: childThreadId, includeTurns: true },
      }),
    )
    const child = (await reader.nextResponse(4)).result.thread
    assert.equal(child.turns.at(-1).status, 'interrupted')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// Codex App 26.930's subagent roster reducer (app-initial I5t), reduced to the
// status it shows per agent for one parent turn's items.
function appRoster(items: any[], isTurnLive: boolean): Map<string, string> {
  const fromState: Record<string, string> = {
    pendingInit: 'waiting',
    running: 'working',
    completed: 'done',
    interrupted: 'done',
    shutdown: 'done',
    errored: 'failed',
    notFound: 'failed',
  }
  const busy = (status: string) => status === 'waiting' || status === 'working'
  const roster = new Map<string, string>()
  const status = (id: string) => roster.get(id) ?? 'working'
  for (const item of items) {
    if (item.type === 'subAgentActivity') {
      const ended = item.kind === 'completed' || item.kind === 'interrupted'
      roster.set(item.agentThreadId, ended ? 'done' : 'working')
      continue
    }
    if (item.type !== 'collabAgentToolCall') continue
    const spawning = ['spawnAgent', 'sendInput', 'resumeAgent'].includes(item.tool)
    for (const id of item.receiverThreadIds)
      roster.set(id, item.status !== 'failed' && spawning ? 'working' : status(id))
    for (const [id, state] of Object.entries<any>(item.agentsStates ?? {}))
      roster.set(id, fromState[state.status] ?? status(id))
    if (item.tool === 'wait' && item.status === 'completed')
      for (const [id, value] of roster) if (busy(value)) roster.set(id, 'done')
  }
  if (!isTurnLive) for (const [id, value] of roster) if (busy(value)) roster.set(id, 'done')
  return roster
}

// The parent thread's items as the App holds them: first appearance order,
// latest state.
function liveItems(messages: any[], threadId: string): any[] {
  const items = new Map<string, any>()
  for (const m of messages)
    if (
      (m.method === 'item/started' || m.method === 'item/completed') &&
      m.params.threadId === threadId
    )
      items.set(m.params.item.id, m.params.item)
  return [...items.values()]
}

test('a foreground agent finishing beside a background one leaves the background agent working', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  const turnCompleted = (threadId: string) => (message: any) =>
    message.method === 'turn/completed' && message.params.threadId === threadId
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'mixed agents check delay=400', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    const launch = await readUntil(reader, turnCompleted(threadId))
    const spawned = launch
      .filter((m) => m.method === 'item/completed' && m.params.item.tool === 'spawnAgent')
      .map((m) => m.params.item)
    const bgChild = String(
      spawned.find((item) => item.prompt === 'sleep then report')?.receiverThreadIds[0],
    )
    const fgChild = String(
      spawned.find((item) => item.prompt === 'answer now')?.receiverThreadIds[0],
    )
    const waitEnd = launch.findIndex(
      (m) => m.method === 'item/completed' && m.params.item.tool === 'wait',
    )
    assert.ok(waitEnd >= 0, 'the foreground agent is waited on')
    const wait = launch[waitEnd].params.item
    assert.deepEqual(wait.receiverThreadIds, [fgChild])
    assert.equal(wait.agentsStates[fgChild].status, 'completed')
    assert.equal(wait.status, 'failed', 'a completed wait would end the background agent too')
    assert.equal(launch.some(turnCompleted(bgChild)), false)

    const roster = appRoster(liveItems(launch.slice(0, waitEnd + 1), threadId), true)
    assert.equal(roster.get(fgChild), 'done')
    assert.equal(roster.get(bgChild), 'working')

    const report = await readUntil(reader, turnCompleted(threadId))
    const childDone = report.find(turnCompleted(bgChild))
    assert.equal(childDone?.params.turn.status, 'completed')
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('the first of two foreground agents to finish does not end the other in the App roster', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(json({ id: 1, method: 'thread/start', params: { cwd: process.cwd() } }))
    const threadId = (await reader.nextResponse(1)).result.thread.id
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'sibling agents check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    const turn = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const child = (prompt: string) =>
      String(
        turn.find(
          (m) =>
            m.method === 'item/completed' &&
            m.params.item.tool === 'spawnAgent' &&
            m.params.item.prompt === prompt,
        )?.params.item.receiverThreadIds[0],
      )
    const quick = child('quick agent')
    const slow = child('slow agent')
    const waitEnds = turn
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => m.method === 'item/completed' && m.params.item.tool === 'wait')
    assert.equal(waitEnds.length, 2)
    const [first, second] = waitEnds
    assert.deepEqual(first?.m.params.item.receiverThreadIds, [quick])
    assert.equal(first?.m.params.item.status, 'failed')
    assert.equal(first?.m.params.item.agentsStates[quick].status, 'completed')
    const midway = appRoster(liveItems(turn.slice(0, (first?.index ?? 0) + 1), threadId), true)
    assert.equal(midway.get(quick), 'done')
    assert.equal(midway.get(slow), 'working')

    assert.deepEqual(second?.m.params.item.receiverThreadIds, [slow])
    assert.equal(second?.m.params.item.status, 'completed', 'the last agent closes normally')
    const settled = appRoster(liveItems(turn, threadId), false)
    assert.deepEqual([settled.get(quick), settled.get(slow)], ['done', 'done'])

    proc.stdin.write(json({ id: 3, method: 'thread/read', params: { threadId } }))
    const persisted = (await reader.nextResponse(3)).result.thread.turns[0].items
    const persistedWaits = persisted.filter((item: any) => item.tool === 'wait')
    assert.deepEqual(
      persistedWaits.map((item: any) => item.status).sort(),
      ['completed', 'failed'],
      'reload shows the same wait states the App saw live',
    )
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test("the spawn card shows an agent's own model and effort, and a fork's parent settings", async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawn(process.execPath, [adapter, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  const reader = new JsonLineReader(proc)
  try {
    proc.stdin.write(json(codex930Initialize(0)))
    await reader.nextResponse(0)
    proc.stdin.write(
      json({ id: 1, method: 'thread/start', params: { cwd: process.cwd(), effort: 'medium' } }),
    )
    const start = (await reader.nextResponse(1)).result
    const threadId = start.thread.id
    assert.equal(start.reasoningEffort, 'medium')
    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'subagent effort check', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)
    const turn = await readUntil(
      reader,
      (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
    )
    const spawned = (prompt: string) =>
      turn.find(
        (m) =>
          m.method === 'item/completed' &&
          m.params.item.tool === 'spawnAgent' &&
          m.params.item.prompt === prompt,
      )?.params.item
    const own = spawned('own agent')
    assert.equal(own?.model, 'opus')
    // Claude's max effort is past the App's scale; its top is xhigh.
    assert.equal(own?.reasoningEffort, 'xhigh')
    const fork = spawned('fork agent')
    assert.equal(fork?.model, start.model, "a fork runs on its parent's model")
    assert.notEqual(fork?.model, 'haiku')
    assert.equal(fork?.reasoningEffort, 'medium', "a fork runs at its parent's effort")
    // Claude matches the agent type ignoring case.
    assert.equal(spawned('named fork')?.model, start.model)

    proc.stdin.write(
      json({ id: 3, method: 'thread/read', params: { threadId: fork?.receiverThreadIds[0] } }),
    )
    assert.equal((await reader.nextResponse(3)).result.thread.agentRole, 'fork')

    // A CLI older than the Agent effort input runs the agent at its parent's
    // effort; one that has it honors it. An unknown version (above) honors it.
    let id = 4
    for (const [cli, effort] of [
      ['2.1.291', 'medium'],
      ['2.1.292', 'xhigh'],
    ] as const) {
      proc.stdin.write(
        json({
          id,
          method: 'turn/start',
          params: {
            threadId,
            input: [
              { type: 'text', text: `subagent effort check on cli ${cli}`, text_elements: [] },
            ],
          },
        }),
      )
      await reader.nextResponse(id)
      id += 1
      const gated = await readUntil(
        reader,
        (m) => m.method === 'turn/completed' && m.params.threadId === threadId,
      )
      const item = gated.find(
        (m) =>
          m.method === 'item/completed' &&
          m.params.item.tool === 'spawnAgent' &&
          m.params.item.prompt === 'own agent',
      )?.params.item
      assert.equal(item?.model, 'opus', cli)
      assert.equal(item?.reasoningEffort, effort, cli)
    }
  } finally {
    proc.kill()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

function codex930Initialize(id: number) {
  return {
    id,
    method: 'initialize',
    params: {
      clientInfo: { name: 'Codex Desktop', title: 'Codex Desktop', version: '26.930.21537' },
      capabilities: { experimentalApi: true },
    },
  }
}

function activityKinds(messages: any[], threadId: string): string[] {
  return messages
    .filter(
      (m) =>
        m.method === 'item/completed' &&
        m.params.threadId === threadId &&
        m.params.item.type === 'subAgentActivity',
    )
    .map((m) => m.params.item.kind)
}
