/**
 * Message rendering and reply parsing.
 *
 * Everything here is pure: the bridge turns a request into text, and turns a
 * chat message back into an answer, without touching a Session or a transport.
 */

/** Outcome vocabulary the approval waterfall accepts. */
export const APPROVE = 'allowed-once'
export const REJECT = 'rejected'

const APPROVE_WORDS = ['批准', '同意', '允许', '通过', '放行', '可以', 'ok', 'okay', 'yes', 'y', 'allow', 'approve', '1']
const REJECT_WORDS = ['拒绝', '驳回', '不同意', '不批', '不行', 'no', 'n', 'deny', 'reject', '2']

/**
 * Build a short token a person can quote in a chat reply.
 * @param {'a' | 'q'} prefix Request kind, so a token names what it decides.
 * @param {Set<string>} taken Tokens already in flight.
 * @returns {string} A token unique among `taken`, three base-36 characters past the prefix.
 */
export function newToken(prefix, taken) {
  for (;;) {
    const body = Math.floor(Math.random() * 46_656).toString(36).padStart(3, '0')
    const token = `${prefix}${body}`
    if (!taken.has(token)) return token
  }
}

/**
 * Trim a session title to something readable in one chat line.
 * @param {string | undefined} title Session title, when the log has one.
 * @param {string} sessionId Session identity used when no title exists.
 * @returns {string} A short label.
 */
export function sessionLabel(title, sessionId) {
  const text = (title ?? '').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return sessionId.slice(0, 12)
  return text.length > 30 ? `${text.slice(0, 30)}…` : text
}

/**
 * Locale text for one localized display string, preferring Chinese.
 * @param {{ en: string, [locale: string]: string } | undefined} text Localized text.
 * @returns {string | undefined} The Chinese wording when present, else English.
 */
export function localized(text) {
  if (text === undefined) return undefined
  return text.zh ?? text['zh-CN'] ?? text.en
}

/**
 * Render one approval request as DingTalk markdown.
 * @param {{ token: string, label: string, toolName: string, reason?: string }} input Presentation input.
 * @returns {{ title: string, text: string }} Message title and markdown body.
 */
export function renderApproval({ token, label, toolName, reason }) {
  const lines = [
    `### 🔔 需要你批准 · ${label}`,
    `工具：${toolName}`,
  ]
  if (reason !== undefined && reason.trim() !== '') lines.push(`原因：${reason.trim()}`)
  lines.push('', `回复 \`#${token} 批准\` 或 \`#${token} 拒绝\``, '', '_也可在 DSH 工作台里处理，谁先答谁生效_')
  return { title: `需要你批准 · ${label}`.slice(0, 64), text: lines.join('\n') }
}

/**
 * Render one question request as DingTalk markdown.
 * @param {{ token: string, label: string, questions: readonly any[] }} input Presentation input.
 * @returns {{ title: string, text: string }} Message title and markdown body.
 */
export function renderQuestion({ token, label, questions }) {
  const lines = [`### ❓ 需要你决定 · ${label}`]
  const many = questions.length > 1
  questions.forEach((question, index) => {
    if (many) lines.push('', `**问题 ${index + 1}**`)
    lines.push(many ? question.question : `问题：${question.question}`)
    if (typeof question.detail === 'string' && question.detail.trim() !== '') {
      lines.push(...question.detail.trim().split('\n').slice(0, 12))
    }
    const options = Array.isArray(question.options) ? question.options : []
    options.forEach((option, position) => {
      const suffix = typeof option.description === 'string' && option.description.trim() !== ''
        ? ` — ${option.description.trim()}`
        : ''
      lines.push(`${position + 1}. ${option.label}${suffix}`)
    })
    if (question.multiSelect === true) lines.push('_可多选，例如 `1,3`_')
  })
  const hint = many
    ? `回复 \`#${token} 1; 2\`（每问一段，用 ; 分隔）`
    : questions[0]?.options?.length
      ? `回复 \`#${token} 1\`（或直接写答案）`
      : `回复 \`#${token} 你的答案\``
  lines.push('', hint, '', '_也可在 DSH 工作台里处理，谁先答谁生效_')
  return { title: `需要你决定 · ${label}`.slice(0, 64), text: lines.join('\n') }
}

/**
 * Render the confirmation sent after a reply settled a request.
 * @param {{ token: string, verdict: string }} input What was decided.
 * @returns {{ title: string, text: string }} Message title and body.
 */
export function renderAck({ token, verdict }) {
  return { title: '已收到你的决定', text: `✅ \`#${token}\` ${verdict}` }
}

/**
 * Render the notice sent when a reply names a token that is no longer pending.
 * @param {string} token The quoted token.
 * @returns {{ title: string, text: string }} Message title and body.
 */
export function renderStale(token) {
  return {
    title: '这条请求已失效',
    text: `\`#${token}\` 已经处理过或已取消，无需再回复。后续需要你决定时会再发新消息。`,
  }
}

