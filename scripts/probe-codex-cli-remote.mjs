#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { join, resolve } from 'node:path'

const root = resolve('.')
const adapter = resolve('dist/src/adapter.mjs')
const probeRoot = resolve('.claude-codex')
await mkdir(probeRoot, { recursive: true })
const home = await mkdtemp(join(probeRoot, 'codex-cli-remote-probe-'))
const adapterHome = join(home, 'adapter-home')
await mkdir(adapterHome, { recursive: true })
const port = await freePort()
const remote = `ws://127.0.0.1:${port}`
let adapterProc = null
let adapterStderr = ''
class ProbeDone extends Error {}

try {
  adapterProc = spawn(process.execPath, [adapter, 'app-server', '--listen', remote], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CODEX_HOME: adapterHome, CLAUDE_CODEX_MOCK: '1', NODE_NO_WARNINGS: '1' },
  })
  adapterProc.stderr.setEncoding('utf8')
  adapterProc.stderr.on('data', (chunk) => {
    adapterStderr += chunk
  })
  await waitFor(
    () => adapterStderr.includes(`listening on ${remote}`),
    5000,
    `adapter did not listen on ${remote}`,
  )

  const codex = which('codex')
  if (!codex) {
    console.log('status=blocked-no-codex-cli')
    console.log('reason=codex executable was not found in PATH')
    process.exitCode = 0
    throw new ProbeDone()
  }

  const nonTty = spawnSync(codex, ['--remote', remote, '--no-alt-screen'], {
    cwd: root,
    env: { ...process.env, TERM: 'dumb' },
    encoding: 'utf8',
    timeout: 15_000,
  })
  const nonTtyOutput = `${nonTty.stdout ?? ''}${nonTty.stderr ?? ''}`
  if (/Refusing to start the interactive TUI|TERM is set to "dumb"/i.test(nonTtyOutput)) {
    console.log('non_tty=status=blocked-no-tty')
  } else {
    console.log(`non_tty=status=${nonTty.status ?? 'signal'}`)
  }

  const expectBin = which('expect')
  if (!expectBin) {
    console.log('tty=status=skipped-no-expect')
    console.log(`remote=${remote}`)
    throw new ProbeDone()
  }

  const transcript = join(home, 'codex-cli-remote.expect.log')
  const expectScript = join(home, 'codex-cli-remote.expect')
  await writeFile(
    expectScript,
    [
      'set timeout 35',
      `log_file -a ${tclQuote(transcript)}`,
      'spawn env TERM=xterm-256color $env(CODEX_PROBE_CODEX) --remote $env(CODEX_PROBE_REMOTE) --no-alt-screen',
      'set sent 0',
      'expect {',
      '  -re {\\x1b\\[6n} { send "\\033\\[1;1R"; exp_continue }',
      '  -re {\\x1b\\[c} { send "\\033\\[?1;0c"; exp_continue }',
      '  -re {\\x1b\\[>7u} { send "\\033\\[?0u"; exp_continue }',
      '  -re {\\x1b\\[\\?u} { send "\\033\\[?0u"; exp_continue }',
      '  -re {\\x1b\\]10;\\?\\x1b\\\\} { send "\\033]10;rgb:ffff/ffff/ffff\\033\\\\"; exp_continue }',
      '  -re {\\x1b\\]11;\\?\\x1b\\\\} { send "\\033]11;rgb:0000/0000/0000\\033\\\\"; exp_continue }',
      '  -re {Welcome to Codex|Sign in with ChatGPT|sign in with ChatGPT|not authenticated|not logged in|login required} { exit 20 }',
      '  -re {Refusing to start the interactive TUI|TERM is set to} { exit 21 }',
      '  -re {What can I help|Ask Codex|Type a message|Send a message|›} { if {$sent == 0} { send "Reply with exactly: codex-remote-probe-ok\\r"; set sent 1 }; exp_continue }',
      '  -re {codex-remote-probe-ok} { exit 0 }',
      '  timeout { exit 22 }',
      '  eof { exit 23 }',
      '}',
      '',
    ].join('\n'),
  )

  const tty = spawnSync(expectBin, [expectScript], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_PROBE_CODEX: codex,
      CODEX_PROBE_REMOTE: remote,
    },
    encoding: 'utf8',
    timeout: 45_000,
  })
  const transcriptText = await readFile(transcript, 'utf8').catch(() => '')
  const output = `${tty.stdout ?? ''}${tty.stderr ?? ''}${transcriptText}`

  if (tty.status === 0 || /codex-remote-probe-ok/i.test(output)) {
    console.log('tty=status=passed')
    console.log('result=current codex CLI reached the remote adapter and completed a prompt')
  } else if (
    tty.status === 20 ||
    /Welcome to Codex|Sign in with ChatGPT|not authenticated|not logged in|login required/i.test(
      output,
    )
  ) {
    console.log('tty=status=blocked-login')
    console.log('reason=current codex CLI stops at local login before it can exercise --remote')
  } else if (
    tty.status === 21 ||
    /Refusing to start the interactive TUI|TERM is set to/i.test(output)
  ) {
    console.log('tty=status=blocked-no-tty')
  } else if (tty.error?.code === 'ETIMEDOUT' || tty.status === 22) {
    console.log('tty=status=blocked-timeout')
    console.log('reason=current codex CLI stayed interactive without completing the probe prompt')
  } else {
    console.log(`tty=status=failed-${tty.status ?? tty.signal ?? 'unknown'}`)
  }
  console.log(`remote=${remote}`)
  console.log(`transcript=${transcript}`)
} catch (error) {
  if (!(error instanceof ProbeDone)) throw error
} finally {
  adapterProc?.kill()
  if (process.env.CLAUDE_CODEX_CLEAN_PROBE_ARTIFACTS === '1') {
    await rm(home, { recursive: true, force: true })
  }
}

function which(command) {
  const result = spawnSync('/usr/bin/env', ['which', command], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function waitFor(predicate, timeoutMs, message) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

function tclQuote(value) {
  return `{${String(value).replaceAll('}', '\\}')}}`
}
