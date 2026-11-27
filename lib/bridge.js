/**
 * The decision bridge.
 *
 * Two Cordis waterfalls — `approval/request` and `user-questions/request` —
 * carry every decision a Session is waiting on, whoever asked. The bridge
 * forwards each eligible one to DingTalk and settles it from the first answer:
 * the workstation (the ordinary chain, reached through `next()`) or the chat.
 *
 * The bridge registers before the ordinary chain (`prepend`), so the
 * workstation's own answerer stays reachable inside `next()` and a chat reply
 * can still win the race.
 */
import {
  describeAnswer, extractToken, newToken, parseAnswer, parseVerdict, renderAck, renderApproval,
  renderQuestion, renderStale, renderTextAsk, sessionLabel, stripMentions, localized,
} from './format.js'
import { assistantText, looksLikeAsk } from './text-ask.js'
import { inQuietHours } from './config.js'
import { dwsTime } from './transport.js'

/** A settled token stops answering notices after this window, so a chatty channel cannot flood. */
const STALE_NOTICE_WINDOW_MS = 60_000

/**
 * Create the bridge and install both waterfall listeners.
 * @param {object} input Wiring for one plugin load.
 * @param {any} input.ctx Plugin context.
 * @param {import('./config.js').ResolvedConfig} input.config Normalized config.
 * @param {{ send: Function, readNew: Function }} input.transport DingTalk transport.
 * @param {{ warn: Function, error: Function, debug: Function, info: Function }} input.logger Plugin logger.
 * @param {() => Date} [input.now] Clock, injectable for tests.
 * @returns {{ dispose: () => void, pending: () => number }} Bridge controls.
 */
