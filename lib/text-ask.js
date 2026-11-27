/**
 * Recognize a decision asked in prose.
 *
 * Most confirmations are not `ask_user_question` cards: the assistant ends a
 * turn with "要不要我现在就……？" or "待确认，等你拍板" and the session simply
 * goes idle. There is no waterfall for that, so the shape has to be read out of
 * the final assistant text of a turn.
 */

/** Wording that asks the reader for a decision, checked on the closing sentences only. */
const ASK_PATTERNS = [
  /要不要/u, /需不需要/u, /需要我/u, /要我/u, /是否(?:要|需要|由|先)?/u, /可以吗/u, /行不行/u, /好不好/u,
  /请确认/u, /确认一下/u, /确认后/u, /待确认/u, /等你拍板/u, /你定/u, /由你/u, /你说一声/u, /回我一句/u,
  /shall i/iu, /should i/iu, /want me to/iu, /do you want/iu, /let me know/iu, /please confirm/iu,
  /awaiting your/iu, /your call/iu,
]

/** How much of the closing turn travels with the card, in characters. */
const CONTEXT_LIMIT = 1200

/** Lines that close a message without asking anything. */
const CLOSERS = /^(?:谢谢|多谢|完|完毕|以上|就这些|完毕。|done|that's it)[。.!！]?$/iu

/**
 * Strip fenced code blocks so a question mark inside code never counts.
 * @param {string} text Assistant text.
 * @returns {string} Text without fenced blocks.
 */
function withoutCode(text) {
  return text.replace(/```[\s\S]*?```/gu, '\n')
}

/**
 * Read the closing sentences of a message.
 * @param {string} text Assistant text.
 * @param {number} limit Longest kept tail, in characters.
 * @returns {string} The tail.
 */
function tail(text, limit = 600) {
  const trimmed = text.trim()
  return trimmed.length > limit ? trimmed.slice(-limit) : trimmed
}

/**
 * Decide whether a turn ended by asking the reader for a decision.
 * @param {string} text The turn's final assistant text.
 * @returns {{ ask: boolean, reason?: string, summary?: string }} Whether it asks, why, and the sentence to forward.
 */
export function looksLikeAsk(text) {
  const body = tail(withoutCode(text ?? ''))
  if (body === '') return { ask: false }

  const paragraphs = body.split(/\n{2,}/u).map(part => part.trim()).filter(part => part !== '')
  const closing = paragraphs.at(-1) ?? ''
  const lastLine = body.split('\n').map(line => line.trim()).filter(line => line !== '').at(-1) ?? ''

  // A trailing question mark is the clearest signal, on the last line or paragraph.
  const endsWithQuestion = /[?？]\s*$/u.test(body)
  const matched = ASK_PATTERNS.find(pattern => pattern.test(closing) || pattern.test(lastLine))
  if (!endsWithQuestion && matched === undefined) return { ask: false }
  if (CLOSERS.test(lastLine)) return { ask: false }

  const sentence = pickSentence(closing, matched)
  return {
    ask: true,
    reason: endsWithQuestion ? 'ends with a question' : `asks with ${String(matched)}`,
    summary: askSummary(sentence),
    // A decision needs the reasoning that led to the question, not just its last
    // sentence: keep the closing stretch of the turn so the reader can judge.
    context: tail(withoutCode(text ?? ''), CONTEXT_LIMIT).trim(),
  }
}

/**
 * Choose the sentence that carries the ask.
 * @param {string} paragraph Closing paragraph.
 * @param {RegExp | undefined} pattern The wording that matched, when the question mark did not.
 * @returns {string} One sentence.
 */
function pickSentence(paragraph, pattern) {
  const sentences = paragraph.split(/(?<=[。！？!?])/u).map(part => part.trim()).filter(part => part !== '')
  if (pattern !== undefined) {
    const hit = sentences.findLast(sentence => pattern.test(sentence))
    if (hit !== undefined) return hit
  }
  return sentences.at(-1) ?? paragraph
}

/**
 * Shorten a sentence to something readable inside one chat card.
 * @param {string} sentence The ask sentence.
 * @param {number} limit Longest kept length.
 * @returns {string} One line.
 */
export function askSummary(sentence, limit = 400) {
  const oneLine = sentence.replace(/\s*\n\s*/gu, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}

/**
 * Collect the text blocks of one assistant message.
 * @param {any} message The stored assistant message.
 * @returns {string} Its visible text.
 */
export function assistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}