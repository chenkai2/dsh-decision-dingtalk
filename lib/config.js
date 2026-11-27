/**
 * Config normalization for the decision bridge.
 *
 * The bundle ships an inert row: an empty target or transport is reported as a
 * problem instead of throwing, so installing the plugin never breaks a profile
 * that has not been configured yet.
 */

/** @typedef {'group' | 'user'} TargetKind */

/**
 * @typedef {object} ResolvedConfig
 * @property {boolean} enabled
 * @property {{ kind: TargetKind, id: string }} target
 * @property {{ mode: 'dws' | 'webhook', dws: string, robotCode: string, webhookUrl: string, signingKey: string, atUserIds: string[] }} push
 * @property {{ mode: 'dws' | 'none', dws: string, pollSeconds: number, allowSenders: string[] }} read
 * @property {{ answerInChat: boolean, requireToken: boolean, includeSubagents: boolean, maxPending: number, expireMinutes: number, quietHours: { enabled: boolean, start: string, end: string } }} behavior
 * @property {string[]} problems Human-readable reasons the bridge cannot run yet.
 */

const DEFAULTS = {
  enabled: true,
  push: {
    mode: 'dws',
    dws: 'dws',
    robotCode: '',
    // Access address of a group custom robot, including its access_token query value.
    webhookUrl: '',
    signingKey: '',
    atUserIds: [],
  },
  read: { mode: 'dws', dws: 'dws', pollSeconds: 15, allowSenders: [] },
  behavior: {
    answerInChat: true,
    requireToken: true,
    includeSubagents: false,
    maxPending: 6,
    expireMinutes: 0,
    quietHours: { enabled: false, start: '23:00', end: '08:00' },
  },
}

/**
 * Read one value that may be a scalar or a one-element list.
 * @param {unknown} value Raw config value.
 * @param {string[]} fallback Value used when the field is absent.
 * @returns {string[]} Non-empty trimmed strings.
 */
function stringList(value, fallback) {
  if (value === undefined || value === null) return [...fallback]
  const items = Array.isArray(value) ? value : [value]
  return items.map(item => String(item).trim()).filter(item => item.length > 0)
}

/**
 * Read an integer inside a range, falling back when the value is unusable.
 * @param {unknown} value Raw config value.
 * @param {number} fallback Value used when the field is absent or unreadable.
 * @param {number} min Lowest accepted value.
 * @param {number} max Highest accepted value.
 * @returns {number} The accepted value.
 */
function integer(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/**
 * Normalize the row's `config` into the shape the bridge reads.
 * @param {unknown} raw The Loader-provided config object.
 * @returns {ResolvedConfig} Normalized config plus the reasons it is not usable yet.
 */
export function resolveConfig(raw) {
  const input = typeof raw === 'object' && raw !== null ? /** @type {Record<string, any>} */ (raw) : {}
  const push = { ...DEFAULTS.push, ...(input.push ?? {}) }
  const read = { ...DEFAULTS.read, ...(input.read ?? {}) }
  const behavior = { ...DEFAULTS.behavior, ...(input.behavior ?? {}) }

  // A bare string target is the common case: one conversation id.
  const rawTarget = input.target
  const target = typeof rawTarget === 'string' || typeof rawTarget === 'number'
    ? { kind: /** @type {TargetKind} */ ('group'), id: String(rawTarget).trim() }
    : {
        kind: rawTarget?.kind === 'user' ? /** @type {TargetKind} */ ('user') : /** @type {TargetKind} */ ('group'),
        id: String(rawTarget?.id ?? '').trim(),
      }

  const resolved = {
    enabled: input.enabled !== false,
    target,
    push: {
      mode: push.mode === 'webhook' ? /** @type {'webhook'} */ ('webhook') : /** @type {'dws'} */ ('dws'),
      dws: String(push.dws ?? DEFAULTS.push.dws).trim() || DEFAULTS.push.dws,
      robotCode: String(push.robotCode ?? '').trim(),
      webhookUrl: String(push.webhookUrl ?? '').trim(),
      signingKey: String(push.signingKey ?? '').trim(),
      atUserIds: stringList(push.atUserIds, []),
    },
    read: {
      mode: read.mode === 'none' ? /** @type {'none'} */ ('none') : /** @type {'dws'} */ ('dws'),
      dws: String(read.dws ?? DEFAULTS.read.dws).trim() || DEFAULTS.read.dws,
      pollSeconds: integer(read.pollSeconds, DEFAULTS.read.pollSeconds, 5, 600),
      allowSenders: stringList(read.allowSenders, []),
    },
    behavior: {
      answerInChat: behavior.answerInChat !== false,
      requireToken: behavior.requireToken !== false,
      includeSubagents: behavior.includeSubagents === true,
      maxPending: integer(behavior.maxPending, DEFAULTS.behavior.maxPending, 1, 50),
      expireMinutes: integer(behavior.expireMinutes, DEFAULTS.behavior.expireMinutes, 0, 24 * 60),
      quietHours: {
        enabled: behavior.quietHours?.enabled === true,
        start: String(behavior.quietHours?.start ?? DEFAULTS.behavior.quietHours.start),
        end: String(behavior.quietHours?.end ?? DEFAULTS.behavior.quietHours.end),
      },
    },
    problems: [],
  }

  if (resolved.target.id === '') resolved.problems.push('target.id is empty: set the DingTalk conversation to push to')
  if (resolved.push.mode === 'dws' && resolved.push.robotCode === '') {
    resolved.problems.push('push.robotCode is empty: `dws chat message send-by-bot` needs the robot code')
  }
  if (resolved.push.mode === 'webhook' && resolved.push.webhookUrl === '') {
    resolved.problems.push('push.webhookUrl is empty: a custom robot webhook address is required')
  }
  if (resolved.read.mode === 'dws' && !resolved.behavior.answerInChat) {
    // Reading is only there to settle requests, so a notify-only bridge does not poll.
    resolved.read.mode = 'none'
  }

  return resolved
}

/**
 * Whether an instant falls inside the configured quiet hours, tolerating windows across midnight.
 * @param {{ enabled: boolean, start: string, end: string }} range Quiet-hours config.
 * @param {Date} now Instant to test.
 * @returns {boolean} True when pushes should be withheld.
 */
export function inQuietHours(range, now) {
  if (!range.enabled) return false
  const parse = (/** @type {string} */ value) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    return match === null ? undefined : Number(match[1]) * 60 + Number(match[2])
  }
  const start = parse(range.start)
  const end = parse(range.end)
  if (start === undefined || end === undefined || start === end) return false
  const minute = now.getHours() * 60 + now.getMinutes()
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}