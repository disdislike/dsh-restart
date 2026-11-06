'use strict'

/**
 * dsh-restart relaunch helper.
 *
 * Started detached by the Host half, this process outlives both the Electron
 * shell and the Host child it was launched from. It terminates the shell,
 * waits until neither the shell nor the Host still exists, and then launches
 * the same executable again as a normal (non-Node-mode) application.
 *
 * Arguments: <app pid> <host pid> <executable> <working directory> <delay ms>
 *
 * Every step that could strand the user without an application is ordered so
 * the relaunch happens only after the previous instance released its files and
 * single-instance lock.
 */

const { spawn } = require('node:child_process')
const { appendFileSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

/** Upper bound on waiting for either process to disappear. */
const EXIT_DEADLINE_MS = 20000

/** Pause between two liveness probes. */
const PROBE_INTERVAL_MS = 100

/** Extra settle time after both processes are gone, for file handles to close. */
const SETTLE_MS = 400

const [appPidText, hostPidText, executable, cwd, delayText] = process.argv.slice(2)

/**
 * Append one line to the helper log; logging never fails the relaunch.
 * @param {string} message - what happened.
 */
function log(message) {
  try {
    appendFileSync(join(tmpdir(), 'dsh-restart.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // A missing log file must not stop the restart.
  }
}

/**
 * @param {string | undefined} value - decimal process id.
 * @returns {number} the parsed id, or NaN.
 */
function parsePid(value) {
  const pid = Number.parseInt(String(value ?? ''), 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : Number.NaN
}

/**
 * @param {number} milliseconds - how long to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * @param {number} pid - process to probe.
 * @returns {boolean} whether the process still exists.
 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Wait until one process no longer exists.
 * @param {number} pid - process to wait for.
 * @param {number} deadline - epoch milliseconds after which waiting stops.
 * @returns {Promise<boolean>} whether the process is gone.
 */
async function waitGone(pid, deadline) {
  while (alive(pid) && Date.now() < deadline) await sleep(PROBE_INTERVAL_MS)
  return !alive(pid)
}

async function main() {
  const appPid = parsePid(appPidText)
  const hostPid = parsePid(hostPidText)
  const delayMs = Number.parseInt(String(delayText ?? ''), 10)

  if (Number.isNaN(appPid) || Number.isNaN(hostPid) || appPid === process.pid || hostPid === process.pid) {
    log('invalid arguments; restart cancelled')
    process.exit(2)
  }
  if (typeof executable !== 'string' || executable === '' || !existsSync(executable)) {
    log(`executable unavailable (${String(executable)}); restart cancelled`)
    process.exit(3)
  }
  if (typeof cwd !== 'string' || cwd === '' || !existsSync(cwd)) {
    log(`working directory unavailable (${String(cwd)}); restart cancelled`)
    process.exit(4)
  }

  log(`scheduled: app=${appPid} host=${hostPid} executable=${executable}`)
  await sleep(Number.isSafeInteger(delayMs) && delayMs >= 0 ? delayMs : 1200)

  if (alive(appPid)) {
    try {
      process.kill(appPid)
      log('termination sent to the application shell')
    } catch (error) {
      log(`termination failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const deadline = Date.now() + EXIT_DEADLINE_MS
  const appGone = await waitGone(appPid, deadline)
  let hostGone = await waitGone(hostPid, deadline)
  if (!hostGone) {
    // A Host that will not finish its graceful shutdown must not survive into
    // the next instance and keep writing the same profile files.
    log('host did not exit in time; terminating it')
    try {
      process.kill(hostPid)
    } catch (error) {
      log(`host termination failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    hostGone = await waitGone(hostPid, Date.now() + 3000)
  }
  if (!appGone) {
    log('shell still present after the deadline; terminating it again')
    try {
      process.kill(appPid)
    } catch {
      // Already gone between the probe and this call.
    }
  }
  log(`previous instance gone: app=${appGone} host=${hostGone}`)
  await sleep(SETTLE_MS)

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [], {
    cwd,
    env: environment,
    detached: true,
    stdio: 'ignore',
  })
  child.once('error', (error) => {
    log(`relaunch failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
  child.unref()
  log('application relaunched')
  process.exit(0)
}

main().catch((error) => {
  log(`helper crashed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
