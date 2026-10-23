import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { listClaudeSkills } from '../src/claude-capabilities.mjs'
import {
  claudeCommandManifest,
  listClaudeCommands,
  listFolderCommands,
  noteClaudeCommands,
  noteFolderCommands,
  onClaudeCommandsChanged,
  type ReportedCommand,
  skillLinksToCommand,
} from '../src/claude-commands.mjs'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'

// The commands Claude Code reports beyond its own (.claude/commands, plugin
// commands and skills, MCP prompts) fill the App's "/" popup per folder.

async function withEnv<T>(
  values: Record<string, string>,
  run: (home: string) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-folder-commands-'))
  const keys = ['CLAUDE_CODEX_HOME', 'CODEX_HOME', ...Object.keys(values)]
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  process.env.CLAUDE_CODEX_HOME = join(home, 'adapter')
  process.env.CODEX_HOME = join(home, 'codex')
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  try {
    return await run(home)
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true })
  }
}

const REPORT: ReportedCommand[] = [
  { name: 'simplify', description: 'Clean up the diff.', argumentHint: '', builtin: true },
  { name: 'cost', description: 'Show cost.', argumentHint: '', builtin: true },
  // A project command.
  {
    name: 'deploy',
    description: 'Deploy the app. Uses the staging cluster unless told otherwise.',
    argumentHint: '<env>',
  },
  // A user command.
  { name: 'standup', description: 'Write my standup notes.', argumentHint: '' },
  // `/simplify` runs Claude Code's own command, so this row never runs.
  { name: 'simplify', description: 'My own simplify.', argumentHint: '' },
  // The App has its own /init.
  { name: 'init', description: 'Project init.', argumentHint: '' },
  // A plugin command and an MCP prompt.
  { name: 'acme:ship', description: 'Ship a release with Acme.', argumentHint: '[version]' },
  { name: 'mcp__docs__search', description: 'Search the docs.', argumentHint: '<query>' },
  // Not one slash-command word.
  { name: 'docs:search (MCP)', description: 'A label.', argumentHint: '' },
  // A second row of a name: the first one counts.
  { name: 'deploy', description: 'Another deploy.', argumentHint: '' },
]

