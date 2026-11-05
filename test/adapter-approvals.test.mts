import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  adapter,
  awaitMessage,
  completedAgentMessages,
  completedItems,
  JsonLineReader,
  json,
  mockTurnMessages,
  readQuiet,
  sendTurn,
  spawnMockAdapter,
  stopProcess,
  textInput,
} from './support/adapter-harness.mjs'

test('approval requests round-trip through Codex server requests', {
  timeout: 15_000,
}, async () => {
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
        params: {
          cwd: process.cwd(),
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          permissions: ':workspace',
        },
      }),
    )
    const start = await reader.nextResponse(1)
    const threadId = start.result.thread.id

    proc.stdin.write(
      json({
        id: 2,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: 'please run approval bash', text_elements: [] }],
        },
      }),
    )
    await reader.nextResponse(2)

    let approvalRequest: any = null
    let sawWaitingOnApproval = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (
        message.method === 'thread/status/changed' &&
        message.params.status.activeFlags?.includes('waitingOnApproval')
      ) {
        sawWaitingOnApproval = true
      }
      if (message.method === 'item/commandExecution/requestApproval') {
        approvalRequest = message
        break
      }
    }
    assert.equal(approvalRequest?.params.command, 'echo mock approval')
    assert.deepEqual(approvalRequest?.params.commandActions, [
      { type: 'unknown', command: 'echo mock approval' },
    ])
    assert.deepEqual(approvalRequest?.params.availableDecisions, [
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ])
    assert.equal(sawWaitingOnApproval, true)
    proc.stdin.write(json({ id: approvalRequest.id, result: { decision: 'accept' } }))

    let sawResolved = false
    let sawOutput = false
    for (let i = 0; i < 100; i += 1) {
      const message = await reader.next()
      if (message.method === 'serverRequest/resolved') sawResolved = true
      if (
        message.method === 'item/commandExecution/outputDelta' &&
        /mock approval/.test(message.params.delta)
      )
        sawOutput = true
      if (message.method === 'turn/completed') break
    }
    assert.equal(sawResolved, true)
    assert.equal(sawOutput, true)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// A thread whose approvals reach the App, and a turn sent on it.
async function startAskingThread(
  reader: JsonLineReader,
  proc: ChildProcessWithoutNullStreams,
  id: number,
): Promise<string> {
  proc.stdin.write(
    json({
      id,
      method: 'thread/start',
      params: { cwd: process.cwd(), persistExtendedHistory: false, permissions: ':workspace' },
    }),
  )
  return (await reader.nextResponse(id)).result.thread.id
}

function completedItem(messages: any[], itemId: string): any {
  return messages.find(
    (message) => message.method === 'item/completed' && message.params.item.id === itemId,
  )?.params.item
}

