/**
 * DingTalk transports: `dws` (operator identity for reads, bot identity for
 * writes) and a group custom robot webhook (writes only).
 */
import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Fields `dws chat message list` returns; the same set the DingTalk source of dsh-superagent reads. */
const READ_FIELDS = 'messageId,createTime,sender,senderId,senderOpenDingTalkId,sendType,text'

/** One message read back from the target conversation. */
export class ChatMessage {
  /**
   * @param {{ id: string, at: string, text: string, senderIds: string[], kind: 'user' | 'robot' | 'ai' }} input Normalized fields.
   */
  constructor({ id, at, text, senderIds, kind }) {
    this.id = id
    this.at = at
    this.text = text
    this.senderIds = senderIds
    this.kind = kind
  }
}

/**
 * Format an instant as the `YYYY-MM-DD HH:mm:ss` Shanghai wall clock that `dws --time` accepts.
 * @param {Date} instant Instant to format.
 * @returns {string} The formatted time.
 */
export function dwsTime(instant) {
  const shifted = new Date(instant.getTime() + 8 * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Read a `dws` message time, which carries a Shanghai wall clock.
 * @param {unknown} value Raw `createTime`.
 * @returns {string} An ISO-8601 instant.
 */
export function parseDwsTime(value) {
  const text = String(value).trim().replace(' ', 'T')
  const time = Date.parse(/[+-]\d{2}:?\d{2}$|Z$/.test(text) ? text : `${text}+08:00`)
  return new Date(Number.isFinite(time) ? time : Date.now()).toISOString()
}

/**
 * Build the transport for one resolved config.
 * @param {import('./config.js').ResolvedConfig} config Normalized config.
 * @param {{ debug: Function, warn: Function }} logger Plugin logger.
 * @returns {{ send: (message: { title: string, text: string }) => Promise<void>, readNew: (cursor: string) => Promise<{ messages: ChatMessage[], nextCursor: string, stale: boolean }>, describe: () => string }} Transport.
 */
export function createTransport(config, logger) {
  const { push, read, target } = config
  const targetFlag = target.kind === 'user' ? '--users' : '--conversation-id'
  const readFlag = target.kind === 'user' ? '--user' : '--conversation-id'

  /**
   * Send one markdown message to the configured conversation.
   * @param {{ title: string, text: string }} message Message to send.
   * @returns {Promise<void>} Resolves when the transport accepted it.
   */
  async function send(message) {
    if (push.mode === 'webhook') return sendWebhook(message)
    const args = ['chat', 'message', 'send-by-bot', '--robot-code', push.robotCode,
      targetFlag, target.id, '--title', message.title.slice(0, 64), '--text', message.text]
    if (target.kind === 'group' && push.atUserIds.length > 0) {
      args.push('--at-user-ids', push.atUserIds.join(','))
    }
    await run(push.dws, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
  }

  /**
   * Send one markdown message through a group custom robot, signing when configured.
   * @param {{ title: string, text: string }} message Message to send.
   * @returns {Promise<void>} Resolves when DingTalk accepted it.
   */
  async function sendWebhook(message) {
    let address = push.webhookUrl
    if (push.signingKey !== '') {
      const timestamp = Date.now()
      const signature = encodeURIComponent(createHmac('sha256', push.signingKey)
        .update(`${timestamp}\n${push.signingKey}`)
        .digest('base64'))
      address += `${address.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${signature}`
    }
    const response = await fetch(address, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: message.title.slice(0, 64), text: message.text },
        ...push.atUserIds.length > 0 ? { at: { atUserIds: push.atUserIds } } : {},
      }),
      signal: AbortSignal.timeout(8_000),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`DingTalk webhook refused with HTTP ${response.status}: ${body.slice(0, 200)}`)
    if (/"errcode"\s*:\s*(?!0)\d+/.test(body)) throw new Error(`DingTalk webhook refused: ${body.slice(0, 200)}`)
  }

  /**
   * Read messages newer than the cursor.
   * @param {string} cursor Exclusive Shanghai-time lower bound.
   * @returns {Promise<{ messages: ChatMessage[], nextCursor: string, stale: boolean }>} Normalized messages and the next cursor.
   */
  async function readNew(cursor) {
    if (read.mode !== 'dws') return { messages: [], nextCursor: cursor, stale: false }
    const args = ['chat', 'message', 'list', readFlag, target.id, '--direction', 'newer',
      '--limit', '50', '--fields', READ_FIELDS, '-f', 'json', '--time', cursor]
    const { stdout } = await run(read.dws, args, { timeout: 25_000, maxBuffer: 8 * 1024 * 1024 })
    const page = JSON.parse(stdout)
    const raw = Array.isArray(page?.messages) ? page.messages : []
    const messages = []
    let newest = Date.parse(parseDwsTime(cursor))
    for (const item of raw) {
      if (typeof item?.messageId !== 'string' || typeof item?.createTime !== 'string') continue
      const at = parseDwsTime(item.createTime)
      const at_ms = Date.parse(at)
      if (Number.isFinite(at_ms) && at_ms > newest) newest = at_ms
      messages.push(new ChatMessage({
        id: item.messageId,
        at,
        text: typeof item.text === 'string' ? item.text : '',
        senderIds: [item.sender, item.senderId, item.senderOpenDingTalkId]
          .filter(value => typeof value === 'string' && value !== ''),
        kind: item.sendType === 'robot' ? 'robot' : typeof item.messageAiSendFlag === 'string' ? 'ai' : 'user',
      }))
    }
    const nextCursor = Number.isFinite(newest) ? dwsTime(new Date(newest)) : cursor
    void logger
    return { messages, nextCursor, stale: page?.hasMore === true }
  }

  /**
   * Describe the active transports for the load-time diagnostic.
   * @returns {string} One line.
   */
  function describe() {
    const out = `push=${push.mode}${push.mode === 'dws' ? `(robot ${push.robotCode})` : ''}`
    return `${out} read=${read.mode} target=${target.kind}:${target.id}`
  }

  return { send, readNew, describe }
}