test('noteFolderCommands keeps the commands a folder reports beyond Claude Code own', async () => {
  await withEnv({}, async (home) => {
    const folder = join(home, 'project')
    const other = join(home, 'other')
    let changes = 0
    const off = onClaudeCommandsChanged(() => {
      changes += 1
    })
    try {
      noteFolderCommands(folder, REPORT)
      assert.deepEqual(
        listFolderCommands(folder).map((command) => command.name),
        ['acme:ship', 'deploy', 'mcp__docs__search', 'standup'],
      )
      assert.deepEqual(listFolderCommands(`${folder}/`), listFolderCommands(folder))
      assert.equal(
        listFolderCommands(folder).find((command) => command.name === 'deploy')?.description,
        'Deploy the app. Uses the staging cluster unless told otherwise.',
      )
      assert.deepEqual(listFolderCommands(other), [])
      // Claude Code's own skills are kept apart, for every folder.
      assert.deepEqual(
        listClaudeCommands().map((command) => command.name),
        ['simplify'],
      )
      assert.equal(changes, 1)
      noteFolderCommands(folder, REPORT)
      assert.equal(changes, 1, 'an unchanged report is not announced again')

      // A plugin command's manifest folder maps back to its name, kept with
      // the folder's other commands.
      const manifest = claudeCommandManifest('acme:ship', folder)
      assert.equal(basename(dirname(manifest)), 'acme+ship')
      assert.equal(
        dirname(dirname(dirname(manifest))),
        join(home, 'adapter', 'claude-commands', '+folders'),
      )
      assert.equal(claudeCommandManifest('acme:ship', `${folder}/`), manifest)
      const text = await readFile(manifest, 'utf8')
      assert.match(text, /^---\nname: acme:ship\ndescription: "Ship a release with Acme."/)
      assert.match(text, /Claude Code command from your Claude Code settings/)
      assert.match(text, /runs `\/acme:ship \[version\]` in Claude Code/)
      assert.equal(existsSync(claudeCommandManifest('mcp__docs__search', folder)), true)

      // Saved per folder, and read back by a later adapter.
      const saved = JSON.parse(
        await readFile(join(home, 'adapter', 'claude-commands.json'), 'utf8'),
      )
      assert.deepEqual(
        saved.folders[folder].commands.map((command: { name: string }) => command.name),
        ['acme:ship', 'deploy', 'mcp__docs__search', 'standup'],
      )
      process.env.CLAUDE_CODEX_HOME = join(home, 'elsewhere')
      assert.deepEqual(listFolderCommands(folder), [])
      process.env.CLAUDE_CODEX_HOME = join(home, 'adapter')
      assert.deepEqual(
        listFolderCommands(folder).map((command) => command.name),
        ['acme:ship', 'deploy', 'mcp__docs__search', 'standup'],
      )

      // A CLI that marks none of its rows cannot tell its own from the rest.
      noteFolderCommands(folder, [{ name: 'clear', description: '', argumentHint: '' }])
      assert.equal(listFolderCommands(folder).length, 4)

      // A later report replaces the list; one without such commands clears it.
      noteFolderCommands(folder, [REPORT[1] as ReportedCommand, REPORT[2] as ReportedCommand])
      assert.deepEqual(
        listFolderCommands(folder).map((command) => command.name),
        ['deploy'],
      )
      assert.equal(changes, 2)
      assert.equal(existsSync(manifest), false, 'a dropped command loses its manifest')
      assert.equal(existsSync(claudeCommandManifest('deploy', folder)), true)
      noteFolderCommands(folder, [REPORT[0] as ReportedCommand])
      assert.deepEqual(listFolderCommands(folder), [])
      assert.equal(changes, 3)
      assert.equal(existsSync(dirname(dirname(manifest))), false)
      const cleared = JSON.parse(
        await readFile(join(home, 'adapter', 'claude-commands.json'), 'utf8'),
      )
      assert.equal(cleared.folders[folder], undefined)
    } finally {
      off()
    }
  })
})

test('commands named like one of the App\'s own "/" commands are left out', async () => {
  await withEnv({}, async (home) => {
    const folder = join(home, 'project')
    // Every command the App registers in its "/" popup, by id.
    const app = [
      'archive',
      'autoreview',
      'chat',
      'chatgpt-lockdown',
      'chatgpt-model',
      'cloud',
      'cloud-environment',
      'compact',
      'custom-gpt',
      'delete',
      'dictate',
      'feedback',
      'fork',
      'goal',
      'hotkey-window-new',
      'hotkey-window-resume',
      'ide-context',
      'init',
      'local',
      'local-project-to-chat',
      'mcp',
      'memories',
      'model',
      'new',
      'pet',
      'pin',
      'plan-mode',
      'project',
      'projectless',
      'read-aloud',
      'reasoning',
      'rename',
      'review-mode',
      'share',
      'side',
      'sketch',
      'status',
      'usage',
      'worktree',
      'worktree-prompt',
    ]
    noteFolderCommands(folder, [
      { name: 'simplify', description: '', argumentHint: '', builtin: true },
      ...app.map((name) => ({ name, description: 'Mine.', argumentHint: '' })),
      { name: 'deploy', description: 'Deploy.', argumentHint: '' },
      // A plugin's command only shares the part after its namespace.
      { name: 'acme:pin', description: 'Pin with Acme.', argumentHint: '' },
    ])
    assert.deepEqual(
      listFolderCommands(folder).map((command) => command.name),
      ['acme:pin', 'deploy'],
    )
    // Claude Code's own skills are filtered the same way.
    noteClaudeCommands(
      [
        { name: 'pet', description: '', argumentHint: '', builtin: true },
        { name: 'review', description: 'Review.', argumentHint: '', builtin: true },
      ],
      ['pet', 'review'],
    )
    assert.deepEqual(
      listClaudeCommands().map((command) => command.name),
      ['review'],
    )
  })
})

