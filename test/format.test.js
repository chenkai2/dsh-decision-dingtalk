import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  answerOne, describeAnswer, extractToken, newToken, parseAnswer, parseVerdict, renderApproval,
  renderQuestion, renderTextAsk, sessionLabel, stripMentions,
} from '../lib/format.js'
import { inQuietHours, resolveConfig } from '../lib/config.js'

test('a token is unique among the tokens already in flight', () => {
  const taken = new Set()
  for (let index = 0; index < 200; index += 1) {
    const token = newToken('a', taken)
    assert.match(token, /^a[0-9a-z]{3}$/)
    assert.equal(taken.has(token), false)
    taken.add(token)
  }
})

test('a reply token is read wherever it sits, and mentions are stripped first', () => {
  assert.deepEqual(extractToken('#a7k2 批准'), { token: 'a7k2', rest: '批准' })
  assert.deepEqual(extractToken('批准 #a7k2'), { token: 'a7k2', rest: '批准' })
  assert.deepEqual(extractToken('没有令牌'), { rest: '没有令牌' })
  assert.equal(stripMentions('@陈凯 @机器人 #a7k2 批准'), '#a7k2 批准')
  assert.equal(stripMentions('批准'), '批准')
})

test('verdict words map onto the closed approval outcome', () => {
  for (const word of ['批准', '同意', 'OK', 'yes', '1', '允许。']) assert.equal(parseVerdict(word), 'allowed-once')
  for (const word of ['拒绝', 'No', 'reject', '2', '驳回！']) assert.equal(parseVerdict(word), 'rejected')
  assert.equal(parseVerdict('再说吧'), undefined)
})

test('a numbered answer selects the declared option, and a label answers directly', () => {
  const question = { id: 'q1', question: '先上哪个？', options: [{ label: '灰度' }, { label: '全量' }] }
  assert.deepEqual(answerOne(question, '2'), { item: { id: 'q1', selected: ['全量'] } })
  assert.deepEqual(answerOne(question, '灰度'), { item: { id: 'q1', selected: ['灰度'] } })
  assert.match(answerOne(question, '7').error, /没有第 7 个选项/)
  assert.match(answerOne(question, '1 2').error, /只能选一项/)
  assert.match(answerOne(question, '随便').error, /请回复选项序号/)
})

