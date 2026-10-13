// App-server methods for features Codex gets from OpenAI's services or from
// its own host: connectors, the plugin catalog, remote control, passkey
// verification and account extras. Claude Code has none of them, so each
// method reports the state that holds here (nothing installed, disabled,
// unavailable) and only an action that cannot happen fails. An unanswered
// method would surface in the App as a broken request.

import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringOr } from './server-helpers.mjs'

// A JSON-RPC error whose `data` the App reads.
export class RpcError extends Error {
  readonly data: unknown

  constructor(message: string, data: unknown) {
    super(message)
    this.data = data
  }
}

// The answer to one of these methods; undefined for any other method.
export function hostMethod(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    // Connectors are ChatGPT apps; none is installed or reachable here.
    case 'app/installed':
      return { apps: [] }
    case 'app/read':
      return {
        apps: [],
        missingAppIds: [...new Set(stringList(params.appIds))],
      }
    // The plugin catalog: plugin/list already reports no marketplaces.
    case 'plugin/installed':
      return { marketplaces: [], marketplaceLoadErrors: [] }
    case 'plugin/search':
      return { data: [], nextCursor: null }
    case 'plugin/reconcile':
      return {
        changedPlugins: [],
        failedRemotePluginIds: [],
        failedMaterializationRemotePluginIds: [],
      }
    // Remote control relays this machine to ChatGPT on other devices; this
    // server never connects to the relay.
    case 'remoteControl/status/read':
    case 'remoteControl/disable':
      return remoteControlStatus()
    case 'remoteControl/enable':
    case 'remoteControl/pairing/start':
      throw new Error('remote control is not available with Claude Code')
    case 'remoteControl/pairing/status':
      return { claimed: false }
    case 'remoteControl/client/list':
      return { data: [], nextCursor: null }
    case 'remoteControl/client/revoke':
      throw new Error(`remote control client not found: ${stringOr(params.clientId, '')}`)
    // Passkey verification of the OpenAI account: there is no provider.
    case 'userVerification/status':
      return {
        credentialId: null,
        unavailableReason: 'providerUnavailable',
        unavailableMessage: VERIFICATION_UNAVAILABLE,
      }
    case 'userVerification/enroll':
    case 'userVerification/verify':
      throw new RpcError(VERIFICATION_UNAVAILABLE, {
        type: 'unavailable',
        reason: 'providerUnavailable',
      })
    case 'userVerification/cancel':
    case 'userVerification/delete':
      return {}
    // Claude Code signs in on its own; Codex's Bedrock setup and gateway
    // sign-in configure Codex's model provider.
    case 'account/bedrock/discover':
      return { profiles: [], environmentCredentials: [] }
    case 'account/bedrock/setup':
      throw new Error('Bedrock is configured in Claude Code, not through the Codex App')
    case 'account/gatewayOAuth/read':
      return { providerId: '', providerName: '', required: false, status: null, error: null }
    case 'account/gatewayOAuth/login':
      throw new Error('no model provider here signs in through a gateway')
    case 'account/gatewayOAuth/cancel':
      return {}
    case 'account/rateLimitResetCredit/consume':
      return { outcome: 'noCredit' }
    case 'account/workspaceMessages/read':
      return { featureEnabled: false, messages: [] }
    // Every environment runs on this machine.
    case 'environment/info':
      return {
        shell: {
          name: basename(process.env.SHELL ?? '/bin/sh'),
          path: process.env.SHELL ?? '/bin/sh',
        },
        cwd: pathToFileURL(process.cwd()).href,
      }
    case 'environment/status':
      return { status: 'ready' }
    default:
      return undefined
  }
}

const VERIFICATION_UNAVAILABLE = 'Passkey verification is not available with Claude Code'

// account/usage/read. Codex reads the account's token activity from OpenAI;
// here only the thread history speaks for it, and it keeps no per-turn token
// counts: the answer is the longest turn and the streaks of days with a turn.
// A thread's billed usage has no source either.
export function accountUsage(
  activity: { days: string[]; longestTurnMs: number | null },
  today = localDay(new Date()),
): unknown {
  const streaks = dayStreaks(activity.days, today)
  return {
    summary: {
      lifetimeTokens: null,
      peakDailyTokens: null,
      longestRunningTurnSec:
        activity.longestTurnMs == null ? null : Math.round(activity.longestTurnMs / 1000),
      currentStreakDays: streaks.current,
      longestStreakDays: streaks.longest,
    },
    dailyUsageBuckets: null,
    threadUsage: null,
  }
}

// Runs of consecutive days among `days` (YYYY-MM-DD, oldest first). The
// current run ends today, or yesterday while today has none yet.
export function dayStreaks(days: string[], today: string): { current: number; longest: number } {
  let longest = 0
  let run = 0
  let previous: number | null = null
  for (const day of days) {
    const index = dayNumber(day)
    run = previous != null && index === previous + 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    previous = index
  }
  return { current: previous != null && dayNumber(today) - previous <= 1 ? run : 0, longest }
}

// YYYY-MM-DD in local time, as SQLite's date(..., 'localtime') writes it.
export function localDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000)
}

function remoteControlStatus(): unknown {
  return {
    status: 'disabled',
    serverName: hostname(),
    installationId: installationId(),
    environmentId: null,
  }
}

// A UUID that stays the same for this user on this machine.
function installationId(): string {
  const hex = createHash('sha256').update(`${hostname()}\0${homedir()}`).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}
