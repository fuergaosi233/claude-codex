import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appPluginSkills, claudeRunnableAppPlugin } from '../src/claude-capabilities.mjs'
import { readsWithin } from '../src/native-runtime.mjs'
import { buildSystemPromptAddendum } from '../src/server-helpers.mjs'

// A marketplace laid out like the App's bundled one, with the plugin sources
// given, and a visualize plugin under plugins/visualize.
async function marketplace(directory: string, sources: Record<string, unknown>): Promise<string> {
  const manifest = join(directory, '.agents', 'plugins', 'marketplace.json')
  await mkdir(join(directory, '.agents', 'plugins'), { recursive: true })
  await writeFile(
    manifest,
    JSON.stringify({
      name: 'bundled',
      plugins: Object.entries(sources).map(([name, source]) => ({ name, source })),
    }),
  )
  const plugin = join(directory, 'plugins', 'visualize')
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true })
  await writeFile(join(plugin, '.codex-plugin', 'plugin.json'), '{"skills":"./skills/"}')
  await mkdir(join(plugin, 'skills', 'visualize'), { recursive: true })
  await writeFile(
    join(plugin, 'skills', 'visualize', 'SKILL.md'),
    '---\nname: visualize\ndescription: "Create visualizations in conversation."\n---\n\nBody.\n',
  )
  return manifest
}

test('claudeRunnableAppPlugin resolves allowed local plugins inside the marketplace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-app-plugins-'))
  try {
    const local = { source: 'local', path: './plugins/visualize' }
    const manifest = await marketplace(join(directory, 'local'), {
      visualize: local,
      browser: local,
    })
    assert.deepEqual(claudeRunnableAppPlugin(manifest, 'visualize'), {
      name: 'visualize',
      root: join(directory, 'local', 'plugins', 'visualize'),
    })
    // Plugins that drive Codex-only tools stay with Codex.
    assert.equal(claudeRunnableAppPlugin(manifest, 'browser'), null)
    assert.equal(claudeRunnableAppPlugin('.agents/plugins/marketplace.json', 'visualize'), null)
    assert.equal(claudeRunnableAppPlugin(join(directory, 'missing.json'), 'visualize'), null)

    const shorthand = await marketplace(join(directory, 'shorthand'), {
      visualize: './plugins/visualize',
    })
    assert.equal(
      claudeRunnableAppPlugin(shorthand, 'visualize')?.root,
      join(directory, 'shorthand', 'plugins', 'visualize'),
    )
    const escaping = await marketplace(join(directory, 'escaping'), {
      visualize: { source: 'local', path: '../local/plugins/visualize' },
    })
    assert.equal(claudeRunnableAppPlugin(escaping, 'visualize'), null)
    const remote = await marketplace(join(directory, 'remote'), {
      visualize: { source: 'git', url: 'https://example.com/visualize.git' },
    })
    assert.equal(claudeRunnableAppPlugin(remote, 'visualize'), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('appPluginSkills lists the skills of allowed plugins from their files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-app-plugins-'))
  try {
    await marketplace(directory, {})
    const root = join(directory, 'plugins', 'visualize')
    assert.deepEqual(appPluginSkills([{ name: 'visualize', root }]), [
      {
        name: 'visualize',
        description: 'Create visualizations in conversation.',
        path: join(root, 'skills', 'visualize', 'SKILL.md'),
        plugin: 'visualize',
      },
    ])
    assert.deepEqual(appPluginSkills([{ name: 'browser', root }]), [])
    assert.deepEqual(appPluginSkills([{ name: 'visualize', root: join(directory, 'gone') }]), [])
    await writeFile(join(root, '.codex-plugin', 'plugin.json'), '{"skills":"../../.."}')
    assert.deepEqual(appPluginSkills([{ name: 'visualize', root }]), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('readsWithin allows only Read calls that stay inside the roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-app-plugins-'))
  try {
    const root = join(directory, 'skill')
    await mkdir(root)
    await writeFile(join(root, 'SKILL.md'), 'skill')
    await writeFile(join(directory, 'secret.txt'), 'secret')
    await symlink(join(directory, 'secret.txt'), join(root, 'link.txt'))
    await symlink(root, join(directory, 'alias'))
    const read = (path: string) => readsWithin('Read', { file_path: path }, [root])
    assert.equal(read(join(root, 'SKILL.md')), true)
    // Files yet to be written, with the temp folder's own symlinks resolved.
    assert.equal(read(join(root, 'missing', 'fragment.html')), true)
    assert.equal(read(join(directory, 'alias', 'SKILL.md')), true)
    assert.equal(
      readsWithin('Read', { file_path: join(root, 'SKILL.md') }, [join(directory, 'alias')]),
      true,
    )
    assert.equal(read(join(directory, 'secret.txt')), false)
    assert.equal(read(`${root}/../secret.txt`), false)
    assert.equal(read(`${root}/missing/../../secret.txt`), false)
    assert.equal(read(join(root, 'link.txt')), false)
    assert.equal(read('skill/SKILL.md'), false)
    assert.equal(readsWithin('Write', { file_path: join(root, 'SKILL.md') }, [root]), false)
    assert.equal(readsWithin('Read', { file_path: join(root, 'SKILL.md') }, []), false)
    assert.equal(readsWithin('Read', { file_path: join(root, 'SKILL.md') }, undefined), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('App skills and the visualization folder follow the desktop guidance', () => {
  const input = {
    baseInstructions: 'Explain in Chinese.',
    developerInstructions: null,
    personality: null,
    desktopPresentation: true,
  }
  const skill = {
    name: 'visualize',
    description: 'Create visualizations in conversation.',
    path: '/plugins/visualize/skills/visualize/SKILL.md',
    plugin: 'visualize',
  }
  const plain = buildSystemPromptAddendum(input)
  const prompt = buildSystemPromptAddendum({
    ...input,
    appSkills: [skill],
    visualizationDir: '/codex/visualizations/2026/10/17/thread',
  })
  assert.ok(plain)
  assert.ok(prompt)
  assert.match(
    prompt,
    /# Codex App skills\n[^\n]+\n- visualize: Create visualizations in conversation\. \(file: \/plugins\/visualize\/skills\/visualize\/SKILL\.md\)\n\n# Inline visualizations\n/,
  )
  assert.match(prompt, /^::codex-inline-vis\{path="\/absolute\/path\/to\/name\.html"\}$/m)
  assert.match(prompt, /in \/codex\/visualizations\/2026\/10\/17\/thread;/)
  assert.ok(prompt.indexOf('# Codex App skills') > prompt.indexOf('Codex desktop'))
  assert.ok(prompt.endsWith('# Project instructions\nExplain in Chinese.'))
  assert.equal(buildSystemPromptAddendum({ ...input, appSkills: [] }), plain)
  // AGENTS.md instructions come after the App sections, before the thread's own.
  const withProject = buildSystemPromptAddendum({
    ...input,
    appSkills: [skill],
    visualizationDir: '/codex/visualizations/2026/10/17/thread',
    projectInstructions: '# AGENTS.md instructions for /repo\n\nUse tabs.',
  })
  assert.ok(withProject)
  assert.ok(
    withProject.indexOf('# AGENTS.md instructions') >
      withProject.indexOf('# Inline visualizations'),
  )
  assert.ok(withProject.endsWith('Use tabs.\n\n# Project instructions\nExplain in Chinese.'))
})
