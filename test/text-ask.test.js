import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assistantText, looksLikeAsk } from '../lib/text-ask.js'

const samples = {
  install: '要我直接装一套（dsh-notify-me + 侧边栏 chip）先跑起来，还是先把钉钉那条打通？',
  script: '要我现在就写一份「改前 commit → 改 → reindex → 验证召回」的可复用脚本吗？那个卡住的演示文件大概几分钟后就能清掉。',
  pending: '待确认 等你拍板',
  confirm: '这两处都改完了，请确认后我合入 release。',
  explicit: '以上都验证过了。需要我把这一版发到 npm 吗？',
}

test('an ask at the end of a turn is recognized', () => {
  for (const [name, text] of Object.entries(samples)) {
    const verdict = looksLikeAsk(text)
    assert.equal(verdict.ask, true, `${name} should ask`)
    assert.ok(verdict.summary.length > 0)
    assert.ok(verdict.summary.length <= 401)
  }
})

test('the forwarded sentence is the one carrying the ask', () => {
  const verdict = looksLikeAsk('都跑完了，4 组变异全红过。\n\n要我直接装一套先跑起来，还是先把钉钉那条打通？')
  assert.match(verdict.summary, /要我直接装一套/)
  assert.doesNotMatch(verdict.summary, /变异全红过/)
})

test('a report without an ask is not forwarded', () => {
  for (const text of [
    '完成：插件已装好、测试 33 个全过、仓库已推送。',
    '以上。',
    '谢谢。',
    '',
    '```\n要不要？\n```',
    'Nothing left to decide here, done.',
  ]) {
    assert.equal(looksLikeAsk(text).ask, false, JSON.stringify(text))
  }
})

test('english asks are recognized too', () => {
  assert.equal(looksLikeAsk('The branch is ready. Should I merge it into release?').ask, true)
  assert.equal(looksLikeAsk('All checks passed; awaiting your review.').ask, true)
  assert.equal(looksLikeAsk('Merged into master.').ask, false)
})

test('assistant text is collected from text blocks only', () => {
  const message = {
    content: [
      { type: 'text', text: '第一段' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
      { type: 'text', text: '第二段' },
    ],
  }
  assert.equal(assistantText(message), '第一段\n第二段')
  assert.equal(assistantText({}), '')
  assert.equal(assistantText(undefined), '')
})