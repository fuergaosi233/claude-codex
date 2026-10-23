import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  clipText,
  firstPromptLine,
  isRelayedUserRequest,
  SUBAGENT_FAILED_WITHOUT_REASON,
  SUBAGENT_STOPPED,
  subagentFailureReason,
  subagentFailureSummary,
  subagentThreadName,
  subagentTurnError,
  taskEndReason,
  withSubagentFailures,
  workflowAgentPrompt,
} from '../src/subagent-presentation.mjs'
import {
  type WorkflowJournalAgentStart,
  WorkflowJournalMonitor,
  workflowAgentDescription,
} from '../src/workflow-subagents.mjs'

// The two messages the CLI starts a workflow agent with: the user's request,
// relayed, and the task the workflow computed for the agent, each behind its
// provenance header and indented by two spaces.
const relay = [
  '[Workflow harness — user request] The harness relays, verbatim, the request it runs for:',
  '  Review the parser and the lexer.',
].join('\n')
const task = [
  '[Workflow harness — computed task] The workflow script wrote this task for this agent:',
  '  ## Review the lexer',
  '',
  '  Read src/lexer.ts and list',
  '    every bug you find.',
].join('\n')

test('a workflow agent prompt is its computed task, without header or indent', () => {
  assert.equal(
    workflowAgentPrompt([relay, task]),
    '## Review the lexer\n\nRead src/lexer.ts and list\n  every bug you find.',
  )
  // A remote agent gets both in one message.
  assert.equal(
    workflowAgentPrompt([`${relay}\n\n${task}`]),
    '## Review the lexer\n\nRead src/lexer.ts and list\n  every bug you find.',
  )
  // A task whose lines are not all indented keeps them as they are.
  assert.equal(
    workflowAgentPrompt([
      '[Workflow harness — computed task] The workflow script wrote this task:\nFix it.\n  Now.',
    ]),
    'Fix it.\n  Now.',
  )
  // Without the headers the first message that is not the relay is the prompt.
  assert.equal(workflowAgentPrompt([relay, '  Plain task.  ']), 'Plain task.')
  assert.equal(workflowAgentPrompt(['Plain task.', 'Follow-up.']), 'Plain task.')
  assert.equal(workflowAgentPrompt([relay]), relay)
  assert.equal(workflowAgentPrompt(['', '  ']), null)
  assert.equal(workflowAgentPrompt([]), null)
})

test('only a message that relays the request without a task is a relay', () => {
  assert.equal(isRelayedUserRequest(relay), true)
  assert.equal(isRelayedUserRequest(`  ${relay}`), true)
  assert.equal(isRelayedUserRequest(`${relay}\n\n${task}`), false)
  assert.equal(isRelayedUserRequest(task), false)
  assert.equal(isRelayedUserRequest('Review the parser.'), false)
})

test('the first prompt line skips harness headers and Markdown marks', () => {
  assert.equal(firstPromptLine(task), 'Review the lexer')
  assert.equal(firstPromptLine(`${relay}\n\n${task}`), 'Review the lexer')
  assert.equal(firstPromptLine('\n\n  # Title  here \nbody'), 'Title here')
  assert.equal(firstPromptLine('> quoted\nbody'), 'quoted')
  assert.equal(firstPromptLine('- item one'), 'item one')
  assert.equal(firstPromptLine('* item two'), 'item two')
  assert.equal(firstPromptLine('12. numbered'), 'numbered')
  assert.equal(firstPromptLine('3) numbered'), 'numbered')
  assert.equal(firstPromptLine('**Goal** fix the build'), 'Goal fix the build')
  assert.equal(firstPromptLine('__Goal__'), 'Goal')
  assert.equal(firstPromptLine('[Workflow harness — something else]\nReal line'), 'Real line')
  // A mark that is not followed by a space is text.
  assert.equal(firstPromptLine('#hashtag'), '#hashtag')
  assert.equal(firstPromptLine('-1 is negative'), '-1 is negative')
  assert.equal(firstPromptLine('#\n   \nbody'), '#')
  assert.equal(firstPromptLine(''), '')
})

