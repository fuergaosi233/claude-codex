import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { scriptedRuntime, withInProcessApp } from './fixtures/in-process-app.mjs'

test('unsupported skill disabling errors instead of confirming a change it cannot apply', async () => {
  await withInProcessApp(
    scriptedRuntime(async () => {}),
    async (app) => {
      const cwd = join(app.home, 'project')
      const folder = join(cwd, '.claude', 'skills', 'toggle-regression')
      await mkdir(folder, { recursive: true })
      await mkdir(join(cwd, '.git'))
      const path = join(folder, 'SKILL.md')
      const contents =
        '---\nname: toggle-regression\ndescription: Test skill.\n---\nTest instructions.\n'
      await writeFile(path, contents)
      const listed = await app.request('skills/list', { cwds: [cwd] })
      const skill = listed.data[0].skills.find((entry: { path: string }) => entry.path === path)
      assert.ok(skill)
      assert.equal(skill.enabled, true)

      const disabled = await app.call('skills/config/write', { path, enabled: false })
      assert.equal(disabled.error?.code, -32600)
      assert.match(disabled.error?.message ?? '', /disabling skills.*not supported.*Claude/i)
      assert.equal(disabled.result, undefined)

      const reloaded = await app.request('skills/list', { cwds: [cwd], forceReload: true })
      assert.equal(
        reloaded.data[0].skills.find((entry: { path: string }) => entry.path === path)?.enabled,
        true,
      )
      assert.deepEqual(await app.request('skills/config/write', { path, enabled: true }), {
        effectiveEnabled: true,
      })
      assert.equal(await readFile(path, 'utf8'), contents)
    },
  )
})
