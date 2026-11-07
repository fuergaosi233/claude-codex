import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listFiles } from '../src/server-helpers.mjs'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

async function withRg(script: string, run: (root: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'fuzzy-files-'))
  const bin = join(directory, 'bin')
  const root = join(directory, 'project')
  const previousPath = process.env.PATH
  try {
    await mkdir(bin)
    await mkdir(root)
    await writeFile(join(bin, 'rg'), `#!${process.execPath}\n${script}`)
    await chmod(join(bin, 'rg'), 0o755)
    process.env.PATH = `${bin}:${previousPath ?? '/usr/bin:/bin'}`
    await run(root)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  }
}

test('listFiles streams more than 5 MiB and retains the last unterminated line', async () => {
  const count = 6_000
  const prefix = 'directory/'.repeat(105)
  assert.ok((prefix.length + 10) * count > 5 * 1024 * 1024)
  await withRg(
    `process.stdout.write(Array.from({length: ${count}}, (_, i) => ${JSON.stringify(prefix)} + i + '.mts').join('\\n'))`,
    async (root) => {
      const files = await listFiles(root)
      assert.equal(files.length, count)
      assert.equal(files[0], `${prefix}0.mts`)
      assert.equal(files.at(-1), `${prefix}${count - 1}.mts`)
      assert.deepEqual(await listFiles(root, 7), files.slice(0, 7))
    },
  )
})

test('listFiles fallback prunes git metadata and node_modules recursively', async () => {
  await withRg('process.exit(1)', async (root) => {
    for (const path of ['.git', 'node_modules', 'src/.git', 'src/node_modules', 'src/lib']) {
      await mkdir(join(root, path), { recursive: true })
      await writeFile(join(root, path, 'file.mts'), '')
    }
    await writeFile(join(root, 'README.md'), '')
    assert.deepEqual((await listFiles(root)).sort(), ['README.md', 'src/lib/file.mts'])
  })
})

test('fuzzy file search ranks deep basename matches beyond the first 100 walk hits', async () => {
  const paths = [
    ...Array.from({ length: 200 }, (_, index) => `server-notes-${index}.txt`),
    'zsrc/lib/core/server.mts',
    'server/docs/unrelated.md',
  ]
  await withRg(`process.stdout.write(${JSON.stringify(paths.join('\n'))})`, async (root) => {
    await mkdir(join(root, 'zsrc/lib/core'), { recursive: true })
    await Promise.all(paths.slice(0, 201).map((path) => writeFile(join(root, path), '')))
    await withInProcessApp(
      scriptedRuntime(async () => {}),
      async (app) => {
        const result = await app.request('fuzzyFileSearch', { query: 'SERVER', roots: [root] })
        assert.equal(result.files.length, 100)
        assert.equal(result.files[0].path, 'zsrc/lib/core/server.mts')
        assert.ok(result.files[0].score > result.files[1].score)
        await app.request('fuzzyFileSearch/sessionStart', { sessionId: 'files', roots: [root] })
        await app.request('fuzzyFileSearch/sessionUpdate', { sessionId: 'files', query: 'SERVER' })
        const updated = app.notified('fuzzyFileSearch/sessionUpdated').at(-1)
        assert.deepEqual(updated.files, result.files)
      },
    )
  })
})