test('each folder keeps the manifests of its own commands, and only those', async () => {
  await withEnv({}, async (home) => {
    const report = (description: string): ReportedCommand[] => [
      REPORT[0] as ReportedCommand,
      { name: 'deploy', description, argumentHint: '' },
      { name: 'standup', description: 'Write my standup notes.', argumentHint: '' },
    ]
    const app = join(home, 'app')
    const site = join(home, 'site')
    noteFolderCommands(app, report('Deploy the app.'))
    noteFolderCommands(site, report('Deploy the site.'))
    const appDeploy = claudeCommandManifest('deploy', app)
    const siteDeploy = claudeCommandManifest('deploy', site)
    assert.notEqual(appDeploy, siteDeploy)
    assert.match(await readFile(appDeploy, 'utf8'), /description: "Deploy the app."/)
    assert.match(await readFile(siteDeploy, 'utf8'), /description: "Deploy the site."/)
    const [appEntry, siteEntry] = listClaudeSkills({ cwds: [app, site] })
    assert.equal(appEntry?.skills.find((skill) => skill.name === 'deploy')?.path, appDeploy)
    assert.equal(siteEntry?.skills.find((skill) => skill.name === 'deploy')?.path, siteDeploy)

    // Dropping a command in one folder leaves the other folder's.
    noteFolderCommands(app, [REPORT[0] as ReportedCommand, REPORT[3] as ReportedCommand])
    assert.equal(existsSync(appDeploy), false)
    assert.equal(existsSync(claudeCommandManifest('standup', app)), true)
    assert.match(await readFile(siteDeploy, 'utf8'), /description: "Deploy the site."/)

    // A manifest removed by another adapter sharing the home is written again
    // when the folder is listed.
    await rm(siteDeploy)
    listFolderCommands(site)
    assert.equal(existsSync(siteDeploy), true)

    // A folder no longer kept loses its manifests.
    await new Promise((resolve) => setTimeout(resolve, 5))
    for (let index = 0; index < 64; index += 1)
      noteFolderCommands(join(home, 'more', String(index)), report('Deploy.'))
    assert.deepEqual(listFolderCommands(app), [])
    assert.equal(existsSync(claudeCommandManifest('standup', app)), false)
    assert.equal(existsSync(siteDeploy), false)
    assert.equal(existsSync(claudeCommandManifest('deploy', join(home, 'more', '63'))), true)
  })
})

test('a picked command runs as a slash command, plugin and MCP names included', async () => {
  await withEnv({}, async () => {
    assert.equal(
      skillLinksToCommand(`[$acme:ship](${claudeCommandManifest('acme:ship')}) 1.2.0`),
      '/acme:ship 1.2.0',
    )
    assert.equal(
      skillLinksToCommand(
        `[$mcp__docs__search](${claudeCommandManifest('mcp__docs__search')}) hooks`,
      ),
      '/mcp__docs__search hooks',
    )
    // The App may add a display label to the link text, and wrap the path.
    assert.equal(
      skillLinksToCommand(`[$deploy?label=Deploy](<${claudeCommandManifest('deploy')}>) staging`),
      '/deploy staging',
    )
    // A folder's own command, as skills/list offers it.
    assert.equal(
      skillLinksToCommand(
        `[$acme:ship](${claudeCommandManifest('acme:ship', join(tmpdir(), 'ws'))}) 1.2.0`,
      ),
      '/acme:ship 1.2.0',
    )
    // A link into another folder is no command.
    const elsewhere = join(tmpdir(), 'acme+ship', 'SKILL.md')
    assert.equal(
      skillLinksToCommand(`[$acme:ship](${elsewhere}) go`),
      `[$acme:ship](${elsewhere}) go`,
    )
  })
})