export function createBridge({ ctx, config, transport, logger, now = () => new Date() }) {
  /** @type {Map<string, any>} */
  const pending = new Map()
  /** @type {Map<string, number>} */
  const staleNotified = new Map()
  const sessionQuery = ctx.get?.('sessionQuery')
  let cursor = dwsTime(now())
  let timer
  let disposed = false
  let reading = false
  let sendFailures = 0

  /**
   * Identity of the Session a request belongs to.
   * @param {any} agent The agent that asked.
   * @returns {string} Session id, or an empty string when unknown.
   */
  function sessionOf(agent) {
    return String(agent?.session?.id ?? agent?.id ?? '')
  }

  /**
   * Fold the Session's current title, tolerating a missing title service.
   * @param {any} agent The agent that asked.
   * @returns {Promise<string>} A short label for the message.
   */
  async function labelOf(agent) {
    const sessionId = sessionOf(agent)
    let title
    if (sessionQuery !== undefined) {
      try {
        const snapshot = await sessionQuery.readTitle(sessionId)
        title = snapshot?.title
      } catch (error) {
        logger.debug?.(`decision-dingtalk: title read failed for ${sessionId}: ${String(error)}`)
      }
    }
    return sessionLabel(title, sessionId)
  }

  /**
   * Whether this request belongs in DingTalk at all.
   * @param {any} agent The agent that asked.
   * @returns {boolean} True when the request may be forwarded.
   */
  function eligible(agent) {
    if (disposed) return false
    if (!config.behavior.includeSubagents && agent?.session?.header?.origin === 'subagent') return false
    if (inQuietHours(config.behavior.quietHours, now())) return false
    return pending.size < config.behavior.maxPending
  }

  /**
   * Register one pending request and start its expiry timer.
   * @param {'approval' | 'question'} kind Request family.
   * @param {any} request The waterfall request.
   * @param {any} agent The agent that asked.
   * @returns {any} The entry other helpers settle or drop.
   */
  function register(kind, request, agent, minutesOverride) {
    const token = newToken({ approval: 'a', question: 'q', text: 't' }[kind] ?? 'q', new Set(pending.keys()))
    const deferred = Promise.withResolvers()
    const entry = {
      token,
      kind,
      request,
      agent,
      sessionId: sessionOf(agent),
      delivered: false,
      promise: deferred.promise,
      resolve: deferred.resolve,
    }
    pending.set(token, entry)
    const minutes = minutesOverride ?? config.behavior.expireMinutes
    if (minutes > 0) {
      entry.timer = setTimeout(() => {
        if (pending.get(token) !== entry) return
        forget(entry)
        entry.resolve({ type: 'chat', value: { expired: true } })
        void say(`\`#${token}\` 已过期，请在 DSH 工作台处理。`, '决策已过期')
      }, minutes * 60_000)
      entry.timer.unref?.()
    }
    return entry
  }

  /**
   * Remove an entry from the table and stop its timer.
   * @param {any} entry The entry to forget.
   * @returns {void}
   */
  function forget(entry) {
    pending.delete(entry.token)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
  }

  /**
   * End the chat attempt for one entry so a later reply reads as stale.
   * @param {any} entry The entry to drop.
   * @param {string} reason Why the chat path is over.
   * @returns {void}
   */
  function drop(entry, reason) {
    if (pending.get(entry.token) !== entry) return
    forget(entry)
    entry.resolve({ type: 'chat', value: { dropped: true, reason } })
  }

  /**
   * Send one message, reporting rather than throwing: the decision path must not depend on delivery.
   * @param {string} text Markdown body.
   * @param {string} title Message title.
   * @returns {Promise<boolean>} Whether DingTalk accepted it.
   */
  async function say(text, title) {
    try {
      await transport.send({ title, text })
      sendFailures = 0
      return true
    } catch (error) {
      sendFailures += 1
      logger.warn(`decision-dingtalk: send failed (${sendFailures} in a row): ${String(error)}`)
      return false
    }
  }

  /**
   * Race the workstation chain against the chat for one approval.
   * @param {any} entry The pending entry.
   * @param {Promise<string>} gui The workstation chain.
   * @param {AbortSignal | undefined} signal The request's cancellation lifetime.
   * @returns {Promise<string>} The closed approval outcome.
   */
  async function decideApproval(entry, gui, signal) {
    const guiOutcome = gui.then(value => ({ type: 'gui', value }), error => ({ type: 'guiError', error }))
    let first = await Promise.race([entry.promise, guiOutcome, aborted(signal)])
    if (first.type === 'chat' && first.value?.expired === true) {
      // Expiry ends only the chat attempt; the workstation keeps the request.
      first = await Promise.race([guiOutcome, aborted(signal)])
    }
    if (first.type === 'gui') {
      drop(entry, 'answered in the workstation')
      return first.value
    }
    if (first.type === 'abort') {
      drop(entry, 'request cancelled')
      return 'cancelled'
    }
    if (first.type === 'chat') {
      if (first.value?.ok === true) return first.value.outcome
      return 'cancelled'
    }
    // The workstation cannot answer right now (no page open, or its channel failed).
    if (!entry.delivered) {
      drop(entry, 'not delivered to the chat')
      throw first.error
    }
    const second = await Promise.race([entry.promise, aborted(signal)])
    if (second.type === 'chat' && second.value?.ok === true) return second.value.outcome
    if (second.type === 'chat' && second.value?.expired === true) {
      const settled = await Promise.race([guiOutcome, aborted(signal)])
      return settled.type === 'gui' ? settled.value : 'cancelled'
    }
    drop(entry, 'request cancelled')
    return 'cancelled'
  }

  /**
   * Race the workstation chain against the chat for one question.
   * @param {any} entry The pending entry.
   * @param {Promise<any>} gui The workstation chain.
   * @param {AbortSignal | undefined} signal The request's cancellation lifetime.
   * @returns {Promise<any>} The answer batch.
   */
  async function decideQuestion(entry, gui, signal) {
    const guiOutcome = gui.then(value => ({ type: 'gui', value }), error => ({ type: 'guiError', error }))
    let first = await Promise.race([entry.promise, guiOutcome, aborted(signal)])
    if (first.type === 'chat' && first.value?.expired === true) {
      first = await Promise.race([guiOutcome, aborted(signal)])
    }
    if (first.type === 'gui') {
      drop(entry, 'answered in the workstation')
      return first.value
    }
    if (first.type === 'abort') {
      drop(entry, 'request cancelled')
      throw abortError(signal)
    }
    if (first.type === 'chat') {
      if (first.value?.ok === true) return first.value.answer
      throw abortError(signal)
    }
    if (!entry.delivered) {
      drop(entry, 'not delivered to the chat')
      throw first.error
    }
    const second = await Promise.race([entry.promise, aborted(signal)])
    if (second.type === 'chat' && second.value?.ok === true) return second.value.answer
    if (second.type === 'chat' && second.value?.expired === true) {
      const settled = await Promise.race([guiOutcome, aborted(signal)])
      if (settled.type === 'gui') return settled.value
    }
    drop(entry, 'request cancelled')
    throw abortError(signal)
  }

  /**
   * Forward one approval request.
   * @param {any} entry The pending entry.
   * @returns {Promise<void>} Resolves once delivery was attempted.
   */
  async function notifyApproval(entry) {
    const label = await labelOf(entry.agent)
    const message = renderApproval({
      token: entry.token,
      label,
      toolName: String(entry.request.toolName ?? 'tool'),
      reason: localized(entry.request.displayReason) ?? entry.request.reason,
    })
    entry.delivered = await say(message.text, message.title)
  }

  /**
   * Forward one question request.
   * @param {any} entry The pending entry.
   * @returns {Promise<void>} Resolves once delivery was attempted.
   */
  async function notifyQuestion(entry) {
    const label = await labelOf(entry.agent)
    const message = renderQuestion({ token: entry.token, label, questions: entry.request.questions ?? [] })
    entry.delivered = await say(message.text, message.title)
  }

  /**
   * Turn one reply into a settled request.
   * @param {any} message One normalized chat message.
   * @returns {Promise<void>} Resolves after any acknowledgement was attempted.
   */
  async function ingest(message) {
    if (message.kind !== 'user') return
    const allowed = config.read.allowSenders
    if (allowed.length > 0 && !message.senderIds.some(id => allowed.includes(id))) return
    const text = stripMentions(message.text)
    if (text === '') return
    const { token, rest } = extractToken(text)
    let entry = token === undefined ? undefined : pending.get(token)
    if (token !== undefined && entry === undefined) {
      const last = staleNotified.get(token) ?? 0
      if (now().getTime() - last > STALE_NOTICE_WINDOW_MS) {
        staleNotified.set(token, now().getTime())
        const notice = renderStale(token)
        void say(notice.text, notice.title)
      }
      return
    }
    if (token === undefined) {
      if (config.behavior.requireToken || pending.size !== 1) return
      entry = [...pending.values()][0]
    }
    if (entry.kind === 'text') {
      const reply = rest.trim()
      if (reply === '') {
        void say(`\`#${entry.token}\` 请把答复写在 token 后面。`, '回复格式未识别')
        return
      }
      forget(entry)
      entry.resolve({ type: 'chat', value: { ok: true } })
      const sent = await sendToSession(entry, reply)
      const ack = sent.ok
        ? renderAck({ token: entry.token, verdict: '已发进会话' })
        : { title: '没能送达', text: `\`#${entry.token}\` ${sent.reason ?? '未知原因'}` }
      void say(ack.text, ack.title)
      return
    }
    if (entry.kind === 'approval') {
      const verdict = parseVerdict(rest)
      if (verdict === undefined) {
        void say(`\`#${entry.token}\` 请回复「批准」或「拒绝」。`, '回复格式未识别')
        return
      }
      forget(entry)
      entry.resolve({ type: 'chat', value: { ok: true, outcome: verdict } })
      const ack = renderAck({ token: entry.token, verdict: verdict === 'allowed-once' ? '已批准' : '已拒绝' })
      void say(ack.text, ack.title)
      return
    }
    const parsed = parseAnswer(rest, entry.request.questions ?? [])
    if (parsed.error !== undefined) {
      void say(`\`#${entry.token}\` ${parsed.error}`, '回复格式未识别')
      return
    }
    forget(entry)
    entry.resolve({ type: 'chat', value: { ok: true, answer: parsed.answer } })
    const ack = renderAck({ token: entry.token, verdict: describeAnswer(parsed.answer) })
    void say(ack.text, ack.title)
  }

  /**
   * Read one page of chat messages and feed them to the bridge.
   * @returns {Promise<void>} Resolves after the page was handled.
   */
  async function poll() {
    if (reading || disposed) return
    reading = true
    try {
      const page = await transport.readNew(cursor)
      cursor = page.nextCursor ?? cursor
      for (const message of page.messages) await ingest(message)
    } catch (error) {
      logger.debug?.(`decision-dingtalk: read failed: ${String(error)}`)
    } finally {
      reading = false
      schedule()
    }
  }

  /**
   * Queue the next poll.
   * @returns {void}
   */
  function schedule() {
    if (disposed || config.read.mode !== 'dws') return
    timer = setTimeout(() => { void poll() }, config.read.pollSeconds * 1000)
    timer.unref?.()
  }

  /** Last assistant prose per Session, so a turn can be judged the moment it ends. */
  const lastAssistant = new Map()
  /** Message seqs already forwarded, so one question is never pushed twice. */
  const forwarded = new Set()

  /**
   * Whether any decision is already pending for one Session.
   * @param {string} sessionId Session identity.
   * @returns {boolean} True when the chat already holds a card for it.
   */
  function waitingOn(sessionId) {
    for (const entry of pending.values()) if (entry.sessionId === sessionId) return true
    return false
  }

  /**
   * Deliver one chat reply into its Session as an ordinary user message.
   * @param {any} entry The text decision.
   * @param {string} text The reader's answer.
   * @returns {Promise<{ ok: boolean, reason?: string }>} Whether the Session accepted it.
   */
  async function sendToSession(entry, text) {
    const controller = ctx.get?.('sessionController')
    if (controller === undefined || typeof controller.prompt !== 'function') {
      return { ok: false, reason: '宿主没有 sessionController，无法把答复写回会话' }
    }
    try {
      await controller.prompt({
        requestId: globalThis.crypto.randomUUID(),
        sessionId: entry.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(15_000))
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `会话拒绝了这条消息：${String(error)}` }
    }
  }

  /**
   * Forward one decision that was asked in prose.
   * @param {any} entry The pending text decision.
   * @returns {Promise<void>} Resolves once delivery was attempted.
   */
  async function notifyText(entry) {
    const label = await labelOf(entry.agent)
    const message = renderTextAsk({ token: entry.token, label, summary: entry.request.summary })
    entry.delivered = await say(message.text, message.title)
  }

  /**
   * Watch committed Session events for prose decisions.
   * @param {any} session The Session that committed the event.
   * @param {any} event The committed event.
   * @returns {void}
   */
  function onSessionEvent(session, event) {
    if (event.type === 'assistant/message') {
      lastAssistant.set(session.id, { seq: event.seq, text: assistantText(event.data?.message) })
      return
    }
    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind
      if (kind !== 'user' && kind !== 'user-question-reply') return
      for (const entry of [...pending.values()]) {
        if (entry.kind === 'text' && entry.sessionId === session.id) drop(entry, 'answered in the workstation')
      }
      return
    }
    if (event.type !== 'turn/end') return
    if (config.behavior.textQuestions !== true) return

    const last = lastAssistant.get(session.id)
    if (last === undefined || forwarded.has(`${session.id}:${last.seq}`)) return
    const agent = { session }
    if (!eligible(agent) || waitingOn(session.id)) return
    const verdict = looksLikeAsk(last.text)
    if (!verdict.ask) return

    forwarded.add(`${session.id}:${last.seq}`)
    const entry = register('text', { summary: verdict.summary, reason: verdict.reason, seq: last.seq }, agent,
      config.behavior.textQuestionMinutes)
    void notifyText(entry)
  }

  /**
   * Handle one approval request.
   * @param {any} request The approval request.
   * @param {() => Promise<any>} next The ordinary chain.
   * @returns {Promise<any>} The outcome this chain returns.
   */
  function onApproval(request, next) {
    const agent = request.agent
    if (!eligible(agent)) return next()
    const gui = next()
    const entry = register('approval', request, agent)
    void notifyApproval(entry)
    if (!config.behavior.answerInChat) {
      forget(entry)
      entry.resolve({ type: 'chat', value: { dropped: true, reason: 'notify only' } })
      return gui
    }
    return decideApproval(entry, gui, request.signal)
  }

  /**
   * Handle one question request.
   * @param {any} request The questions request.
   * @param {() => Promise<any>} next The ordinary chain.
   * @returns {Promise<any>} The answer this chain returns.
   */
  function onQuestion(request, next) {
    const agent = request.agent
    if (!eligible(agent)) return next()
    const gui = next()
    const entry = register('question', request, agent)
    void notifyQuestion(entry)
    if (!config.behavior.answerInChat) {
      forget(entry)
      entry.resolve({ type: 'chat', value: { dropped: true, reason: 'notify only' } })
      return gui
    }
    return decideQuestion(entry, gui, request.signal)
  }

  // `global` keeps both listeners on every Agent scope; `prepend` puts the
  // bridge ahead of the workstation's forwarded-event forwarder.
  ctx.on('approval/request', onApproval, { prepend: true, global: true })
  ctx.on('user-questions/request', onQuestion, { prepend: true, global: true })
  ctx.on('session/event', onSessionEvent, { global: true })
  if (config.read.mode === 'dws') {
    timer = setTimeout(() => { void poll() }, 2_000)
    timer.unref?.()
  }

  return {
    /** Number of requests still waiting on the chat, for diagnostics and tests. */
    pending: () => pending.size,
    /** Handle one chat message; the poller calls this for every line it reads. */
    feed: message => ingest(message),
    /** Release listeners, timers, and unanswered entries. */
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      for (const entry of [...pending.values()]) {
        forget(entry)
        entry.resolve({ type: 'chat', value: { dropped: true, reason: 'plugin unloaded' } })
      }
      staleNotified.clear()
    },
  }
}

/**
 * Resolve when the request's cancellation lifetime ends.
 * @param {AbortSignal | undefined} signal The request signal.
 * @returns {Promise<{ type: 'abort' }>} Resolves on abort, never otherwise.
 */
function aborted(signal) {
  return new Promise((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) {
      resolve({ type: 'abort' })
      return
    }
    signal.addEventListener('abort', () => resolve({ type: 'abort' }), { once: true })
  })
}

/**
 * Read the rejection a cancelled question should raise.
 * @param {AbortSignal | undefined} signal The request signal.
 * @returns {Error} The abort reason, or a stand-in.
 */
function abortError(signal) {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new Error('决策桥：请求在答复前被取消')
}