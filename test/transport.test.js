import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTransport, dwsTime, parseDwsTime } from '../lib/transport.js'
import { resolveConfig } from '../lib/config.js'

const logger = { debug() {}, info() {}, warn() {}, error() {} }

/** Install a fake `dws` that records sends and replays one list page. */
function fakeDws() {
  const dir = mkdtempSync(join(tmpdir(), 'decision-dingtalk-'))
  const log = join(dir, 'args.log')
  const reply = join(dir, 'reply.json')
  const script = join(dir, 'dws')
  writeFileSync(script, `#!/bin/sh
if [ "$1" = "chat" ] && [ "$3" = "list" ]; then
  cat "$FAKE_DWS_REPLY"
  exit 0
fi
if [ "$1" = "chat" ] && [ "$3" = "send-by-bot" ]; then
  printf '%s\\n' "$@" >> "$FAKE_DWS_LOG"
  exit 0
fi
echo "unexpected argv: $*" >&2
exit 2
`)
  chmodSync(script, 0o755)
  writeFileSync(log, '')
  writeFileSync(reply, '{"messages":[],"hasMore":false}')
  process.env.FAKE_DWS_LOG = log
  process.env.FAKE_DWS_REPLY = reply
  return { script, log, reply, read: () => readFileSync(log, 'utf8') }
}

test('a send reaches the bot of the configured conversation', async () => {
  const fake = fakeDws()
  const config = resolveConfig({ target: 'oc_42', push: { mode: 'dws', dws: fake.script, robotCode: 'ding7' }, read: { mode: 'none' } })
  const transport = createTransport(config, logger)
  await transport.send({ title: '需要你批准 · 测试', text: '正文' })
  const argv = fake.read().split('\n').filter(Boolean)
  assert.deepEqual(argv.slice(0, 6), ['chat', 'message', 'send-by-bot', '--robot-code', 'ding7', '--conversation-id'])
  assert.equal(argv[6], 'oc_42')
  assert.ok(argv.includes('--title'))
  assert.ok(argv.includes('需要你批准 · 测试'))
  assert.ok(argv.includes('--text'))
  assert.ok(argv.includes('正文'))
})

test('a private target sends with --users and reads with --user', async () => {
  const fake = fakeDws()
  const config = resolveConfig({ target: { kind: 'user', id: 'u_9' }, push: { mode: 'dws', dws: fake.script, robotCode: 'r' }, read: { mode: 'dws', dws: fake.script } })
  const transport = createTransport(config, logger)
  await transport.send({ title: 't', text: 'x' })
  const sent = fake.read().split('\n').filter(Boolean)
  assert.equal(sent[5], '--users')
  assert.equal(sent[6], 'u_9')

  const page = await transport.readNew('2026-11-27 12:00:00')
  assert.deepEqual(page.messages, [])
  assert.equal(page.nextCursor, '2026-11-27 12:00:00')
})

test('a read normalizes people, robots, and tool-sent messages, and advances the cursor', async () => {
  const fake = fakeDws()
  writeFileSync(fake.reply, JSON.stringify({
    hasMore: false,
    messages: [
      { messageId: 'm1', createTime: '2026-11-27 12:00:01', sender: '陈凯', senderId: 'staff1', sendType: 'user', text: '#a1b2 批准' },
      { messageId: 'm2', createTime: '2026-11-27 12:00:02', sender: '机器人', sendType: 'robot', text: '收到' },
      { messageId: 'm3', createTime: '2026-11-27 12:00:03', sender: '陈凯', senderId: 'staff1', sendType: 'user', messageAiSendFlag: 'DWS', text: '#a1b2 拒绝' },
      { messageId: 'm4', createTime: '2026-11-27 12:00:04', sender: '同事', senderId: 'staff2', sendType: 'user', text: '我也在' },
    ],
  }))
  const config = resolveConfig({ target: 'oc_42', push: { mode: 'dws', dws: fake.script, robotCode: 'r' }, read: { mode: 'dws', dws: fake.script } })
  const transport = createTransport(config, logger)
  const page = await transport.readNew('2026-11-27 12:00:00')
  assert.deepEqual(page.messages.map(message => message.kind), ['user', 'robot', 'ai', 'user'])
  assert.deepEqual(page.messages[0].senderIds, ['陈凯', 'staff1'])
  assert.equal(page.messages[0].text, '#a1b2 批准')
  assert.equal(page.nextCursor, '2026-11-27 12:00:04')
})

test('dws times survive the round trip through Shanghai wall clock', () => {
  const instant = new Date('2026-11-27T04:30:05Z')
  const formatted = dwsTime(instant)
  assert.equal(formatted, '2026-11-27 12:30:05')
  assert.equal(parseDwsTime(formatted), '2026-11-27T04:30:05.000Z')
  assert.equal(parseDwsTime('2026-11-27T12:30:05+08:00'), '2026-11-27T04:30:05.000Z')
})