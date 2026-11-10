import assert from 'node:assert/strict'
import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

test('fs/copy preserves symlink targets and keeps a recursive copy independent of its source', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const source = join(app.home, 'source')
      const copy = join(app.home, 'copy')
      const outside = join(app.home, 'outside.txt')
      await mkdir(join(source, 'nested'), { recursive: true })
      await writeFile(join(source, 'nested', 'file.txt'), 'original')
      await writeFile(outside, 'outside')
      await symlink('nested', join(source, 'directory-link'), 'dir')
      await symlink('nested/file.txt', join(source, 'file-link'), 'file')
      await symlink('../missing', join(source, 'dangling-link'), 'file')
      await symlink(outside, join(source, 'absolute-link'), 'file')

      assert.deepEqual(
        await app.request('fs/copy', {
          sourcePath: source,
          destinationPath: copy,
          recursive: true,
        }),
        {},
      )
      for (const [name, target] of [
        ['directory-link', 'nested'],
        ['file-link', 'nested/file.txt'],
        ['dangling-link', '../missing'],
        ['absolute-link', outside],
      ] as const) {
        assert.equal(await readlink(join(copy, name)), target)
        assert.equal(await readlink(join(source, name)), target)
      }

      await writeFile(join(copy, 'directory-link', 'file.txt'), 'copy only')
      assert.equal(await readFile(join(source, 'nested', 'file.txt'), 'utf8'), 'original')
      assert.equal(await readFile(join(copy, 'file-link'), 'utf8'), 'copy only')
      await rm(source, { recursive: true })
      assert.equal(await readFile(join(copy, 'directory-link', 'file.txt'), 'utf8'), 'copy only')
      assert.equal(await readFile(join(copy, 'file-link'), 'utf8'), 'copy only')
      assert.equal(await readFile(join(copy, 'absolute-link'), 'utf8'), 'outside')
    },
  )
})