test('a declined command approval ends the command declined and the turn goes on', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startAskingThread(reader, proc, 1)
    sendTurn(proc, 2, threadId, 'please run approval bash')
    const request = await awaitMessage(
      reader,
      (message) => message.method === 'item/commandExecution/requestApproval',
    )
    assert.equal(request.params.reason, 'mock approval reason')
    assert.equal(request.params.cwd, process.cwd())
    assert.deepEqual(request.params.availableDecisions, [
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ])
    proc.stdin.write(json({ id: request.id, result: { decision: 'decline' } }))

    const seen: any[] = []
    const done = await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    assert.equal(done.params.turn.status, 'completed')
    const item = completedItem(seen, request.params.itemId)
    assert.equal(item.type, 'commandExecution')
    assert.equal(item.status, 'declined')
    assert.equal(item.exitCode, null)
    assert.equal(item.aggregatedOutput, null)
    assert.equal(
      seen.some(
        (message) =>
          message.method === 'item/commandExecution/outputDelta' &&
          message.params.itemId === request.params.itemId,
      ),
      false,
      "Claude's refusal text is not shown as output",
    )
    assert.equal(
      seen.filter(
        (message) =>
          message.method === 'item/completed' && message.params.item.id === request.params.itemId,
      ).length,
      1,
    )
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a cancelled approval declines the call and interrupts the turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startAskingThread(reader, proc, 1)
    sendTurn(proc, 2, threadId, 'please run approval bash')
    const request = await awaitMessage(
      reader,
      (message) => message.method === 'item/commandExecution/requestApproval',
    )
    proc.stdin.write(json({ id: request.id, result: { decision: 'cancel' } }))

    const seen: any[] = []
    const done = await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    assert.equal(done.params.turn.status, 'interrupted')
    assert.equal(completedItem(seen, request.params.itemId)?.status, 'declined')
    const late = await readQuiet(reader, 300)
    assert.equal(
      late.some((message) => message.method === 'turn/completed'),
      false,
      'the turn ends once',
    )
    assert.equal(completedItem(late, request.params.itemId), undefined)
    assert.ok(
      [...seen, ...late].some(
        (message) =>
          message.method === 'thread/status/changed' && message.params.status.type === 'idle',
      ),
    )

    // The thread takes the next turn.
    sendTurn(proc, 3, threadId, 'please run approval bash')
    const next = await awaitMessage(
      reader,
      (message) => message.method === 'item/commandExecution/requestApproval',
    )
    proc.stdin.write(json({ id: next.id, result: { decision: 'accept' } }))
    const nextDone = await awaitMessage(reader, (message) => message.method === 'turn/completed')
    assert.equal(nextDone.params.turn.status, 'completed')
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('an MCP tool asks with the App tool approval card and keeps a session approval', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startAskingThread(reader, proc, 1)
    sendTurn(proc, 2, threadId, 'mcp ask check')
    const turnId = (await reader.nextResponse(2)).result.turn.id
    const before: any[] = []
    const request = await awaitMessage(
      reader,
      (message) => message.method === 'mcpServer/elicitation/request',
      before,
    )
    assert.deepEqual(request.params, {
      threadId,
      turnId,
      serverName: 'Docs Server',
      mode: 'form',
      message: 'Allow the Docs Server MCP server to run tool "lookup"?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: 'session',
        tool_name: 'lookup',
        tool_params: { query: 'claude codex' },
        reason: 'mock tool reason',
      },
    })
    assert.ok(
      before.some(
        (message) =>
          message.method === 'thread/status/changed' &&
          message.params.status.activeFlags?.includes('waitingOnApproval'),
      ),
    )
    proc.stdin.write(
      json({
        id: request.id,
        result: { action: 'accept', content: null, _meta: { persist: 'session' } },
      }),
    )
    const first: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', first)
    const call = first.find(
      (message) =>
        message.method === 'item/completed' && message.params.item.type === 'mcpToolCall',
    )?.params.item
    assert.equal(call?.status, 'completed')

    // The same tool runs again without asking.
    sendTurn(proc, 3, threadId, 'mcp ask check')
    const second: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', second)
    assert.equal(
      second.some((message) => message.method === 'mcpServer/elicitation/request'),
      false,
    )
    assert.ok(
      second.some(
        (message) =>
          message.method === 'item/completed' &&
          message.params.item.type === 'mcpToolCall' &&
          message.params.item.status === 'completed',
      ),
    )

    // Another thread asks again; declining fails the call and Claude goes on.
    const otherThreadId = await startAskingThread(reader, proc, 4)
    sendTurn(proc, 5, otherThreadId, 'mcp ask check')
    const again = await awaitMessage(
      reader,
      (message) => message.method === 'mcpServer/elicitation/request',
    )
    proc.stdin.write(json({ id: again.id, result: { action: 'decline', content: null } }))
    const declined: any[] = []
    const done = await awaitMessage(
      reader,
      (message) => message.method === 'turn/completed',
      declined,
    )
    assert.equal(done.params.turn.status, 'completed')
    const failed = declined.find(
      (message) =>
        message.method === 'item/completed' && message.params.item.type === 'mcpToolCall',
    )?.params.item
    assert.equal(failed?.status, 'failed')
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('other Claude tools ask as command approvals naming the tool', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startAskingThread(reader, proc, 1)
    sendTurn(proc, 2, threadId, 'fetch ask check')
    const before: any[] = []
    const request = await awaitMessage(
      reader,
      (message) =>
        message.method === 'item/commandExecution/requestApproval' ||
        message.method === 'item/fileChange/requestApproval',
      before,
    )
    assert.equal(request.method, 'item/commandExecution/requestApproval')
    assert.equal(request.params.command, 'WebFetch https://example.com/docs')
    assert.equal(request.params.reason, 'mock tool reason')
    const item = before.find(
      (message) =>
        message.method === 'item/started' && message.params.item.id === request.params.itemId,
    )?.params.item
    assert.equal(item?.type, 'webSearch')
    proc.stdin.write(json({ id: request.id, result: { decision: 'acceptForSession' } }))
    await awaitMessage(reader, (message) => message.method === 'turn/completed')

    // The same call runs again without asking.
    sendTurn(proc, 3, threadId, 'fetch ask check')
    const second: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', second)
    assert.equal(
      second.some((message) => message.method === 'item/commandExecution/requestApproval'),
      false,
    )

    // A call Claude offers no "always allow" for gets no session choice.
    const strictThreadId = await startAskingThread(reader, proc, 4)
    sendTurn(proc, 5, strictThreadId, 'fetch ask check strict')
    const strict = await awaitMessage(
      reader,
      (message) => message.method === 'item/commandExecution/requestApproval',
    )
    assert.deepEqual(strict.params.availableDecisions, ['accept', 'decline', 'cancel'])
    proc.stdin.write(json({ id: strict.id, result: { decision: 'accept' } }))
    await awaitMessage(reader, (message) => message.method === 'turn/completed')
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// The permission changes an approval had Claude Code apply, as the mock
// runtime reports them, or null for none.
function appliedUpdates(messages: any[]): unknown {
  const text = messages
    .filter((message) => message.method === 'item/agentMessage/delta')
    .map((message) => message.params.delta)
    .join('')
  const match = /updatedPermissions=(.+)/.exec(text)
  return match ? JSON.parse(match[1] ?? 'null') : null
}

test('"Allow similar commands" saves the Bash rule Claude offers, and only when picked', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const amendment = (words: string[]) => ({
    acceptWithExecpolicyAmendment: { execpolicy_amendment: words },
  })
  // Asks on a new thread and answers; what Claude Code was told to apply.
  const answer = async (id: number, prompt: string, decision: unknown) => {
    const threadId = await startAskingThread(reader, proc, id)
    sendTurn(proc, id + 1, threadId, prompt)
    const request = await awaitMessage(
      reader,
      (message) => message.method === 'item/commandExecution/requestApproval',
    )
    proc.stdin.write(json({ id: request.id, result: { decision } }))
    const seen: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    assert.equal(completedItem(seen, request.params.itemId)?.status, 'completed')
    return { threadId, request, updates: appliedUpdates(seen) }
  }
  try {
    // Claude offers to save Bash(echo mock *): the card offers the prefix.
    let asked: any = null
    const saved = await answer(1, 'always allow approval bash', amendment(['echo', 'mock']))
    asked = saved.request
    assert.deepEqual(asked.params.proposedExecpolicyAmendment, ['echo', 'mock'])
    assert.deepEqual(asked.params.availableDecisions, [
      'accept',
      amendment(['echo', 'mock']),
      'acceptForSession',
      'decline',
      'cancel',
    ])
    // Picking it has Claude Code save the rule to the project's local
    // settings.
    assert.deepEqual(saved.updates, [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'echo mock *' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ])
    // And the thread asks no more for the command.
    sendTurn(proc, 3, saved.threadId, 'always allow approval bash')
    const again: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', again)
    assert.equal(
      again.some((message) => message.method === 'item/commandExecution/requestApproval'),
      false,
    )

    // Approving once or for the session saves nothing, nor does a prefix
    // other than the one the card showed.
    assert.equal((await answer(4, 'always allow approval bash', 'accept')).updates, null)
    assert.equal((await answer(6, 'always allow approval bash', 'acceptForSession')).updates, null)
    assert.equal((await answer(8, 'always allow approval bash', amendment(['echo']))).updates, null)

    // A call Claude offers no "always allow" for offers nothing to save.
    const strict = await answer(
      10,
      'always allow approval bash strict',
      amendment(['echo', 'mock']),
    )
    assert.equal(strict.request.params.proposedExecpolicyAmendment, null)
    assert.deepEqual(strict.request.params.availableDecisions, ['accept', 'decline', 'cancel'])
    assert.equal(strict.updates, null)

    // Nor does a call Claude offers no rule for.
    const plain = await answer(12, 'please run approval bash', 'acceptForSession')
    assert.equal(plain.request.params.proposedExecpolicyAmendment, null)
    assert.equal(plain.updates, null)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('"Allow for this session" covers the call as in Codex, and adds the session rules Claude offers only when switched on', async () => {
  // Claude's session rule covers every fetch from the domain, more than the
  // call the card showed, so it goes on only with the switch; the mode
  // switch Claude also offers never does.
  const sessionRule = {
    type: 'addRules',
    rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }],
    behavior: 'allow',
    destination: 'session',
  }
  for (const [env, updates] of [
    [{}, null],
    [{ CLAUDE_CODEX_SESSION_SUGGESTIONS: '1' }, [sessionRule]],
  ] as const) {
    const label = JSON.stringify(env)
    const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
    const proc = spawnMockAdapter(home, env)
    const reader = new JsonLineReader(proc)
    try {
      const threadId = await startAskingThread(reader, proc, 1)
      sendTurn(proc, 2, threadId, 'fetch ask check always allow')
      const request = await awaitMessage(
        reader,
        (message) => message.method === 'item/commandExecution/requestApproval',
      )
      // Only a shell command offers a rule to save.
      assert.equal(request.params.proposedExecpolicyAmendment, null, label)
      assert.deepEqual(
        request.params.availableDecisions,
        ['accept', 'acceptForSession', 'decline', 'cancel'],
        label,
      )
      proc.stdin.write(json({ id: request.id, result: { decision: 'acceptForSession' } }))
      const seen: any[] = []
      await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
      assert.deepEqual(appliedUpdates(seen), updates, label)

      // Either way the thread asks no more for that same call.
      sendTurn(proc, 3, threadId, 'fetch ask check always allow')
      const again: any[] = []
      await awaitMessage(reader, (message) => message.method === 'turn/completed', again)
      assert.equal(
        again.some((message) => message.method === 'item/commandExecution/requestApproval'),
        false,
        label,
      )
    } finally {
      await stopProcess(proc)
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
    }
  }
})

test('"Always allow" on an MCP tool card saves a rule for that tool of that server alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  // Asks on the thread and answers; the card and what Claude Code was told
  // to apply.
  const answer = async (id: number, threadId: string, prompt: string, result: unknown) => {
    sendTurn(proc, id, threadId, prompt)
    const request = await awaitMessage(
      reader,
      (message) => message.method === 'mcpServer/elicitation/request',
    )
    proc.stdin.write(json({ id: request.id, result }))
    const seen: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    return { request, updates: appliedUpdates(seen) }
  }
  const always = { action: 'accept', content: null, _meta: { persist: 'always' } }
  try {
    const threadId = await startAskingThread(reader, proc, 1)
    const saved = await answer(2, threadId, 'mcp ask check always allow server git', always)
    assert.equal(saved.request.params.serverName, 'git')
    assert.equal(saved.request.params._meta.tool_name, 'lookup')
    assert.deepEqual(saved.request.params._meta.persist, ['session', 'always'])
    assert.deepEqual(saved.updates, [
      {
        type: 'addRules',
        rules: [{ toolName: 'mcp__git__lookup' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ])

    // Servers whose names start the same are other servers: their tools ask.
    for (const [id, server] of [
      [3, 'github'],
      [4, 'git__hub'],
    ] as const) {
      const other = await answer(id, threadId, `mcp ask check always allow server ${server}`, {
        action: 'decline',
        content: null,
      })
      assert.equal(other.request.params.serverName, server)
      assert.equal(other.request.params._meta.tool_name, 'lookup')
      assert.equal(other.updates, null)
    }

    // "Allow for this session" saves nothing.
    const sessionThreadId = await startAskingThread(reader, proc, 5)
    const session = await answer(6, sessionThreadId, 'mcp ask check always allow server git', {
      action: 'accept',
      content: null,
      _meta: { persist: 'session' },
    })
    assert.equal(session.updates, null)

    // Without a rule from Claude the card offers the session only, and with
    // no "always allow" from Claude nothing at all.
    const plainThreadId = await startAskingThread(reader, proc, 7)
    const plain = await answer(8, plainThreadId, 'mcp ask check server git', always)
    assert.equal(plain.request.params._meta.persist, 'session')
    assert.equal(plain.updates, null)
    const strictThreadId = await startAskingThread(reader, proc, 9)
    const strict = await answer(
      10,
      strictThreadId,
      'mcp ask check always allow strict server git',
      always,
    )
    assert.equal('persist' in strict.request.params._meta, false)
    assert.equal(strict.updates, null)
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a call Claude refuses without asking ends declined', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  try {
    const threadId = await startAskingThread(reader, proc, 1)
    sendTurn(proc, 2, threadId, 'denied ask check')
    const seen: any[] = []
    const done = await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    assert.equal(done.params.turn.status, 'completed')
    assert.equal(
      seen.some((message) => /requestApproval$/.test(String(message.method ?? ''))),
      false,
    )
    const command = seen.find(
      (message) =>
        message.method === 'item/completed' && message.params.item.type === 'commandExecution',
    )?.params.item
    assert.equal(command?.command, 'rm -rf build')
    assert.equal(command?.status, 'declined')
    assert.equal(command?.exitCode, null)
    assert.ok(
      seen.some(
        (message) =>
          message.method === 'warning' &&
          message.params.message === 'Permission denied for Bash: matches a deny rule',
      ),
    )
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

// Requests and turns against one mock adapter, keeping what arrives meanwhile.
function autoReviewClient(reader: JsonLineReader, proc: ChildProcessWithoutNullStreams) {
  let nextId = 1
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = nextId++
    proc.stdin.write(json({ id, method, params }))
    const seen: any[] = []
    const response = await awaitMessage(
      reader,
      (message) => message.id === id && message.method == null,
      seen,
    )
    return { result: response.result, seen }
  }
  const turn = async (threadId: string, text: string, params: Record<string, unknown> = {}) => {
    const { seen } = await request('turn/start', { threadId, input: textInput(text), ...params })
    if (!seen.some((message) => message.method === 'turn/completed'))
      await awaitMessage(reader, (message) => message.method === 'turn/completed', seen)
    return { reply: completedAgentMessages(seen, threadId).at(-1)?.text, seen }
  }
  return { request, turn }
}

test('the auto-review preset runs a thread under auto review and the thread keeps it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const { request, turn } = autoReviewClient(reader, proc)
  const workspace = { cwd: process.cwd(), persistExtendedHistory: false, permissions: ':workspace' }
  try {
    // Nothing changes for a thread that does not ask for it.
    const plain = await request('thread/start', workspace)
    assert.equal(plain.result.approvalsReviewer, 'user')
    assert.equal(
      (await turn(plain.result.thread.id, 'auto review check')).reply,
      'autoReview=false',
    )

    // The App's preset names the reviewer guardian_subagent.
    const started = await request('thread/start', {
      ...workspace,
      approvalsReviewer: 'guardian_subagent',
    })
    const threadId = started.result.thread.id
    assert.equal(started.result.approvalsReviewer, 'auto_review')
    assert.equal((await turn(threadId, 'auto review check')).reply, 'autoReview=true')

    const toUser = await request('thread/settings/update', { threadId, approvalsReviewer: 'user' })
    assert.deepEqual(toUser.result, {})
    const echoed = toUser.seen.find((message) => message.method === 'thread/settings/updated')
    assert.equal(echoed?.params.threadSettings.approvalsReviewer, 'user')
    assert.equal((await turn(threadId, 'auto review check')).reply, 'autoReview=false')

    // turn/start sets it for its own turn and the ones after.
    const set = await turn(threadId, 'auto review check', { approvalsReviewer: 'auto_review' })
    assert.equal(set.reply, 'autoReview=true')
    assert.equal((await turn(threadId, 'auto review check')).reply, 'autoReview=true')

    const resumed = await request('thread/resume', { threadId })
    assert.equal(resumed.result.approvalsReviewer, 'auto_review')
    const forked = await request('thread/fork', { threadId, persistExtendedHistory: false })
    assert.equal(forked.result.approvalsReviewer, 'auto_review')
    assert.equal(
      (await turn(forked.result.thread.id, 'auto review check')).reply,
      'autoReview=true',
    )
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a thread whose session has no auto mode keeps the user as reviewer and says why', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const { request, turn } = autoReviewClient(reader, proc)
  try {
    const started = await request('thread/start', {
      cwd: process.cwd(),
      persistExtendedHistory: false,
      permissions: ':workspace',
      approvalsReviewer: 'auto_review',
    })
    const threadId = started.result.thread.id
    const { seen } = await turn(threadId, 'auto review unsupported')
    assert.deepEqual(
      seen.filter((message) => message.method === 'configWarning').map((message) => message.params),
      [
        {
          summary: 'Auto-review is not available on this Claude thread; you will review approvals.',
          details: 'mock model does not support auto mode.',
        },
      ],
    )
    const echoed = seen.find((message) => message.method === 'thread/settings/updated')
    assert.equal(echoed?.params.threadId, threadId)
    assert.equal(echoed?.params.threadSettings.approvalsReviewer, 'user')

    const resumed = await request('thread/resume', { threadId })
    assert.equal(resumed.result.approvalsReviewer, 'user')
    const next = await turn(threadId, 'auto review unsupported')
    assert.equal(next.reply, 'autoReview=false')
    assert.equal(
      next.seen.some((message) => message.method === 'configWarning'),
      false,
    )
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('an auto-mode classifier denial is a denied review of the declined command', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const { request, turn } = autoReviewClient(reader, proc)
  try {
    const started = await request('thread/start', {
      cwd: process.cwd(),
      persistExtendedHistory: false,
      permissions: ':workspace',
      approvalsReviewer: 'auto_review',
    })
    const threadId = started.result.thread.id
    const { seen } = await turn(threadId, 'auto review denied')
    const done = seen.find((message) => message.method === 'turn/completed')
    assert.equal(done.params.turn.status, 'completed')
    assert.equal(
      seen.some((message) => /requestApproval$/.test(String(message.method ?? ''))),
      false,
    )
    const ended = seen.find(
      (message) =>
        message.method === 'item/completed' && message.params.item.type === 'commandExecution',
    )
    const command = ended?.params.item
    assert.equal(command?.command, 'rm -rf build')
    assert.equal(command?.status, 'declined')

    const reviewed = seen.find((message) => message.method === 'item/autoApprovalReview/completed')
    assert.ok(reviewed, 'the denial is a review of the call')
    assert.ok(seen.indexOf(reviewed) < seen.indexOf(ended), 'the review comes first')
    const { reviewId, startedAtMs, completedAtMs, ...review } = reviewed.params
    assert.equal(typeof reviewId, 'string')
    assert.ok(startedAtMs <= completedAtMs)
    assert.deepEqual(review, {
      threadId,
      turnId: done.params.turn.id,
      targetItemId: command.id,
      decisionSource: 'agent',
      review: {
        status: 'denied',
        riskLevel: null,
        userAuthorization: null,
        rationale: 'Deleting the build directory was not requested.',
      },
      action: { type: 'command', source: 'shell', command: 'rm -rf build', cwd: command.cwd },
    })
    assert.equal(
      seen.some((message) => message.method === 'warning'),
      false,
    )

    // "Approve anyway" has nothing to record on a Claude thread.
    const approved = await request('thread/approveGuardianDeniedAction', {
      threadId,
      event: { type: 'denied' },
    })
    assert.deepEqual(approved.result, {})
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a call only the user may answer asks even with full access, for that call only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-test-'))
  const proc = spawnMockAdapter(home)
  const reader = new JsonLineReader(proc)
  const { request } = autoReviewClient(reader, proc)
  try {
    const started = await request('thread/start', {
      cwd: process.cwd(),
      persistExtendedHistory: false,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'auto_review',
    })
    const threadId = started.result.thread.id
    sendTurn(proc, 100, threadId, 'auto review escalated')
    const asked = await awaitMessage(
      reader,
      (message) => message.method === 'item/commandExecution/requestApproval',
    )
    assert.equal(asked.params.command, 'git push')
    assert.deepEqual(asked.params.availableDecisions, ['accept', 'decline', 'cancel'])
    proc.stdin.write(json({ id: asked.id, result: { decision: 'acceptForSession' } }))
    const first: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', first)
    assert.equal(completedItem(first, asked.params.itemId)?.status, 'completed')

    // Nothing was remembered: the next one asks again.
    sendTurn(proc, 101, threadId, 'auto review escalated')
    const again = await awaitMessage(
      reader,
      (message) => message.method === 'item/commandExecution/requestApproval',
    )
    proc.stdin.write(json({ id: again.id, result: { decision: 'decline' } }))
    const second: any[] = []
    await awaitMessage(reader, (message) => message.method === 'turn/completed', second)
    assert.equal(completedItem(second, again.params.itemId)?.status, 'declined')
  } finally {
    await stopProcess(proc)
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
})

test('a Read Claude asks about asks on the command card, with a session allow for that read', async () => {
  const seen = await mockTurnMessages('outside read check', {}, () => ({ decision: 'accept' }))
  const request = seen.find((message) => message.method === 'item/commandExecution/requestApproval')
  assert.ok(request, 'the Read should ask on the command card')
  assert.equal(
    seen.some((message) => message.method === 'item/fileChange/requestApproval'),
    false,
  )
  const item = completedItems(seen).find((candidate) => candidate.id === request.params.itemId)
  assert.deepEqual(
    {
      command: request.params.command,
      cwd: request.params.cwd,
      commandActions: request.params.commandActions,
      availableDecisions: request.params.availableDecisions,
    },
    {
      command: 'Read /etc/hosts',
      cwd: process.cwd(),
      commandActions: [
        { type: 'read', command: 'Read /etc/hosts', name: 'hosts', path: '/etc/hosts' },
      ],
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    },
  )
  assert.equal(item?.type, 'commandExecution')
  assert.equal(item?.status, 'completed')
  assert.equal(item?.aggregatedOutput, '127.0.0.1 localhost')
})
