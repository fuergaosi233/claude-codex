import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { gitDiff, gitUntrackedDiff } from '../src/server-helpers.mjs'

const execFileAsync = promisify(execFile)
const MiB = 1024 * 1024

async function withRepository(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'turn-diff-'))
  try {
    await execFileAsync('git', ['init', '-q'], { cwd })
    await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

test('oversized tracked diff retains large, small and untracked files', async () => {
  await withRepository(async (cwd) => {
    await writeFile(join(cwd, '00-large.txt'), `${'before'.repeat(170)}\n`.repeat(6_000))
    await writeFile(join(cwd, 'small.txt'), 'before\n')
    await execFileAsync('git', ['add', '--', '00-large.txt', 'small.txt'], { cwd })
    await writeFile(join(cwd, '00-large.txt'), `${'after!'.repeat(170)}\n`.repeat(6_000))
    await writeFile(join(cwd, 'small.txt'), 'small change remains visible\n')
    await writeFile(join(cwd, 'new.txt'), 'untracked change remains visible\n')
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--'], {
      cwd,
      maxBuffer: 20 * MiB,
    })
    assert.ok(Buffer.byteLength(stdout) > 5 * MiB, 'fixture must overflow the old buffer')

    const diff = await gitDiff(cwd)
    assert.match(diff, /diff --git a\/00-large\.txt b\/00-large\.txt/)
    assert.match(diff, /\[omitted:/)
    assert.match(diff, /diff --git a\/small\.txt b\/small\.txt/)
    assert.match(diff, /\+small change remains visible/)
    assert.match(diff, /diff --git a\/new\.txt b\/new\.txt/)
    assert.match(diff, /\+untracked change remains visible/)
    assert.ok(Buffer.byteLength(diff) < MiB, 'large tracked content should be summarized')
  })
})

test('large untracked files have size stubs without inlining their contents', async () => {
  await withRepository(async (cwd) => {
    await writeFile(join(cwd, 'artifact.log'), Buffer.alloc(10 * MiB, 'x'))
    await writeFile(join(cwd, 'small.txt'), 'visible new file\n')
    const diff = await gitDiff(cwd)
    assert.match(diff, /diff --git a\/artifact\.log b\/artifact\.log/)
    assert.match(diff, /\[omitted: 10485760 bytes\]/)
    assert.match(diff, /\+visible new file/)
    assert.ok(Buffer.byteLength(diff) < 4096)
    assert.ok(!diff.includes('x'.repeat(100)))
  })
})

test('untracked inline budget preserves entries beyond fifty files', async () => {
  await withRepository(async (cwd) => {
    const paths = Array.from(
      { length: 60 },
      (_, index) => `new-${String(index).padStart(2, '0')}.txt`,
    )
    const text = `${'line'.repeat(255)}\n`.repeat(100)
    assert.ok(Buffer.byteLength(text) < 256 * 1024)
    assert.ok(Buffer.byteLength(text) * paths.length > 2 * MiB)
    await Promise.all(paths.map((path) => writeFile(join(cwd, path), text)))
    const diff = await gitUntrackedDiff(cwd)
    for (const path of paths) {
      assert.ok(diff.includes(`diff --git a/${path} b/${path}\n`), `missing ${path}`)
    }
    assert.match(diff, /\[omitted:/)
    assert.ok(
      Buffer.byteLength(diff) < 2 * MiB + 64 * 1024,
      'only headers may exceed inline budget',
    )
  })
})
