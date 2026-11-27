/**
 * Host routes behind the settings section.
 *
 * A plain-JavaScript bundle cannot export a schemastery `Config`, so the page
 * talks to these same-origin routes instead: read the effective config and the
 * `dws` environment, enumerate what can be chosen, save through the profile's
 * config editor, and send one test card.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Prefix every route of this plugin lives under. */
export const API_BASE = '/decision-dingtalk'

/**
 * @typedef {object} HostApiInput
 * @property {any} ctx Plugin context.
 * @property {any} webServer The host web server service.
 * @property {any} config Resolved config, read again on every request.
 * @property {{ warn: Function, debug: Function, info: Function }} logger Plugin logger.
 * @property {() => number} pending Number of decisions waiting on the chat.
 * @property {(text: string) => Promise<{ ok: boolean, error?: string }>} sendTest Send one test card.
 * @property {string} pluginName Package name, shown on the page.
 */

/**
 * Mount the routes.
 * @param {HostApiInput} input Wiring for this plugin load.
 * @returns {() => void} Disposer.
 */
export function registerHostApi(input) {
  const disposers = [
    input.webServer.register({
      kind: 'prefix',
      path: API_BASE,
      auth: 'required',
      handler: (request, response, peer) => handle(input, request, response, peer),
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Dispatch one request.
 * @param {HostApiInput} input Wiring for this plugin load.
 * @param {any} request Node request.
 * @param {any} response Node response.
 * @param {any} peer Admitted peer.
 * @returns {Promise<void>} Resolves after the response ends.
 */
async function handle(input, request, response, peer) {
  if (peer?.principal?.kind !== 'owner') return json(response, 403, { error: 'forbidden' })
  const url = new URL(request.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(API_BASE.length).replace(/\/$/u, '')

  try {
    if (request.method === 'GET' && route === '/status') return json(response, 200, await status(input))
    if (request.method === 'GET' && route === '/options') return json(response, 200, await options(input))
    if (request.method === 'POST' && route === '/config') {
      const body = await readJson(request)
      return json(response, 200, await save(input, body))
    }
    if (request.method === 'POST' && route === '/test') {
      const result = await input.sendTest('### ✅ 决策通道自检\n这条来自设置页的「测试发送」。以后有会话等你拍板，卡会发到这里。')
      return json(response, 200, result)
    }
    return json(response, 404, { error: `unknown route ${route}` })
  } catch (error) {
    input.logger.warn(`decision-dingtalk: ${route} failed: ${String(error)}`)
    return json(response, 500, { error: String(error?.message ?? error) })
  }
}

/**
 * Report the effective config plus the `dws` environment it needs.
 * @param {HostApiInput} input Wiring for this plugin load.
 * @returns {Promise<object>} Status payload.
 */
async function status(input) {
  const config = input.config()
  const dws = await probeDws(config.push.mode === 'dws' || config.read.mode === 'dws' ? config.push.dws : 'dws')
  return { config: shape(config), dws, pending: input.pending(), plugin: input.pluginName }
}

/**
 * List what the reader may pick instead of typing an id.
 * @param {HostApiInput} input Wiring for this plugin load.
 * @returns {Promise<object>} Groups and bots `dws` reports.
 */
async function options(input) {
  const config = input.config()
  const [groups, bots] = await Promise.all([
    listGroups(config.push.dws).catch(error => ({ error: String(error?.message ?? error) })),
    listBots(config.push.dws).catch(error => ({ error: String(error?.message ?? error) })),
  ])
  return { groups, bots }
}

/**
 * Persist one patch through the profile's config editor.
 * @param {HostApiInput} input Wiring for this plugin load.
 * @param {any} patch Partial config from the page.
 * @returns {Promise<object>} The saved effective config.
 */
async function save(input, patch) {
  const editor = input.ctx.get?.('configEditor')
  const entry = input.ctx.fiber?.entry
  if (editor === undefined || entry === undefined) throw new Error('这个 profile 不允许写回插件配置')
  if (typeof patch !== 'object' || patch === null) throw new Error('bad patch')
  await editor.edit(entry, current => merge(current, patch))
  // An ordinary field restarts the plugin, so the page re-reads /status for the new values.
  return { saved: true }
}

/**
 * Deep-merge a patch over the current row config, keeping unknown fields.
 * @param {any} current Current config.
 * @param {any} patch Partial config.
 * @returns {any} Merged config.
 */
function merge(current, patch) {
  const base = typeof current === 'object' && current !== null ? current : {}
  const next = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = merge(base[key], value)
      continue
    }
    next[key] = value
  }
  return next
}

/**
 * Project the resolved config into the page's shape.
 * @param {any} config Resolved config.
 * @returns {object} Serializable config.
 */
function shape(config) {
  return {
    enabled: config.enabled,
    target: config.target,
    push: { mode: config.push.mode, robotCode: config.push.robotCode },
    read: { mode: config.read.mode, pollSeconds: config.read.pollSeconds, allowSenders: config.read.allowSenders },
    behavior: {
      answerInChat: config.behavior.answerInChat,
      requireToken: config.behavior.requireToken,
      textQuestions: config.behavior.textQuestions,
      includeSubagents: config.behavior.includeSubagents,
      quietHours: config.behavior.quietHours,
    },
    problems: config.problems,
  }
}

/**
 * Check whether `dws` exists, which version it is, and whether the operator is signed in.
 * @param {string} cli The configured command.
 * @returns {Promise<object>} Probe result, never a rejection.
 */
async function probeDws(cli) {
  try {
    const { stdout } = await run(cli, ['--version'], { timeout: 8_000, maxBuffer: 1 << 20 })
    const version = /v?\d+\.\d+\.\d+[^\s]*/u.exec(stdout)?.[0]
    try {
      const { stdout: authOut } = await run(cli, ['auth', 'status', '-f', 'json'], { timeout: 12_000, maxBuffer: 1 << 20 })
      const auth = JSON.parse(authOut)
      return {
        path: cli,
        installed: true,
        version,
        loggedIn: auth?.authenticated === true && auth?.token_valid !== false,
        expiresAt: auth?.expires_at,
      }
    } catch (error) {
      return { path: cli, installed: true, version, loggedIn: false, error: String(error?.message ?? error) }
    }
  } catch (error) {
    return { path: cli, installed: false, error: String(error?.message ?? error) }
  }
}

/**
 * Read the groups the operator belongs to.
 * @param {string} cli The configured command.
 * @returns {Promise<Array<{ id: string, name: string, memberCount?: number, kind: string }>>} Groups.
 */
async function listGroups(cli) {
  const { stdout } = await run(cli, ['chat', '+chat-list', '--limit', '50', '-f', 'json'], { timeout: 25_000, maxBuffer: 8 << 20 })
  const page = JSON.parse(stdout)
  const rows = page?.chats ?? page?.items ?? []
  return rows
    .filter(row => typeof row?.openConversationId === 'string' && typeof row?.name === 'string')
    .map(row => ({ id: row.openConversationId, name: row.name, memberCount: row.memberCount, kind: 'group' }))
}

/**
 * Read the robots this operator created.
 * @param {string} cli The configured command.
 * @returns {Promise<Array<{ code: string, name: string, kind: string }>>} Robots.
 */
async function listBots(cli) {
  const { stdout } = await run(cli, ['chat', 'bot', 'search', '--query', '', '-f', 'json'], { timeout: 25_000, maxBuffer: 4 << 20 })
  const page = JSON.parse(stdout)
  return (page?.robotList ?? [])
    .filter(row => typeof row?.robotCode === 'string')
    .map(row => ({ code: row.robotCode, name: String(row.robotName ?? row.robotCode), kind: 'bot' }))
}

/**
 * Read a JSON request body.
 * @param {any} request Node request.
 * @returns {Promise<any>} Parsed body.
 */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/**
 * Write one JSON response.
 * @param {any} response Node response.
 * @param {number} code Status code.
 * @param {any} body JSON body.
 * @returns {void}
 */
function json(response, code, body) {
  if (response.writableEnded) return
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}