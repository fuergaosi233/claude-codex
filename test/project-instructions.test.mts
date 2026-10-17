import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { listClaudeSkills } from '../src/claude-capabilities.mjs'
import { projectInstructions } from '../src/project-instructions.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('AGENTS.md is read the way Codex reads it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-instructions-agents-'))
  const codexHome = join(root, 'codex-home')
  const repo = join(root, 'repo')
  const cwd = join(repo, 'packages', 'app')
  try {
    await write(join(codexHome, 'AGENTS.md'), 'global, replaced by the override')
    await write(join(codexHome, 'AGENTS.override.md'), 'Global override.')
    // Above the git root: not part of the project.
    await write(join(root, 'AGENTS.md'), 'Outside the project.')
    await mkdir(join(repo, '.git'), { recursive: true })
    await write(join(repo, 'AGENTS.md'), 'Repo root.')
    await write(join(repo, 'packages', 'AGENTS.md'), '   ')
    await write(join(cwd, 'AGENTS.md'), 'App, replaced by the override')
    await write(join(cwd, 'AGENTS.override.md'), 'App override.')

    const result = await withEnv(
      { CODEX_HOME: codexHome, CLAUDE_CODEX_CLAUDE_CONFIG_DIR: undefined },
      async () => projectInstructions(cwd),
    )
    assert.deepEqual(result.sources, [
      join(codexHome, 'AGENTS.override.md'),
      join(repo, 'AGENTS.md'),
      join(cwd, 'AGENTS.override.md'),
    ])
    assert.equal(
      result.prompt,
      `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nGlobal override.\n\n--- project-doc ---\n\nRepo root.\n\nApp override.\n</INSTRUCTIONS>`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('project AGENTS.md files share a 32 KiB budget; without .git only the folder itself counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-instructions-budget-'))
  const repo = join(root, 'repo')
  const cwd = join(repo, 'sub')
  const plain = join(root, 'plain', 'child')
  try {
    await mkdir(join(repo, '.git'), { recursive: true })
    await write(join(repo, 'AGENTS.md'), 'a'.repeat(32 * 1024 - 10))
    await write(join(cwd, 'AGENTS.md'), `${'b'.repeat(20)}tail`)
    await write(join(root, 'plain', 'AGENTS.md'), 'Parent of a folder outside git.')
    await write(join(plain, 'AGENTS.md'), 'Folder outside git.')

    await withEnv(
      { CODEX_HOME: join(root, 'empty-home'), CLAUDE_CODEX_CLAUDE_CONFIG_DIR: undefined },
      async () => {
        const budget = projectInstructions(cwd)
        assert.equal(budget.sources.length, 2)
        assert.match(budget.prompt ?? '', /\n\nb{10}\n<\/INSTRUCTIONS>$/)

        const outside = projectInstructions(plain)
        assert.deepEqual(outside.sources, [join(plain, 'AGENTS.md')])
        assert.match(
          outside.prompt ?? '',
          /<INSTRUCTIONS>\nFolder outside git\.\n<\/INSTRUCTIONS>$/,
        )
        assert.doesNotMatch(outside.prompt ?? '', /project-doc/)
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an AGENTS.md a CLAUDE.md imports is left to the CLI unless the adapter bridges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-instructions-import-'))
  const repo = join(root, 'repo')
  try {
    await mkdir(join(repo, '.git'), { recursive: true })
    await write(join(repo, 'AGENTS.md'), 'Shared agent rules.')
    await write(join(repo, 'CLAUDE.md'), '@AGENTS.md\n')
    await withEnv(
      {
        CODEX_HOME: join(root, 'empty-home'),
        CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
        CLAUDE_CODEX_CLAUDE_CONFIG_DIR: undefined,
      },
      async () => {
        const result = projectInstructions(repo)
        assert.deepEqual(result.sources, [])
        assert.equal(result.prompt, null)
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a bridged Claude Code folder brings CLAUDE.md files, rules, imports and skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-instructions-claude-'))
  const claudeHome = join(root, 'claude-home')
  const repo = join(root, 'repo')
  const cwd = join(repo, 'web')
  try {
    await write(join(claudeHome, 'CLAUDE.md'), 'User memory.\n@~/never-there.md\n')
    await write(join(claudeHome, 'rules', 'style.md'), 'User rule.')
    await write(
      join(claudeHome, 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: "Ship it"\n---\nSteps\n',
    )
    await mkdir(join(repo, '.git'), { recursive: true })
    await write(join(repo, 'AGENTS.md'), 'Agent rules.')
    await write(
      join(repo, 'CLAUDE.md'),
      'Repo memory.\n@AGENTS.md\n@docs/extra.md\n`@docs/ignored.md`\n```\n@docs/ignored.md\n```\n',
    )
    await write(join(repo, 'docs', 'extra.md'), 'Extra.\n@deeper.md')
    await write(join(repo, 'docs', 'deeper.md'), 'Deeper.')
    await write(join(repo, 'docs', 'ignored.md'), 'Ignored.')
    await write(join(repo, '.claude', 'CLAUDE.md'), 'Dot-claude memory.')
    await write(
      join(repo, '.claude', 'rules', 'api', 'routes.md'),
      '---\npaths:\n  - "src/api/**/*.ts"\n  - lib/**\n---\nAPI rule.',
    )
    await write(
      join(repo, '.claude', 'rules', 'always.md'),
      '---\ndescription: x\n---\nAlways rule.',
    )
    await write(
      join(repo, '.claude', 'skills', 'lint', 'SKILL.md'),
      '---\nname: lint\ndescription: Lint the repo\n---\n',
    )
    await write(join(cwd, 'CLAUDE.local.md'), 'Local memory.')

    const result = await withEnv(
      { CODEX_HOME: join(root, 'empty-home'), CLAUDE_CODEX_CLAUDE_CONFIG_DIR: claudeHome },
      async () => projectInstructions(cwd),
    )
    assert.deepEqual(result.sources, [
      join(repo, 'AGENTS.md'),
      join(claudeHome, 'CLAUDE.md'),
      join(claudeHome, 'rules', 'style.md'),
      join(repo, 'CLAUDE.md'),
      join(repo, 'docs', 'extra.md'),
      join(repo, 'docs', 'deeper.md'),
      join(repo, '.claude', 'CLAUDE.md'),
      join(repo, '.claude', 'rules', 'always.md'),
      join(cwd, 'CLAUDE.local.md'),
    ])
    const prompt = result.prompt ?? ''
    // AGENTS.md comes once, in Codex's framing.
    assert.equal(prompt.split('Agent rules.').length, 2)
    assert.ok(prompt.startsWith(`# AGENTS.md instructions for ${cwd}`))
    assert.match(
      prompt,
      /# Claude Code instructions\nCodebase and user instructions are shown below\./,
    )
    assert.ok(
      prompt.includes(
        `Contents of ${join(claudeHome, 'CLAUDE.md')} (user's private global instructions for all projects):\n\nUser memory.`,
      ),
    )
    assert.ok(
      prompt.includes(
        `Contents of ${join(repo, 'CLAUDE.md')} (project instructions, checked into the codebase):`,
      ),
    )
    assert.ok(
      prompt.includes(
        `Contents of ${join(cwd, 'CLAUDE.local.md')} (user's private project instructions, not checked in):\n\nLocal memory.`,
      ),
    )
    assert.doesNotMatch(prompt, /Ignored\.|API rule\.|description: x/)
    assert.ok(prompt.includes(':\n\nAlways rule.'))
    assert.ok(prompt.includes(':\n\nExtra.\n@deeper.md') && prompt.includes(':\n\nDeeper.'))
    assert.ok(
      prompt.includes(
        `- ${join(repo, '.claude', 'rules', 'api', 'routes.md')} (src/api/**/*.ts, lib/**)`,
      ),
    )
    assert.match(prompt, /# Claude Code skills\n/)
    assert.ok(
      prompt.includes(
        `- deploy: Ship it (file: ${join(claudeHome, 'skills', 'deploy', 'SKILL.md')})`,
      ),
    )
    assert.ok(
      prompt.includes(
        `- lint: Lint the repo (file: ${join(repo, '.claude', 'skills', 'lint', 'SKILL.md')})`,
      ),
    )

    const listed = await withEnv(
      { HOME: join(root, 'home'), CLAUDE_CODEX_CLAUDE_CONFIG_DIR: claudeHome },
      async () => listClaudeSkills({ cwds: [cwd] }),
    )
    const names = (listed[0]?.skills ?? []).filter((skill) => skill.scope !== 'system')
    assert.deepEqual(
      names.map((skill) => [skill.name, skill.scope]),
      [
        ['deploy', 'user'],
        ['lint', 'repo'],
      ],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude threads get the instructions in their prompt and report them as sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-instructions-server-'))
  const repo = join(root, 'repo')
  await mkdir(join(repo, '.git'), { recursive: true })
  await write(join(repo, 'AGENTS.md'), 'Answer in haiku.')
  await withEnv(
    {
      CLAUDE_CODEX_HOME: join(root, 'adapter'),
      CODEX_HOME: join(root, 'empty-home'),
      CLAUDE_CODEX_CLAUDE_CONFIG_DIR: undefined,
    },
    async () => {
      const store = new SessionStore(join(root, 'state.sqlite'))
      const contexts: RuntimeTurnContext[] = []
      const responses = new Map<unknown, any>()
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
      const peer: RpcPeer = {
        id: 'project-instructions-test',
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
        await request('turn/start', { threadId, input: [{ type: 'text', text: 'Hi.' }], ...params })
        await completed
        const context = contexts.at(-1)
        assert.ok(context)
        return context
      }
      try {
        const started = await request('thread/start', { cwd: repo, model: 'sonnet' })
        assert.deepEqual(started.instructionSources, [join(repo, 'AGENTS.md')])
        const normal = await turn(started.thread.id)
        assert.match(
          normal.systemPromptAddendum ?? '',
          /# AGENTS\.md instructions for .*\n\n<INSTRUCTIONS>\nAnswer in haiku\.\n<\/INSTRUCTIONS>/,
        )
        const summary = await turn(started.thread.id, {
          outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
        })
        assert.doesNotMatch(summary.systemPromptAddendum ?? '', /Answer in haiku/)
      } finally {
        await server.stop()
      }
    },
  )
  await rm(root, { recursive: true, force: true })
})
