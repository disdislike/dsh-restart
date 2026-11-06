/**
 * dsh-restart — Host half.
 *
 * Owns the only two Host endpoints the browser half calls:
 *
 *   GET  /dsh-restart/status   whether this process can relaunch the app
 *   POST /dsh-restart/restart  ask the desktop app to restart
 *
 * A restart cannot be performed from inside the Host: the Electron shell owns
 * the application lifetime, and its renderer/Host pair exits with it. The Host
 * therefore only starts a detached helper process and lets the shell take the
 * termination; the helper waits for both PIDs to disappear, then launches the
 * same executable again. That is the same shape the shipped desktop shell uses
 * for its own `app.relaunch()` recovery path, only split across two processes.
 *
 * @module dsh-restart
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Loader identity of the Host half. */
export const name = 'dsh-restart'

/** The HTTP carrier owns the endpoints; without it the plugin stays idle. */
export const inject = ['webServer']

/** Where the browser half asks for the capability. */
const STATUS_ROUTE = '/dsh-restart/status'

/** Where the browser half asks for the restart. */
const RESTART_ROUTE = '/dsh-restart/restart'

/** Request header the browser half sends; a cross-site form cannot set it. */
const TOKEN_HEADER = 'x-dsh-restart'

/** How long the helper waits before terminating the shell, leaving room for the toast. */
const RESTART_DELAY_MS = 1200

/**
 * Whether this Host runs inside the Electron desktop shell, the only
 * environment whose process tree can be relaunched as one application.
 * @returns true for an Electron-hosted process on a supported platform.
 */
function canRestart() {
  return typeof process.versions.electron === 'string' && process.versions.electron !== ''
}

/**
 * Write one JSON response.
 * @param response - the Node response owning the exchange.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * Start the detached relaunch helper once.
 * @param logger - Host logger used for the failure path.
 * @returns true when the helper process was spawned.
 */
function startRelaunch(logger) {
  const executable = process.execPath
  const appPid = process.ppid
  const hostPid = process.pid
  const cwd = dirname(executable)
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'restart-helper.cjs')
  try {
    const child = spawn(
      executable,
      [helper, String(appPid), String(hostPid), executable, cwd, String(RESTART_DELAY_MS)],
      {
        cwd,
        env: process.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    child.on('error', (error) => {
      logger.warn(`relaunch helper failed to start: ${error instanceof Error ? error.message : String(error)}`)
    })
    child.unref()
    return true
  } catch (error) {
    logger.warn(`relaunch helper failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Register the status and restart endpoints for the current Host.
 * @param ctx - plugin context carrying the HTTP carrier.
 */
export function apply(ctx) {
  const logger = ctx.logger('dsh-restart')
  let scheduled = false

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      handler: (_request, response) => {
        sendJson(response, 200, {
          supported: canRestart(),
          platform: process.platform,
          pending: scheduled,
        })
      },
    }),
    'dsh-restart: status route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: RESTART_ROUTE,
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (request.headers[TOKEN_HEADER] !== '1') {
          sendJson(response, 403, { ok: false, error: 'Missing restart confirmation header.' })
          return
        }
        if (!canRestart()) {
          sendJson(response, 503, { ok: false, error: 'Restart is available only in the DeepSeek Harness desktop app.' })
          return
        }
        if (scheduled) {
          sendJson(response, 202, { ok: true, pending: true })
          return
        }
        scheduled = true
        if (!startRelaunch(logger)) {
          scheduled = false
          sendJson(response, 500, { ok: false, error: 'The relaunch helper could not be started.' })
          return
        }
        logger.info('restart scheduled from the sidebar')
        sendJson(response, 202, { ok: true })
      },
    }),
    'dsh-restart: restart route',
  )
}
