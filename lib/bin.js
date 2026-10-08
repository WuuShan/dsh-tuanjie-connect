#!/usr/bin/env node
/**
 * Standalone status/diagnostics CLI for dsh-tuanjie-connect.
 *
 * Boot-free on purpose: it answers "am I signed in, whose account is this, and
 * how much quota is left" without starting DSH, which is what makes it useful
 * when the provider is not appearing in the model picker.
 *
 * Usage: dsh-tuanjie-connect <status|doctor> [--json]
 *
 * @module dsh-tuanjie-connect/bin
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { collectStatus, defaultAuthPath, defaultOrgPath } from './codely.js'

const JSON_SCHEMA_VERSION = 1

/** Strip anything token-shaped from a message before it reaches a terminal. */
function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted key]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: dsh-tuanjie-connect <status|doctor> [--json]',
      '',
      '  status   sign-in state, account, remaining quota, and model-key health',
      '  doctor   secret-free environment diagnostics (paths, token expiry, key shape)',
      '',
      '  --json   emit one secret-free JSON document',
      '',
      `  Credential file: ${defaultAuthPath()}`,
      `  Org file:        ${defaultOrgPath()}`,
      '  Override with DSH_TUANJIE_AUTH_FILE / DSH_TUANJIE_ORG_FILE.',
      '',
    ].join('\n'),
  )
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** Human-readable quota line, including per-bucket detail when present. */
function quotaLine(account) {
  if (account === undefined) return 'Remaining quota: unknown'
  if (account.quotaError !== undefined) return `Remaining quota: unavailable (${account.quotaError})`
  if (account.remainingPoints === undefined) return 'Remaining quota: unknown'
  const base = `Remaining quota: ${account.remainingPoints} points`
  if (account.exhausted) return `${base} — EXHAUSTED`
  if (account.buckets.length > 1) {
    const detail = account.buckets
      .map((bucket) => `${bucket.type ?? 'pool'}=${bucket.remainingPoints}`)
      .join(', ')
    return `${base} (${detail})`
  }
  return base
}

async function runStatus(jsonOutput) {
  const status = await collectStatus({ version: process.env.npm_package_version })

  if (jsonOutput) {
    printJson({ schemaVersion: JSON_SCHEMA_VERSION, ...status })
    return status.state === 'signed-in' ? 0 : 1
  }

  if (status.state === 'signed-out') {
    process.stdout.write(`Tuanjie Cowork Connect: signed out\nCredential file: ${status.authFile.path}\n`)
    process.stdout.write(`Hint: ${status.hint}\n`)
    return 1
  }

  if (status.state === 'error') {
    process.stdout.write(`Tuanjie Cowork Connect: sign-in rejected\n`)
    process.stdout.write(`Account: ${status.username ?? '(unknown)'}\n`)
    process.stdout.write(`Error: ${safeMessage(status.error)}\n`)
    process.stdout.write(`Hint: ${status.hint}\n`)
    return 1
  }

  process.stdout.write(
    [
      `Tuanjie Cowork Connect: signed in${status.username === undefined ? '' : ` as ${status.username}`}`,
      ...(status.email === undefined ? [] : [`Email: ${status.email}`]),
      ...(status.accessTokenExpires === undefined
        ? []
        : [
            `Access token expires ${status.accessTokenExpires} (${status.accessTokenDaysLeft} days; refresh is automatic)`,
          ]),
      quotaLine(status.account),
      `Model key: ${status.modelKey.state}${status.modelKey.error === undefined ? '' : ` (${safeMessage(status.modelKey.error)})`}`,
      `Credential file: ${status.authFile.path}`,
      '',
    ].join('\n'),
  )
  return 0
}

async function runDoctor(jsonOutput) {
  const status = await collectStatus({ version: process.env.npm_package_version })
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: status.package,
    version: status.version,
    node: status.node,
    authFile: status.authFile,
    orgFile: defaultOrgPath(),
    signIn: status.state,
    ...(status.username === undefined ? {} : { username: status.username }),
    ...(status.accessTokenExpires === undefined ? {} : { accessTokenExpires: status.accessTokenExpires }),
    ...(status.accessTokenDaysLeft === undefined ? {} : { accessTokenDaysLeft: status.accessTokenDaysLeft }),
    ...(status.modelKey === undefined ? {} : { modelKey: status.modelKey }),
    ...(status.account?.remainingPoints === undefined
      ? {}
      : { remainingPoints: status.account.remainingPoints }),
    ...(status.error === undefined ? {} : { error: safeMessage(status.error) }),
    ...(status.quotaError === undefined ? {} : { quotaError: safeMessage(status.quotaError) }),
    hints: [
      ...(status.authFile.present
        ? []
        : [`No credential file at ${status.authFile.path}. Set DSH_TUANJIE_AUTH_FILE if the app keeps it elsewhere.`]),
      ...(status.state === 'signed-in' ? [] : [status.hint ?? 'The provider will show no models until sign-in works.']),
      ...(status.accessTokenDaysLeft !== undefined && status.accessTokenDaysLeft < 30
        ? ['The access token expires soon; sign in through the app to renew it.']
        : []),
      ...(status.modelKey?.state === 'ready'
        ? []
        : ['No usable model key; the provider will fail every request until one can be minted.']),
    ].filter((hint) => typeof hint === 'string'),
  }

  if (jsonOutput) {
    printJson(report)
    return status.state === 'signed-in' ? 0 : 1
  }

  process.stdout.write(
    [
      `${report.package} ${report.version ?? ''} on ${report.node}`.trim(),
      `Credential file: ${report.authFile.present ? 'present' : 'missing'} (${report.authFile.path})`,
      `Org file: ${report.orgFile}`,
      `Sign-in state: ${report.signIn}`,
      ...(report.username === undefined ? [] : [`Account: ${report.username}`]),
      ...(report.accessTokenExpires === undefined
        ? []
        : [`Access token: ${report.accessTokenExpires} (${report.accessTokenDaysLeft} days left)`]),
      ...(report.modelKey === undefined ? [] : [`Model key: ${report.modelKey.state}`]),
      ...(report.remainingPoints === undefined ? [] : [`Remaining quota: ${report.remainingPoints} points`]),
      ...report.hints.map((hint) => `Hint: ${hint}`),
      '',
    ].join('\n'),
  )
  return status.state === 'signed-in' ? 0 : 1
}

/** Execute one boot-free command. */
export async function run(argv) {
  const [action, ...flags] = argv
  if (action === undefined || action === '--help' || action === '-h') {
    printHelp()
    return 0
  }
  if (action !== 'status' && action !== 'doctor') {
    process.stderr.write(
      `dsh-tuanjie-connect: expected status or doctor; got ${JSON.stringify(action)}\n`,
    )
    return 1
  }
  const jsonOutput = flags.includes('--json')
  const rest = flags.filter((flag) => flag !== '--json')
  if (rest.length > 0) {
    process.stderr.write(`dsh-tuanjie-connect: invalid options for ${action}: ${rest.join(' ')}\n`)
    return 1
  }
  try {
    return action === 'status' ? await runStatus(jsonOutput) : await runDoctor(jsonOutput)
  } catch (error) {
    process.stderr.write(`dsh-tuanjie-connect: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