test('skills/list offers a folder its own commands next to its skills, once per name', async () => {
  await withEnv({}, async (home) => {
    const claudeDir = join(home, 'claude')
    process.env.CLAUDE_CODEX_CLAUDE_CONFIG_DIR = claudeDir
    try {
      const workspace = join(home, 'ws')
      await mkdir(join(workspace, '.git'), { recursive: true })
      await mkdir(join(workspace, '.claude', 'skills', 'deploy'), { recursive: true })
      await writeFile(
        join(workspace, '.claude', 'skills', 'deploy', 'SKILL.md'),
        '---\nname: deploy\ndescription: Deploy from the repo skill\n---\nbody\n',
      )
      await mkdir(join(claudeDir, 'skills', 'standup'), { recursive: true })
      await writeFile(
        join(claudeDir, 'skills', 'standup', 'SKILL.md'),
        '---\nname: standup\ndescription: Standup from the user skill\n---\nbody\n',
      )
      noteFolderCommands(workspace, REPORT)
      const other = join(home, 'other')
      await mkdir(join(other, '.git'), { recursive: true })
      const [entry, otherEntry] = listClaudeSkills({ cwds: [workspace, other] })
      const skills = entry?.skills ?? []
      // Skills read from disk keep their entry; Claude Code reports them too.
      assert.deepEqual(
        skills.filter((skill) => skill.name === 'deploy').map((skill) => skill.scope),
        ['repo'],
      )
      assert.deepEqual(
        skills.filter((skill) => skill.name === 'standup').map((skill) => skill.scope),
        ['user'],
      )
      assert.equal(
        skills.find((skill) => skill.name === 'standup')?.path,
        join(claudeDir, 'skills', 'standup', 'SKILL.md'),
      )
      const ship = skills.find((skill) => skill.name === 'acme:ship')
      assert.deepEqual(ship, {
        name: 'acme:ship',
        description: 'Ship a release with Acme.',
        shortDescription: 'Ship a release with Acme.',
        path: claudeCommandManifest('acme:ship', workspace),
        scope: 'user',
        enabled: true,
      })
      assert.ok(skills.some((skill) => skill.name === 'mcp__docs__search'))
      assert.deepEqual(
        skills.filter((skill) => skill.name === 'simplify').map((skill) => skill.scope),
        ['system'],
      )
      assert.equal(
        new Set(skills.map((skill) => skill.name)).size,
        skills.length,
        'one entry per name',
      )
      // Another folder has not reported these.
      const otherNames = (otherEntry?.skills ?? []).map((skill) => skill.name)
      assert.ok(!otherNames.includes('acme:ship'))
      assert.ok(!otherNames.includes('mcp__docs__search'))
    } finally {
      delete process.env.CLAUDE_CODEX_CLAUDE_CONFIG_DIR
    }
  })
})

const baseContext: RuntimeTurnContext = {
  threadId: 'thread',
  turnId: 'turn',
  prompt: 'commands check',
  cwd: process.cwd(),
  runtimeType: null,
  model: null,
  effort: null,
  claudeSessionId: null,
  forkSession: false,
  mcpServers: null,
  allowedTools: null,
  addDirs: [],
  enableFileCheckpointing: false,
  outputFormat: null,
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
}

// One turn of a fake Claude Code that answers supportedCommands() after
// `delayMs` and may push a commands_changed message after its init.
async function runCommandsTurn(
  context: RuntimeTurnContext,
  supported: ReportedCommand[],
  options: { delayMs?: number; pushed?: ReportedCommand[] } = {},
): Promise<void> {
  const runtime = new NativeClaudeRuntime()
  Reflect.set(runtime, 'sdk', {
    query: () => {
      const messages = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-1', skills: ['simplify'] }
        if (options.pushed)
          yield {
            type: 'system',
            subtype: 'commands_changed',
            commands: options.pushed,
            session_id: 'session-1',
          }
        await new Promise((resolve) => setTimeout(resolve, (options.delayMs ?? 0) + 20))
        yield { type: 'result', subtype: 'success', result: 'done' }
      })()
      return Object.assign(messages, {
        supportedCommands: async () => {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0))
          return supported
        },
      })
    },
  })
  let completed = false
  await runtime.runTurn(context, {
    onEvent: async (event) => {
      if (event.type === 'completed') completed = event.success
    },
    onPermissionRequest: async () => ({ decision: 'accept' }),
    onUserInputRequest: async () => ({ answers: {} }),
  })
  assert.equal(completed, true)
}