test('a subagent thread is named by its description, else its type and first prompt line', () => {
  assert.equal(
    subagentThreadName({
      description: '  Review \n the   lexer ',
      subType: 'reviewer',
      prompt: 'Long prompt',
    }),
    'Review the lexer',
  )
  assert.equal(
    subagentThreadName({ description: '   ', subType: 'Explore', prompt: '# Find the bug\nmore' }),
    'Explore: Find the bug',
  )
  assert.equal(subagentThreadName({ subType: null, prompt: 'Find the bug' }), 'Find the bug')
  assert.equal(subagentThreadName({ description: 42, subType: 'Explore', prompt: '' }), 'Explore')
  assert.equal(subagentThreadName({ prompt: ['not', 'text'] }), 'Subagent')
  assert.equal(subagentThreadName({}), 'Subagent')

  const long = 'word '.repeat(60)
  const named = subagentThreadName({ description: long })
  assert.equal(Array.from(named).length, 120)
  assert.ok(named.endsWith('…'))
  assert.ok(!named.includes('  '))
  // Cut by character, never inside a surrogate pair.
  const emoji = subagentThreadName({ description: '🙂'.repeat(200) })
  assert.equal(Array.from(emoji).length, 120)
  assert.equal(emoji, `${'🙂'.repeat(119)}…`)
  assert.equal(clipText('short', 120), 'short')
})

test('names and failure reasons keep no control characters or terminal escapes', () => {
  // A bell, a NUL, a C1 control, DEL, terminal colors and a right-to-left
  // override would garble the sidebar or reorder the text after them.
  const noisy = '\u001b[1;31mFix\u0007 the\u0000parser\u0085now\u007f \u202eevil\u202c\u2066x\u2069'
  assert.equal(subagentThreadName({ description: noisy }), 'Fix the parser now evilx')
  assert.equal(
    subagentThreadName({
      description: '\u0007\u001b[0m',
      subType: 'Explore',
      prompt: 'Look\u0000 up',
    }),
    'Explore: Look up',
  )
  assert.equal(
    subagentFailureReason('\u001b[31mError:\u001b[0m disk\u0000full\r\n\u001b[2K'),
    'Error: disk full',
  )
  assert.equal(taskEndReason('failed', 'Agent\u0007 stalled', null, 'Survey'), 'Agent stalled')
  assert.equal(workflowAgentDescription('', 'abc', 'Lexer\u0000review\u202e'), 'Lexer review')
  // Emoji sequences keep their joiners.
  assert.equal(subagentThreadName({ description: 'Ship 👩\u200d💻 it' }), 'Ship 👩\u200d💻 it')
})

test('a workflow agent is described by its label, else the first line of its task', () => {
  const prompt = workflowAgentPrompt([relay, task]) ?? ''
  assert.equal(workflowAgentDescription(prompt, 'abc', '  Lexer \n review '), 'Lexer review')
  assert.equal(workflowAgentDescription(prompt, 'abc'), 'Review the lexer')
  assert.equal(workflowAgentDescription(prompt, 'abc', '   '), 'Review the lexer')
  assert.equal(workflowAgentDescription('', 'abc'), 'Workflow agent abc')
  assert.equal(Array.from(workflowAgentDescription('', 'abc', 'x'.repeat(300))).length, 120)
})

test('a subagent failure reason drops the trailer, error tags and stack frames', () => {
  const stalled = [
    'Workflow ended before the agent published an individual result.',
    'Dynamic workflow "review" failed: Error: agent stalled on all 6 attempts (no progress for 180000ms each)',
    '    at Bo (file:///cli.js:1:2)',
    '    at async unknown (file:///cli.js:3:4)',
    'agentId: 0123456789abcdef',
  ].join('\n')
  assert.equal(
    subagentFailureReason(stalled),
    'Workflow ended before the agent published an individual result. Dynamic workflow "review" failed: Error: agent stalled on all 6 attempts (no progress for 180000ms each)',
  )
  assert.equal(
    subagentFailureReason(
      '<tool_use_error>Agent type "nope" not found.</tool_use_error>\n<usage>total_tokens: 12\nduration_ms: 3</usage>',
    ),
    'Agent type "nope" not found.',
  )
  assert.equal(
    subagentFailureReason('{"error":{"type":"overloaded_error","message":"Overloaded"}}'),
    'Overloaded',
  )
  assert.equal(subagentFailureReason('{"error":"Rate limited"}'), 'Rate limited')
  assert.equal(subagentFailureReason('{"message":"Bad request"}'), 'Bad request')
  // JSON that is not an error body is told as it is.
  assert.equal(subagentFailureReason('{"ok":true}'), '{"ok":true}')
  assert.equal(subagentFailureReason('{not json}'), '{not json}')
  assert.equal(subagentFailureReason(''), SUBAGENT_FAILED_WITHOUT_REASON)
  assert.equal(
    subagentFailureReason('agentId: abc\n<usage>x</usage>'),
    SUBAGENT_FAILED_WITHOUT_REASON,
  )
  assert.equal(subagentFailureReason('  ', 'Ended.'), 'Ended.')
  const long = subagentFailureReason('x'.repeat(1000))
  assert.equal(Array.from(long).length, 400)
  assert.ok(long.endsWith('…'))
  // A line that only mentions "at" mid-text is kept.
  assert.equal(subagentFailureReason('Failed at step 3'), 'Failed at step 3')
  assert.deepEqual(subagentTurnError('Why'), {
    message: 'Why',
    codexErrorInfo: null,
    additionalDetails: null,
  })
})

