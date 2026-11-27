import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBridge } from '../lib/bridge.js'
import { resolveConfig } from '../lib/config.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

/** Wait until a predicate holds, failing the test after a second. */
async function until(predicate) {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const agent = { session: { id: 'sess-1', header: {} } }
const subagent = { session: { id: 'sess-2', header: { origin: 'subagent' } } }
const never = () => new Promise(() => {})

/** Install a bridge over recording fakes and hand back its two listeners. */
function harness(overrides = {}) {
  const sends = []
  const listeners = new Map()
  const ctx = {
    get: () => undefined,
    on(name, listener, options) {
      listeners.set(name, { listener, options })
      return () => {}
    },
  }
  const transport = {
    async send(message) { sends.push(message) },
    async readNew(cursor) { return { messages: [], nextCursor: cursor } },
  }
  const config = resolveConfig({
    target: 'oc_test',
    push: { mode: 'dws', robotCode: 'robot-1' },
    read: { mode: 'none' },
    ...overrides,
  })
  const bridge = createBridge({ ctx, config, transport, logger, now: () => new Date('2026-11-27T12:00:00+08:00') })
  return {
    bridge,
    sends,
    approval: listeners.get('approval/request'),
    question: listeners.get('user-questions/request'),
    tokenOf: (index) => /#([a-z][0-9a-z]{1,4})\b/.exec(sends[index].text)[1],
  }
}

test('both listeners claim their slot ahead of the ordinary chain and stay global', () => {
  const h = harness()
  assert.equal(h.approval.options.prepend, true)
  assert.equal(h.approval.options.global, true)
  assert.equal(h.question.options.prepend, true)
  assert.equal(h.question.options.global, true)
  h.bridge.dispose()
})

test('a chat reply settles an approval while the workstation stays silent', async () => {
  const h = harness()
  const decided = h.approval.listener({ agent, toolName: 'bash', reason: 'rm -rf build' }, never)
  await until(() => h.sends.length === 1)
  assert.match(h.sends[0].text, /需要你批准/)
  assert.match(h.sends[0].text, /rm -rf build/)
  const token = h.tokenOf(0)

  await h.bridge.feed({ kind: 'user', text: `@机器人 #${token} 批准`, senderIds: ['me'] })
  assert.equal(await decided, 'allowed-once')
  assert.equal(h.bridge.pending(), 0)
  await until(() => h.sends.length === 2)
  assert.match(h.sends[1].text, /已批准/)
  h.bridge.dispose()
})

test('the workstation answer wins when it arrives first, and a late reply reads as stale', async () => {
  const h = harness()
  const decided = h.approval.listener({ agent, toolName: 'bash' }, async () => 'rejected')
  assert.equal(await decided, 'rejected')
  await until(() => h.sends.length === 1)
  const token = h.tokenOf(0)
  assert.equal(h.bridge.pending(), 0)

  await h.bridge.feed({ kind: 'user', text: `#${token} 批准`, senderIds: ['me'] })
  await until(() => h.sends.length === 2)
  assert.match(`${h.sends[1].title} ${h.sends[1].text}`, /已失效/)
  h.bridge.dispose()
})

test('a cancelled request releases its token', async () => {
  const h = harness()
  const controller = new AbortController()
  const decided = h.approval.listener({ agent, toolName: 'bash', signal: controller.signal }, never)
  await until(() => h.sends.length === 1)
  controller.abort()
  assert.equal(await decided, 'cancelled')
  assert.equal(h.bridge.pending(), 0)
  h.bridge.dispose()
})

test('a workstation with no answerer still waits for the chat', async () => {
  const h = harness()
  const decided = h.approval.listener({ agent, toolName: 'bash' }, () => Promise.reject(new Error('no answerer')))
  await until(() => h.sends.length === 1)
  await h.bridge.feed({ kind: 'user', text: `#${h.tokenOf(0)} 拒绝`, senderIds: ['me'] })
  assert.equal(await decided, 'rejected')
  h.bridge.dispose()
})

test('a numbered reply answers a question with the declared option label', async () => {
  const h = harness()
  const questions = [{ id: 'first', question: '先上哪个环境？', options: [{ label: '灰度' }, { label: '全量' }] }]
  const answered = h.question.listener({ agent, questions }, never)
  await until(() => h.sends.length === 1)
  await h.bridge.feed({ kind: 'user', text: `#${h.tokenOf(0)} 2`, senderIds: ['me'] })
  assert.deepEqual(await answered, { answers: [{ id: 'first', selected: ['全量'] }] })
  assert.equal(h.bridge.pending(), 0)
  h.bridge.dispose()
})

test('an unusable reply asks again and keeps the request pending', async () => {
  const h = harness()
  const questions = [{ id: 'first', question: '先上哪个环境？', options: [{ label: '灰度' }, { label: '全量' }] }]
  const answered = h.question.listener({ agent, questions }, never)
  await until(() => h.sends.length === 1)
  await h.bridge.feed({ kind: 'user', text: `#${h.tokenOf(0)} 9`, senderIds: ['me'] })
  await until(() => h.sends.length === 2)
  assert.match(h.sends[1].text, /没有第 9 个选项/)
  assert.equal(h.bridge.pending(), 1)
  await h.bridge.feed({ kind: 'user', text: `#${h.tokenOf(0)} 灰度`, senderIds: ['me'] })
  assert.deepEqual(await answered, { answers: [{ id: 'first', selected: ['灰度'] }] })
  h.bridge.dispose()
})

test('a subagent request stays in the workstation', async () => {
  const h = harness()
  let delegated = 0
  const outcome = await h.approval.listener({ agent: subagent, toolName: 'bash' }, async () => {
    delegated += 1
    return 'unavailable'
  })
  assert.equal(outcome, 'unavailable')
  assert.equal(delegated, 1)
  assert.equal(h.sends.length, 0)
  h.bridge.dispose()
})

test('includeSubagents forwards a subagent request too', async () => {
  const h = harness({ behavior: { includeSubagents: true } })
  const decided = h.approval.listener({ agent: subagent, toolName: 'bash' }, never)
  await until(() => h.sends.length === 1)
  await h.bridge.feed({ kind: 'user', text: `#${h.tokenOf(0)} 批准`, senderIds: ['me'] })
  assert.equal(await decided, 'allowed-once')
  h.bridge.dispose()
})

test('notify-only forwards the card and leaves the decision to the workstation', async () => {
  const h = harness({ behavior: { answerInChat: false } })
  const outcome = await h.approval.listener({ agent, toolName: 'bash' }, async () => 'allowed-once')
  assert.equal(outcome, 'allowed-once')
  await until(() => h.sends.length === 1)
  assert.equal(h.bridge.pending(), 0)
  h.bridge.dispose()
})

test('a bare reply is accepted only when tokens are optional and one request waits', async () => {
  const h = harness({ behavior: { requireToken: false } })
  const decided = h.approval.listener({ agent, toolName: 'bash' }, never)
  await until(() => h.sends.length === 1)
  await h.bridge.feed({ kind: 'user', text: '批准', senderIds: ['me'] })
  assert.equal(await decided, 'allowed-once')
  h.bridge.dispose()
})

test('a robot or tool message never settles anything', async () => {
  const h = harness()
  const decided = h.approval.listener({ agent, toolName: 'bash' }, never)
  await until(() => h.sends.length === 1)
  const token = h.tokenOf(0)
  await h.bridge.feed({ kind: 'robot', text: `#${token} 批准`, senderIds: ['robot'] })
  await h.bridge.feed({ kind: 'ai', text: `#${token} 批准`, senderIds: ['me'] })
  assert.equal(h.bridge.pending(), 1)
  await h.bridge.feed({ kind: 'user', text: `#${token} 批准`, senderIds: ['me'] })
  assert.equal(await decided, 'allowed-once')
  h.bridge.dispose()
})

test('an allowlist keeps a stranger from answering', async () => {
  const h = harness({ read: { mode: 'none', allowSenders: ['boss'] } })
  const decided = h.approval.listener({ agent, toolName: 'bash' }, never)
  await until(() => h.sends.length === 1)
  const token = h.tokenOf(0)
  await h.bridge.feed({ kind: 'user', text: `#${token} 批准`, senderIds: ['stranger'] })
  assert.equal(h.bridge.pending(), 1)
  await h.bridge.feed({ kind: 'user', text: `#${token} 批准`, senderIds: ['boss'] })
  assert.equal(await decided, 'allowed-once')
  h.bridge.dispose()
})

test('quiet hours keep a request in the workstation', async () => {
  const sends = []
  const listeners = new Map()
  const ctx = { get: () => undefined, on(name, listener) { listeners.set(name, listener); return () => {} } }
  const config = resolveConfig({
    target: 'oc_test',
    push: { robotCode: 'r' },
    read: { mode: 'none' },
    behavior: { quietHours: { enabled: true, start: '11:00', end: '13:00' } },
  })
  const bridge = createBridge({
    ctx,
    config,
    transport: { async send(message) { sends.push(message) }, async readNew(cursor) { return { messages: [], nextCursor: cursor } } },
    logger,
    now: () => new Date('2026-11-27T12:00:00+08:00'),
  })
  const decided = listeners.get('approval/request')({ agent, toolName: 'bash' }, never)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(sends.length, 0)
  assert.equal(bridge.pending(), 0)
  void decided
  bridge.dispose()
})

test('dispose releases every waiting entry', async () => {
  const h = harness()
  const decided = h.approval.listener({ agent, toolName: 'bash' }, never)
  await until(() => h.sends.length === 1)
  h.bridge.dispose()
  assert.equal(h.bridge.pending(), 0)
  assert.equal(await decided, 'cancelled')
})