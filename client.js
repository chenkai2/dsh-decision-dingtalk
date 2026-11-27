/**
 * Client half of @chenkai114/dsh-decision-dingtalk: the settings section.
 *
 * The page reads and writes through the plugin's own same-origin routes, so a
 * plain-JavaScript bundle needs no Remote namespace of its own.
 */
window.__ModuleLoader__.load({
  id: '@chenkai114/dsh-decision-dingtalk',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/decision-dingtalk'

    const S = {
      page: { display: 'grid', gap: 18, color: 'var(--dsw-alias-label-primary)' },
      section: { display: 'grid', gap: 10 },
      title: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: 0 },
      hint: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', margin: 0 },
      row: { display: 'grid', gap: 6 },
      label: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 13, borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)', outline: 'none',
      },
      actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      button: {
        padding: '6px 12px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      primary: { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
      check: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 },
      state: { fontSize: 12, lineHeight: 1.5 },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      bad: { color: 'var(--dsw-alias-state-error-primary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
      kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: 12 },
      key: { color: 'var(--dsw-alias-label-secondary)' },
      value: { color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' },
    }

    /** Fetch one route and read its JSON body. */
    async function call(path, init) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    /** One labelled form row. */
    function Row({ label, hint, children }) {
      return h('div', { style: S.row },
        h('label', { style: S.label }, label),
        children,
        hint === undefined ? null : h('p', { style: S.hint }, hint))
    }

    /** One checkbox row. */
    function Check({ label, checked, onChange }) {
      return h('label', { style: S.check },
        h('input', { type: 'checkbox', checked, onChange: event => onChange(event.target.checked) }),
        h('span', null, label))
    }

    /** The settings page. */
    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [options, setOptions] = React.useState(null)
      const [probe, setProbe] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        // The config read is in-process; the dws check shells out, so it arrives later.
        const next = await call('/config')
        setStatus(next)
        setForm({
          kind: next.config.target.kind,
          targetId: next.config.target.id,
          robotCode: next.config.push.robotCode,
          pollSeconds: next.config.read.pollSeconds,
          allowSenders: next.config.read.allowSenders.join(', '),
          answerInChat: next.config.behavior.answerInChat,
          requireToken: next.config.behavior.requireToken,
          textQuestions: next.config.behavior.textQuestions,
          completionNotify: next.config.behavior.completionNotify,
          completionMinSeconds: next.config.behavior.completionMinSeconds,
          includeSubagents: next.config.behavior.includeSubagents,
        })
      }, [])

      React.useEffect(() => {
        load().catch(error => setNote({ ok: false, text: `读取失败：${String(error.message ?? error)}` }))
        call('/probe').then(setProbe).catch(error => setProbe({ error: String(error.message ?? error) }))
        call('/options').then(setOptions).catch(() => setOptions({ groups: [], bots: [] }))
      }, [load])

      if (form === null) {
        return h('div', { style: S.page },
          h('p', { style: { ...S.hint, ...(note === null ? {} : S.bad) } }, note === null ? '正在读取配置…' : note.text),
          note === null ? null : h('div', { style: S.actions },
            h('button', { style: S.button, onClick: () => {
              setNote(null)
              load().catch(error => setNote({ ok: false, text: `读取失败：${String(error.message ?? error)}` }))
            } }, '重试')),
          note === null ? null : h('p', { style: S.hint },
            '如果一直是 404，说明插件的路由没挂上——重启 dsh web 后再试，并把这段报错发我。'))
      }

      const patch = field => value => setForm(current => ({ ...current, [field]: value }))
      const groups = options?.groups ?? []
      const bots = options?.bots ?? []
      const knownGroup = groups.some(group => group.id === form.targetId)

      const save = async () => {
        setBusy(true)
        setNote(null)
        try {
          await call('/config', {
            method: 'POST',
            body: JSON.stringify({
              enabled: true,
              target: { kind: form.kind, id: form.targetId },
              push: { robotCode: form.robotCode },
              read: {
                pollSeconds: Number(form.pollSeconds),
                allowSenders: form.allowSenders.split(/[,，\s]+/u).map(item => item.trim()).filter(Boolean),
              },
              behavior: {
                answerInChat: form.answerInChat,
                requireToken: form.requireToken,
                textQuestions: form.textQuestions,
                completionNotify: form.completionNotify,
                completionMinSeconds: Number(form.completionMinSeconds),
                includeSubagents: form.includeSubagents,
              },
            }),
          })
          await load()
          setNote({ ok: true, text: '已保存。插件按新配置重载，下面显示的是生效值。' })
        } catch (error) {
          setNote({ ok: false, text: `保存失败：${String(error.message ?? error)}` })
        } finally {
          setBusy(false)
        }
      }

      const test = async () => {
        setBusy(true)
        setNote(null)
        try {
          const result = await call('/test', { method: 'POST', body: '{}' })
          setNote(result.ok
            ? { ok: true, text: '已发出，去群里看一眼。' }
            : { ok: false, text: `发送失败：${result.error ?? '未知原因'}` })
        } catch (error) {
          setNote({ ok: false, text: `发送失败：${String(error.message ?? error)}` })
        } finally {
          setBusy(false)
        }
      }

      const dws = probe?.dws
      return h('div', { style: S.page },

        h('div', { style: S.section },
          h('h3', { style: S.title }, '环境检查'),
          dws === undefined ? h('p', { style: S.hint }, probe?.error ? `检查失败：${probe.error}` : '正在检查 dws…') : null,
          dws === undefined ? null : h('div', { style: S.kv },
            h('span', { style: S.key }, 'dws'),
            h('span', { style: { ...S.value, ...(dws.installed ? S.ok : S.bad) } },
              dws.installed ? `已安装 ${dws.version ?? ''}` : `未找到（${dws.path ?? 'dws'}）`),
            h('span', { style: S.key }, '登录状态'),
            h('span', { style: { ...S.value, ...(dws.loggedIn ? S.ok : S.warn) } },
              dws.loggedIn ? `已登录，凭证有效期至 ${String(dws.expiresAt ?? '未知').slice(0, 19)}` : '未登录或凭证已过期'),
            h('span', { style: S.key }, '当前等待'),
            h('span', { style: S.value }, `${status?.pending ?? 0} 条`)),
          dws === undefined ? null : h('p', { style: S.hint },
            '双向收发（推卡片 + 读回复）依赖本机 dws；只用 webhook 推送时可以不用 dws，但也收不到回复。'),
          dws === undefined || dws.installed ? null : h('p', { style: { ...S.hint, ...S.bad } }, '请先安装并登录 dws：`dws auth login`。')),

        h('div', { style: S.section },
          h('h3', { style: S.title }, '目标会话'),
          h(Row, { label: '群聊', hint: groups.length === 0 ? '没能从 dws 读到群列表，可直接填写 openConversationId。' : undefined },
            groups.length > 0
              ? h('select', {
                  style: S.input,
                  value: knownGroup ? form.targetId : '',
                  onChange: event => patch('targetId')(event.target.value),
                },
                h('option', { value: '' }, '（选择要推送的群）'),
                groups.map(group => h('option', { key: group.id, value: group.id },
                  `${group.name}${group.memberCount === undefined ? '' : ` · ${group.memberCount} 人`}`)))
              : null),
          knownGroup ? null : h('p', { style: { ...S.hint, ...(form.targetId ? S.warn : S.bad) } },
            form.targetId ? `当前目标不在群列表里：${form.targetId}` : '还没选目标群。'),
          h(Row, { label: '机器人' },
            bots.length > 0
              ? h('select', {
                  style: S.input,
                  value: bots.some(bot => bot.code === form.robotCode) ? form.robotCode : '',
                  onChange: event => patch('robotCode')(event.target.value),
                },
                h('option', { value: '' }, '（选择发消息的机器人）'),
                bots.map(bot => h('option', { key: bot.code, value: bot.code }, bot.name)))
              : h('input', {
                  style: S.input,
                  value: form.robotCode,
                  onChange: event => patch('robotCode')(event.target.value),
                  placeholder: 'robotCode',
                }))),

        h('div', { style: S.section },
          h('h3', { style: S.title }, '读取与行为'),
          h(Row, { label: '轮询间隔（秒）', hint: '每这么多秒读一次群消息找回复。' },
            h('input', {
              style: S.input, type: 'number', min: 5, max: 600, value: form.pollSeconds,
              onChange: event => patch('pollSeconds')(event.target.value),
            })),
          h(Row, {
            label: '允许的发送者',
            hint: '留空表示目标群里任何真人都算；dws 回报的是 openDingTalkId，不是 staffId，两个都填最稳。',
          }, h('input', {
            style: S.input, value: form.allowSenders,
            onChange: event => patch('allowSenders')(event.target.value),
            placeholder: 'DXiPwg5VW…, 11561',
          })),
          h(Check, { label: '在群里直接回复就裁决', checked: form.answerInChat, onChange: patch('answerInChat') }),
          h(Check, { label: '只有一张卡在等时也允许不带 #token 的裸回复', checked: !form.requireToken, onChange: value => patch('requireToken')(!value) }),
          h(Check, { label: '也转发「文本里问的待确认」', checked: form.textQuestions, onChange: patch('textQuestions') }),
          h(Check, { label: '跑完了也发一条（不需要回复）', checked: form.completionNotify, onChange: patch('completionNotify') }),
          h(Row, { label: '只在跑超过多少秒的轮次发完成通知', hint: '0 表示每轮都发；失败的轮次不受这个门槛限制。' },
            h('input', {
              style: S.input, type: 'number', min: 0, max: 3600, value: form.completionMinSeconds,
              onChange: event => patch('completionMinSeconds')(event.target.value),
            })),
          h(Check, { label: '子代理会话也转发', checked: form.includeSubagents, onChange: patch('includeSubagents') })),

        h('div', { style: S.actions },
          h('button', { style: { ...S.button, ...S.primary }, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { style: S.button, disabled: busy, onClick: test }, '测试发送'),
          h('button', { style: S.button, disabled: busy, onClick: () => {
            void load()
            setProbe(null)
            call('/probe').then(setProbe).catch(error => setProbe({ error: String(error.message ?? error) }))
            call('/options').then(setOptions).catch(() => setOptions({ groups: [], bots: [] }))
          } }, '重新读取')),

        note === null ? null : h('p', { style: { ...S.state, ...(note.ok ? S.ok : S.bad) } }, note.text),

        status?.config?.problems?.length > 0
          ? h('p', { style: { ...S.state, ...S.warn } }, `配置提醒：${status.config.problems.join('；')}`)
          : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'decision-dingtalk',
          order: 62,
          label: () => '等你决策 · 钉钉',
        }, Panel))
      },
    }
  },
})