import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { addedFileDiff, gitUntrackedDiff } from '../src/server-helpers.mjs'

const execFileAsync = promisify(execFile)

test('untracked symlinks retain link targets without reading them or hiding new files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'untracked-symlinks-'))
  const cwd = join(directory, 'repo')
  const secret = 'outside-workspace-secret-must-never-appear'
  try {
    await mkdir(cwd)
    await execFileAsync('git', ['init', '-q'], { cwd })
    const external = join(directory, 'external.txt')
    const externalDirectory = join(directory, 'external-directory')
    await writeFile(external, secret)
    await mkdir(externalDirectory)
    await writeFile(join(externalDirectory, 'secret.txt'), secret)
    const links: Array<[string, string]> = [
      ['a-dangling', 'missing-target.txt'],
      ['b-directory', externalDirectory],
      ['c-external', external],
      ['d-device', '/dev/zero'],
    ]
    for (const [path, target] of links) await symlink(target, join(cwd, path))
    await writeFile(join(cwd, 'new.txt'), 'ordinary new file remains visible\n')

    const diff = await gitUntrackedDiff(cwd)
    assert.ok(diff.includes('+ordinary new file remains visible\n'))
    assert.ok(!diff.includes(secret))
    for (const [path, target] of links) {
      assert.ok(
        diff.includes(addedFileDiff(path, target, '120000')),
        `${path} should contain its link target with symlink mode`,
      )
    }
    assert.ok(diff.includes(addedFileDiff('new.txt', 'ordinary new file remains visible\n')))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('addedFileDiff defaults to regular file mode and accepts symlink mode', () => {
  assert.match(addedFileDiff('new.txt', 'text'), /new file mode 100644\n/)
  assert.match(addedFileDiff('link', '../target', '120000'), /new file mode 120000\n/)
  assert.match(addedFileDiff('link', '../target', '120000'), /\+\.\.\/target\n$/)
})
