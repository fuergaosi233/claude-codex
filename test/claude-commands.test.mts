import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  claudeCommandManifest,
  firstSentence,
  listClaudeCommands,
  noteClaudeCommands,
  onClaudeCommandsChanged,
  skillLinksToCommand,
} from '../src/claude-commands.mjs'

test('noteClaudeCommands keeps Claude Code built-in skills and announces changes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-codex-commands-'))
  const previous = process.env.CLAUDE_CODEX_HOME
  process.env.CLAUDE_CODEX_HOME = home
  let changes = 0
  const off = onClaudeCommandsChanged(() => {
    changes += 1
  })
  try {
    // Nothing reported yet: the seed.
    assert.deepEqual(
      listClaudeCommands().map((command) => command.name),
      ['simplify'],
    )
    assert.equal(existsSync(claudeCommandManifest('simplify')), true)

    const reported = [
      {
        name: 'simplify',
        description: 'Clean up the diff. Quality only.',
        argumentHint: '[<target>]',
        builtin: true,
      },
      { name: 'code-review', description: 'Review the diff.', argumentHint: '', builtin: true },
      // The App has its own /init.
      { name: 'init', description: 'Write CLAUDE.md.', argumentHint: '', builtin: true },
      // A built-in that is not a skill.
      { name: 'cost', description: 'Show cost.', argumentHint: '', builtin: true },
      // A user skill; skills/list reads those from disk.
      { name: 'demo-skill', description: 'Demo.', argumentHint: '' },
    ]
    const skills = ['simplify', 'code-review', 'init', 'demo-skill']
    noteClaudeCommands(reported, skills)
    assert.deepEqual(
      listClaudeCommands().map((command) => command.name),
      ['code-review', 'simplify'],
    )
    assert.equal(changes, 1)
    noteClaudeCommands(reported, skills)
    assert.equal(changes, 1, 'an unchanged report is not announced again')

    const saved = JSON.parse(await readFile(join(home, 'claude-commands.json'), 'utf8'))
    assert.deepEqual(
      saved.commands.map((command: { name: string }) => command.name),
      ['code-review', 'simplify'],
    )
    const manifest = await readFile(claudeCommandManifest('simplify'), 'utf8')
    assert.match(manifest, /^---\nname: simplify\ndescription: "Clean up the diff. Quality only."/)
    assert.match(manifest, /runs `\/simplify \[<target>\]` in Claude Code/)
  } finally {
    off()
    if (previous == null) delete process.env.CLAUDE_CODEX_HOME
    else process.env.CLAUDE_CODEX_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('skillLinksToCommand turns a picked Claude skill into a leading slash command', () => {
  const native = claudeCommandManifest('simplify')
  assert.equal(
    skillLinksToCommand(`[$simplify](${native}) focus on server.mts`),
    '/simplify focus on server.mts',
  )
  assert.equal(skillLinksToCommand(`[$simplify](${native})`), '/simplify')
  assert.equal(
    skillLinksToCommand(`please run [$simplify](${native}) on the diff`),
    '/simplify please run on the diff',
  )
  assert.equal(
    skillLinksToCommand(`[$simplify](${native}) then [$simplify](${native})`),
    '/simplify then /simplify',
  )
  // Skills on disk are not commands in the adapter's CLI, so their links stay
  // for the model to open, here as /simplify's arguments.
  const user = '[$demo-skill](/Users/me/.claude/skills/demo-skill/SKILL.md)'
  assert.equal(skillLinksToCommand(`${user} first`), `${user} first`)
  assert.equal(
    skillLinksToCommand(`${user}\nthen [$simplify](${native})`),
    `/simplify ${user}\nthen`,
  )
  // Links that are not Claude skills, and typed commands, pass through.
  const plugin = '[$figma](/Users/me/.codex/plugins/figma/skills/figma/SKILL.md) open it'
  assert.equal(skillLinksToCommand(plugin), plugin)
  assert.equal(skillLinksToCommand('/simplify the parser'), '/simplify the parser')
})

test('firstSentence stops at the first real sentence end', () => {
  assert.equal(
    firstSentence(
      'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs.',
    ),
    'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes.',
  )
  assert.equal(
    firstSentence('Run a prompt on an interval (e.g. /loop 5m /foo). Omit the interval.'),
    'Run a prompt on an interval (e.g. /loop 5m /foo).',
  )
  assert.equal(firstSentence('No period here'), 'No period here')
})