/**
 * Strip leading `@mention` runs a group message may carry.
 * @param {string} text Raw message text.
 * @returns {string} Text without leading mentions.
 */
export function stripMentions(text) {
  return text.replace(/^(?:\s*@\S+\s*)+/u, '').trim()
}

/**
 * Read the request token a reply quotes.
 * @param {string} text Message text after mention stripping.
 * @returns {{ token?: string, rest: string }} The token, when present, and the remaining text.
 */
export function extractToken(text) {
  const match = /#([a-z][0-9a-z]{1,4})\b/i.exec(text)
  if (match === null) return { rest: text.trim() }
  const rest = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.trim()
  return { token: match[1].toLowerCase(), rest }
}

/**
 * Read an approve or reject instruction.
 * @param {string} text Candidate instruction.
 * @returns {'allowed-once' | 'rejected' | undefined} The outcome, or undefined when the text says neither.
 */
export function parseVerdict(text) {
  const word = text.trim().toLowerCase().replace(/[。.!！\s]+$/u, '')
  if (APPROVE_WORDS.includes(word)) return APPROVE
  if (REJECT_WORDS.includes(word)) return REJECT
  return undefined
}

/**
 * Read option numbers out of one answer segment.
 * @param {string} segment Answer text for one question.
 * @returns {number[] | undefined} 1-based option positions when the segment is only numbers.
 */
function numbers(segment) {
  const parts = segment.split(/[,，\s]+/u).filter(part => part.length > 0)
  if (parts.length === 0 || parts.length > 9) return undefined
  const parsed = parts.map(part => /^\d+$/.test(part) ? Number(part) : Number.NaN)
  return parsed.every(number => Number.isInteger(number) && number > 0) ? parsed : undefined
}

/**
 * Build one question's answer from a reply segment.
 * @param {any} question The question as the request declared it.
 * @param {string} segment The reply text for this question.
 * @returns {{ item?: { id: string, selected: string[], custom?: string }, error?: string }} The answer, or why the segment cannot answer.
 */
export function answerOne(question, segment) {
  const text = segment.trim()
  if (text === '') return { error: '缺少答案' }
  const options = Array.isArray(question.options) ? question.options : []
  const intent = question.intent

  const picked = numbers(text)
  if (picked !== undefined && options.length > 0) {
    if (picked.length > 1 && question.multiSelect !== true) {
      return { error: `问题「${question.question}」只能选一项` }
    }
    const labels = []
    for (const position of picked) {
      const option = options[position - 1]
      if (option === undefined) return { error: `问题「${question.question}」没有第 ${position} 个选项` }
      if (!labels.includes(option.label)) labels.push(option.label)
    }
    return { item: { id: question.id, selected: labels } }
  }

  const exact = options.find(option => option.label === text)
  if (exact !== undefined) return { item: { id: question.id, selected: [exact.label] } }

  // `批准` / `拒绝` also address the fixed approval and plan-review cards.
  if (intent !== undefined && (intent.kind === 'approval' || intent.kind === 'plan-review')) {
    const verdict = parseVerdict(text)
    if (verdict === APPROVE) return { item: { id: question.id, selected: [intent.approve] } }
    if (verdict === REJECT) {
      const decline = intent.kind === 'approval'
        ? intent.reject
        : options.find(option => option.label !== intent.approve)?.label
      if (decline !== undefined) return { item: { id: question.id, selected: [decline] } }
      return { error: '这张卡没有可用来拒绝的选项' }
    }
  }

  if (options.length > 0) {
    return { error: `问题「${question.question}」请回复选项序号或原文` }
  }
  return { item: { id: question.id, selected: [], custom: text } }
}

/**
 * Turn one reply into a user-questions answer.
 * @param {string} text Reply text after the token was removed.
 * @param {readonly any[]} questions The questions the request declared.
 * @returns {{ answer?: { answers: { id: string, selected: string[], custom?: string }[] }, error?: string }} The answer batch, or why the reply cannot settle it.
 */
export function parseAnswer(text, questions) {
  const segments = questions.length > 1
    ? text.split(/[;；]/u).map(segment => segment.trim())
    : [text.trim()]
  if (segments.length !== questions.length) {
    return { error: `这条请求有 ${questions.length} 个问题，请用 ; 分隔每个答案` }
  }
  const answers = []
  for (const [index, question] of questions.entries()) {
    const built = answerOne(question, segments[index] ?? '')
    if (built.error !== undefined) return { error: built.error }
    answers.push(built.item)
  }
  return { answer: { answers } }
}

/**
 * Describe what an answer settled, for the acknowledgement message.
 * @param {{ answers: { selected: string[], custom?: string }[] }} answer A settled batch.
 * @returns {string} One short line.
 */
export function describeAnswer(answer) {
  const parts = answer.answers.map(item => item.selected.length > 0 ? item.selected.join('/') : (item.custom ?? ''))
  return parts.join(' · ')
}