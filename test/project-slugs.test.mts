import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sdkResumeSessionId } from '../src/native-runtime.mjs'
import { projectSlugs } from '../src/util.mjs'

test('project slugs follow the 200 UTF-16 unit boundary and signed path hash', () => {
  assert.deepEqual(projectSlugs('/' + 'a'.repeat(199)), ['-' + 'a'.repeat(199)])
  assert.deepEqual(projectSlugs('/' + 'a'.repeat(200)), [
    '-' + 'a'.repeat(199) + '-b6ymvl',
    '-' + 'a'.repeat(200),
  ])
  assert.equal(projectSlugs('/' + 'a'.repeat(201))[0], '-' + 'a'.repeat(199) + '-85qkr6')
  assert.equal(projectSlugs('/' + 'a'.repeat(198) + '😀')[0], '-' + 'a'.repeat(198) + '--b5wpam')
})

test('long cwd and symlink realpath slugs resume transcripts from CLI project folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-codex-long-slug-'))
  const cwd = join(root, 'a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80))
  const alias = join(root, 'alias')
  const config = join(root, 'config')
  try {
    await mkdir(cwd, { recursive: true })
    await symlink(cwd, alias)
    const canonical = await realpath(cwd)
    // Compute the specified signed 31-hash independently of the production helper.
    const hash = canonical
      .split('')
      .reduce((value, unit) => (31 * value + unit.charCodeAt(0)) | 0, 0)
    const cliSlug =
      canonical.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200) + '-' + Math.abs(hash).toString(36)
    assert.ok(projectSlugs(cwd).includes(cliSlug))
    assert.ok(projectSlugs(alias).includes(cliSlug))
    const transcript = join(config, 'projects', cliSlug, 'long-session.jsonl')
    await mkdir(join(config, 'projects', cliSlug), { recursive: true })
    await writeFile(transcript, '{}\n')
    assert.equal(sdkResumeSessionId('long-session', cwd, config), 'long-session')
    assert.equal(sdkResumeSessionId('long-session', alias, config), 'long-session')
    assert.equal(await readFile(transcript, 'utf8'), '{}\n')
    assert.equal(new Set(projectSlugs(alias)).size, projectSlugs(alias).length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
