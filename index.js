/**
 * Host half of @chenkai114/dsh-decision-dingtalk.
 *
 * Watches the decisions any Session is waiting on, forwards them to DingTalk,
 * and settles them from a chat reply or from the workstation, whichever answers
 * first. The same row also serves the settings section through same-origin routes.
 */
import { readFileSync } from 'node:fs'
import { resolveConfig } from './lib/config.js'
import { createBridge } from './lib/bridge.js'
import { createTransport } from './lib/transport.js'
import { registerHostApi } from './lib/host-api.js'

export const name = 'decision-dingtalk'

/** Package identity shown on the settings page. */
const PACKAGE_NAME = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name

/**
 * Install the bridge and its settings routes for this profile.
 * @param {any} ctx Plugin context.
 * @param {unknown} rawConfig The row's `config`.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger('decision-dingtalk')
  const config = resolveConfig(rawConfig)
  // The routes answer even when the bridge is inert, so the page can show why.
  ctx.effect(() => {
    if (config.problems.length > 0) logger.warn(`not active yet: ${config.problems.join('; ')}`)
    else logger.info(`watching decisions, push=${config.push.mode} read=${config.read.mode} `
      + `target=${config.target.kind}:${config.target.id}`)

    const bridge = config.problems.length > 0 || !config.enabled
      ? undefined
      : createBridge({ ctx, config, transport: createTransport(config, logger), logger })

    // The settings routes need the host web server. Mount them through an
    // optional child so a composition without one still runs the bridge.
    const mount = (scope) => scope.effect(() => registerHostApi({
      ctx: scope,
      webServer: scope.webServer,
      config: () => config,
      logger,
      pending: () => bridge?.pending() ?? 0,
      sendTest: async (text) => {
        if (bridge === undefined) return { ok: false, error: `还不能发送：${config.problems.join('；') || '插件未启用'}` }
        return bridge.sendTest(text)
      },
      pluginName: PACKAGE_NAME,
    }), 'decision-dingtalk: settings routes')
    ctx.inject(['webServer'], mount)

    return () => { bridge?.dispose() }
  }, 'decision-dingtalk: bridge and settings routes')
}