// The folder's command names once they are `expected`, or after two seconds.
async function folderNames(folder: string, expected: string[]): Promise<string[]> {
  const deadline = Date.now() + 2_000
  let names = listFolderCommands(folder).map((command) => command.name)
  while (JSON.stringify(names) !== JSON.stringify(expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    names = listFolderCommands(folder).map((command) => command.name)
  }
  return names
}

const REPORTED_NAMES = ['acme:ship', 'deploy', 'mcp__docs__search', 'standup']

test('a chat session reports its folder commands, and commands_changed replaces them', async () => {
  await withEnv({ CLAUDE_CODEX_REAP_ORPHANED_CLI: '0' }, async (home) => {
    const folder = join(home, 'project')
    await mkdir(folder, { recursive: true })
    await runCommandsTurn({ ...baseContext, cwd: folder }, REPORT)
    assert.deepEqual(await folderNames(folder, REPORTED_NAMES), REPORTED_NAMES)

    // The session found another command while it worked: the pushed list
    // wins over the slower supportedCommands() answer of its start.
    const pushed: ReportedCommand[] = [
      { name: 'compact', description: '', argumentHint: '', builtin: true },
      { name: 'lint-subdir', description: 'Lint this folder.', argumentHint: '' },
    ]
    await runCommandsTurn({ ...baseContext, cwd: folder, turnId: 'turn-2' }, REPORT, {
      delayMs: 50,
      pushed,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(await folderNames(folder, ['lint-subdir']), ['lint-subdir'])

    // A helper turn runs with settings of its own and does not speak for the
    // folder.
    const helper = join(home, 'helper')
    await mkdir(helper, { recursive: true })
    await runCommandsTurn(
      {
        ...baseContext,
        cwd: helper,
        turnId: 'turn-3',
        purpose: 'summary',
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      REPORT,
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(listFolderCommands(helper), [])
  })
})

test('the App lists a folder command and its pick reaches Claude as /name args', async () => {
  await withEnv({}, async (home) => {
    const directory = join(home, 'project')
    await mkdir(directory, { recursive: true })
    const store = new SessionStore(join(home, 'state.sqlite'))
    const contexts: RuntimeTurnContext[] = []
    let finish: (() => void) | undefined
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
    const responses = new Map<unknown, { result?: any; error?: unknown }>()
    const notifications: string[] = []
    const peer: RpcPeer = {
      id: 'folder-commands-test',
      close: () => {},
      send: (message) => {
        if ('id' in message) responses.set(message.id, message as { result?: any })
        if ('method' in message && typeof message.method === 'string') {
          notifications.push(message.method)
          if (message.method === 'turn/completed') finish?.()
        }
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
    try {
      const { thread } = await request('thread/start', { cwd: directory, model: 'sonnet' })
      noteFolderCommands(directory, REPORT)
      assert.ok(notifications.includes('skills/changed'), 'the App refetches the popup')

      const listed = await request('skills/list', { cwds: [directory] })
      const ship = listed.data[0].skills.find(
        (skill: { name: string }) => skill.name === 'acme:ship',
      )
      assert.ok(ship, 'expected the plugin command in the popup')
      const text = `[$acme:ship](${ship.path}) 1.2.0 to staging`
      const completed = new Promise<void>((resolve) => {
        finish = resolve
      })
      await request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] })
      await completed
      assert.equal(contexts.at(-1)?.prompt, '/acme:ship 1.2.0 to staging')
    } finally {
      await server.stop()
    }
  })
})