test('a background task tells why it ended from its summary unless that is its description', () => {
  const stall = 'Agent stalled: no progress for 600s (stream watchdog did not recover)'
  assert.equal(taskEndReason('failed', stall, 'Reading files next.', 'Survey'), stall)
  // A summary that is only the description says nothing; the result might.
  assert.equal(
    taskEndReason('failed', '  Survey ', 'Error: boom\n    at x (file:///cli.js:1:1)', 'Survey'),
    'Error: boom',
  )
  assert.equal(taskEndReason('failed', '', null, 'Survey'), SUBAGENT_FAILED_WITHOUT_REASON)
  // A long description is matched against the clipped name.
  const long = 'word '.repeat(60)
  assert.equal(
    taskEndReason('failed', long, 'Error: late', subagentThreadName({ description: long })),
    'Error: late',
  )
  // A stop says what stopped it when the CLI does, else only that it stopped.
  assert.equal(
    taskEndReason('stopped', 'Stopped by a worker restart: Survey', 'Half done.', 'Survey'),
    'Stopped by a worker restart: Survey',
  )
  assert.equal(taskEndReason('stopped', 'Survey', 'Half done.', 'Survey'), SUBAGENT_STOPPED)
  assert.equal(taskEndReason('stopped', '', null, null), SUBAGENT_STOPPED)
})

test('a failed parent turn counts its failed subagents and repeats the first reason', () => {
  assert.equal(
    subagentFailureSummary('Claude turn failed', { count: 1, firstReason: 'Disk full' }),
    'Claude turn failed. A subagent failed: Disk full',
  )
  assert.equal(
    subagentFailureSummary('Claude turn failed!', { count: 3, firstReason: 'Disk full' }),
    'Claude turn failed! 3 subagents failed; the first: Disk full',
  )
  // An error that already tells the reason does not repeat it.
  assert.equal(
    subagentFailureSummary('Stopped: Disk  full.', { count: 1, firstReason: 'Disk full' }),
    'Stopped: Disk  full. A subagent failed.',
  )
  assert.equal(
    subagentFailureSummary('Failed. Disk full', { count: 2, firstReason: 'Disk full' }),
    'Failed. Disk full. 2 subagents failed.',
  )
  assert.equal(
    subagentFailureSummary('', { count: 1, firstReason: 'Disk full' }),
    'A subagent failed: Disk full',
  )
  assert.equal(subagentFailureSummary('Failed', { count: 0, firstReason: 'x' }), 'Failed')
  assert.equal(
    subagentFailureSummary('Failed', { count: 1, firstReason: '' }),
    'Failed. A subagent failed.',
  )
  const clipped = subagentFailureSummary('Failed', { count: 1, firstReason: 'y'.repeat(500) })
  assert.equal(Array.from(clipped).length, 'Failed. A subagent failed: '.length + 200)
})

