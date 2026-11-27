/**
 * Host half of @chenkai114/dsh-decision-dingtalk.
 *
 * Watches the decisions any Session is waiting on, forwards them to DingTalk,
 * and settles them from a chat reply or from the workstation, whichever answers
 * first.
 */
import { resolveConfig } from './lib/config.js'
import { createBridge } from './lib/bridge.js'
import { createTransport } from './lib/transport.js'

export const name = 'decision-dingtalk'

/**
 * Install the bridge for this profile.
 * @param {any} ctx Plugin context.
 * @param {unknown} rawConfig The row's `config`.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger('decision-dingtalk')
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    logger.info('disabled by config')
    return
  }
  if (config.problems.length > 0) {
    logger.warn(`not active yet: ${config.problems.join('; ')}`)
    return
  }

  ctx.effect(() => {
    const transport = createTransport(config, logger)
    const bridge = createBridge({ ctx, config, transport, logger })
    logger.info(`watching decisions, ${transport.describe()}`)
    return () => bridge.dispose()
  }, 'decision-dingtalk: bridge')
}