test('a multi-select question accepts several positions', () => {
  const question = { id: 'q2', question: '要哪些？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }
  assert.deepEqual(answerOne(question, '1,3'), { item: { id: 'q2', selected: ['A', 'C'] } })
  assert.deepEqual(answerOne(question, '1，3'), { item: { id: 'q2', selected: ['A', 'C'] } })
})

test('an approval card answers 批准 / 拒绝 with its declared labels', () => {
  const question = {
    id: 'q3',
    question: '允许 git push？',
    options: [{ label: '允许一次' }, { label: '拒绝' }, { label: '总是允许' }],
    intent: { kind: 'approval', approve: '允许一次', reject: '拒绝' },
  }
  assert.deepEqual(answerOne(question, '批准'), { item: { id: 'q3', selected: ['允许一次'] } })
  assert.deepEqual(answerOne(question, '拒绝'), { item: { id: 'q3', selected: ['拒绝'] } })
})

test('a plan review declines with the option that is not the approve label', () => {
  const question = {
    id: 'q4',
    question: '按这份计划执行？',
    options: [{ label: '开始执行' }, { label: '继续讨论' }],
    intent: { kind: 'plan-review', approve: '开始执行' },
  }
  assert.deepEqual(answerOne(question, '批准'), { item: { id: 'q4', selected: ['开始执行'] } })
  assert.deepEqual(answerOne(question, '拒绝'), { item: { id: 'q4', selected: ['继续讨论'] } })
})

test('a question without options takes the reply as free text', () => {
  const question = { id: 'q5', question: '部署到哪台机器？' }
  assert.deepEqual(answerOne(question, 'wbds-42'), { item: { id: 'q5', selected: [], custom: 'wbds-42' } })
  assert.match(answerOne(question, '   ').error, /缺少答案/)
})

test('a multi-question card needs one segment per question', () => {
  const questions = [
    { id: 'a', question: '先做什么？', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'b', question: '备注？' },
  ]
  assert.deepEqual(parseAnswer('1; 今天上线', questions), {
    answer: { answers: [{ id: 'a', selected: ['A'] }, { id: 'b', selected: [], custom: '今天上线' }] },
  })
  assert.match(parseAnswer('1', questions).error, /2 个问题/)
})

test('messages carry the token, the tool or question, and the reply grammar', () => {
  const approval = renderApproval({ token: 'a1b2', label: '热搜轻参与', toolName: 'bash', reason: 'rm -rf' })
  assert.match(approval.text, /#a1b2 批准/)
  assert.match(approval.text, /热搜轻参与/)
  assert.match(approval.text, /rm -rf/)
  assert.ok(Buffer.byteLength(approval.title, 'utf8') <= 64)

  const question = renderQuestion({
    token: 'q9z8',
    label: '热搜轻参与',
    questions: [{ id: 'x', question: '先上哪个？', options: [{ label: '灰度', description: '先给一台' }, { label: '全量' }] }],
  })
  assert.match(question.text, /1\. 灰度 — 先给一台/)
  assert.match(question.text, /#q9z8 1/)
})

test('a long session title is short enough for one chat line', () => {
  assert.equal(sessionLabel(undefined, 'abcdef1234567890'), 'abcdef123456')
  assert.equal(sessionLabel('短标题', 'x'), '短标题')
  assert.equal(sessionLabel('x'.repeat(50), 'x').length, 31)
})

test('an answer summary names what was chosen', () => {
  assert.equal(describeAnswer({ answers: [{ id: 'a', selected: ['灰度'] }, { id: 'b', selected: [], custom: '备注' }] }), '灰度 · 备注')
})

test('quiet hours cover a window across midnight', () => {
  const range = { enabled: true, start: '23:00', end: '08:00' }
  // Quiet hours are read on the Host's own clock, so build these instants locally.
  assert.equal(inQuietHours(range, new Date(2026, 10, 27, 23, 30)), true)
  assert.equal(inQuietHours(range, new Date(2026, 10, 27, 3, 0)), true)
  assert.equal(inQuietHours(range, new Date(2026, 10, 27, 12, 0)), false)
  assert.equal(inQuietHours({ ...range, enabled: false }, new Date(2026, 10, 27, 23, 30)), false)
})

test('config problems are reported instead of thrown, and notify-only stops polling', () => {
  const empty = resolveConfig({})
  assert.equal(empty.problems.length, 2)
  assert.match(empty.problems.join(' '), /target\.id/)
  assert.match(empty.problems.join(' '), /robotCode/)

  const ready = resolveConfig({ target: 'oc_1', push: { mode: 'dws', robotCode: 'ding1' } })
  assert.deepEqual(ready.problems, [])
  assert.deepEqual(ready.target, { kind: 'group', id: 'oc_1' })
  assert.equal(ready.read.mode, 'dws')

  const notifyOnly = resolveConfig({ target: { kind: 'user', id: 'u1' }, push: { robotCode: 'r' }, behavior: { answerInChat: false }, read: { mode: 'dws' } })
  assert.equal(notifyOnly.read.mode, 'none')
  assert.equal(notifyOnly.target.kind, 'user')

  const clamped = resolveConfig({ target: 'x', push: { robotCode: 'r' }, read: { pollSeconds: 0 }, behavior: { maxPending: 999 } })
  assert.equal(clamped.read.pollSeconds, 5)
  assert.equal(clamped.behavior.maxPending, 50)
})
test('a prose card carries the context, the ask and the reply grammar', () => {
  const card = renderTextAsk({
    token: 't7kd',
    label: 'superagent-eval',
    summary: '要我按这个修法派一个小 PR？',
    context: '重启后实测：走的是评估路径。\n\ndeferred 里那两张工单已结束却仍被当作归属。',
    where: '/Users/chenkai2/data1/www/htdocs/dsh-superagent-dingtalk',
  })
  assert.match(card.text, /等你回一句 · superagent-eval/)
  assert.match(card.text, /工作目录：\/Users\/chenkai2/)
  assert.match(card.text, /走的是评估路径/)
  assert.match(card.text, /\*\*要你决定\*\*：要我按这个修法派一个小 PR？/)
  assert.match(card.text, /#t7kd 你的答复/)
  assert.ok(card.title.length <= 64)
})