test('the parent error told with its subagents keeps its Codex error code', () => {
  const original = Object.assign(new Error('API Error: 529 Overloaded'), {
    codexErrorInfo: { serverOverloaded: null },
    additionalDetails: 'HTTP 529',
  })
  const told = withSubagentFailures(original, { count: 1, firstReason: 'Disk full' }) as Error & {
    codexErrorInfo?: unknown
    additionalDetails?: unknown
  }
  assert.notEqual(told, original)
  assert.equal(told.message, 'API Error: 529 Overloaded. A subagent failed: Disk full')
  assert.deepEqual(told.codexErrorInfo, { serverOverloaded: null })
  assert.equal(told.additionalDetails, 'HTTP 529')
  assert.equal(told.cause, original)

  const plain = withSubagentFailures(new Error('boom'), { count: 2, firstReason: null })
  assert.equal(plain.message, 'boom. 2 subagents failed.')
  assert.equal('codexErrorInfo' in plain, false)
  assert.equal('additionalDetails' in plain, false)

  const untouched = new Error('boom')
  assert.equal(withSubagentFailures(untouched, { count: 0, firstReason: null }), untouched)
})

async function workflowTranscript(
  journal: unknown[],
  agents: Record<string, unknown[]>,
): Promise<{ root: string; transcriptDir: string; runId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-workflow-names-'))
  const runId = 'wf_names_run'
  const transcriptDir = join(root, 'projects', 'project', 'subagents', 'workflows', runId)
  await mkdir(transcriptDir, { recursive: true })
  for (const [agentId, records] of Object.entries(agents))
    await writeFile(
      join(transcriptDir, `agent-${agentId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )
  await writeFile(
    join(transcriptDir, 'journal.jsonl'),
    `${journal.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  )
  return { root, transcriptDir, runId }
}

async function startedAgents(
  journal: unknown[],
  agents: Record<string, unknown[]>,
): Promise<WorkflowJournalAgentStart[]> {
  const { root, transcriptDir, runId } = await workflowTranscript(journal, agents)
  const started: WorkflowJournalAgentStart[] = []
  const monitor = new WorkflowJournalMonitor({
    launch: {
      taskId: 'names-task',
      workflowName: 'names-workflow',
      runId,
      transcriptDir,
      transcriptRoot: root,
      summary: '',
    },
    onStarted: async (agent) => {
      started.push(agent)
    },
    onResult: async () => {},
  })
  try {
    await monitor.flush()
    return started
  } finally {
    await monitor.stop()
    await rm(root, { recursive: true, force: true })
  }
}

const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } })
const assistant = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

test('a workflow agent starts named by its label, with its computed task as its prompt', async () => {
  const labelled = 'aaaaaaaa11111111'
  const unlabelled = 'bbbbbbbb22222222'
  const started = await startedAgents(
    [
      { type: 'started', key: 'k1', agentId: labelled, label: '  Lexer\n review ' },
      // A retry's started line repeats the agent; its first label stands.
      { type: 'started', key: 'k1', agentId: labelled, label: 'Second label' },
      { type: 'started', key: 'k2', agentId: unlabelled },
    ],
    {
      [labelled]: [user(relay), user([{ type: 'text', text: task }])],
      [unlabelled]: [user(relay), user(task), assistant('Looking.')],
    },
  )
  const prompt = '## Review the lexer\n\nRead src/lexer.ts and list\n  every bug you find.'
  assert.deepEqual(started, [
    { agentId: labelled, prompt, description: 'Lexer review' },
    { agentId: unlabelled, prompt, description: 'Review the lexer' },
  ])
})

test('a workflow agent whose transcript only has the relay so far waits for its task', async () => {
  const waiting = 'cccccccc33333333'
  const answered = 'dddddddd44444444'
  const plain = 'eeeeeeee55555555'
  const started = await startedAgents(
    [
      { type: 'started', key: 'k1', agentId: waiting, label: 'Waiting' },
      { type: 'started', key: 'k2', agentId: answered },
      { type: 'started', key: 'k3', agentId: plain },
    ],
    {
      [waiting]: [user(relay)],
      // An agent that answered the relay alone has no task to wait for.
      [answered]: [user(relay), assistant('On it.'), user('later message')],
      // A CLI without the headers starts the agent with its prompt alone.
      [plain]: [user('Summarise the README.\nKeep it short.')],
    },
  )
  assert.deepEqual(
    started.map((agent) => agent.agentId),
    [answered, plain],
  )
  assert.equal(started[0]?.prompt, relay)
  assert.equal(started[0]?.description, 'Review the parser and the lexer.')
  assert.deepEqual(started[1], {
    agentId: plain,
    prompt: 'Summarise the README.\nKeep it short.',
    description: 'Summarise the README.',
  })
})
