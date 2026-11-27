# dsh-decision-dingtalk

> 给 DeepSeek Harness 加一条「决策通道」：任何一个会话停下来等你拍板时，把这张卡推到钉钉；你在钉钉回一句，它就接着干。

装上它以后不用再盯着侧边栏看哪个会话亮了黄点。审批、计划待审、提问会以机器人身份发到钉钉群（或私聊），工作台和钉钉**谁先答谁生效**。

## 它拦的是什么

| 事件 | 来源 | 推给钉钉的样子 |
| --- | --- | --- |
| 工具审批 | `approval/request` | 「🔔 需要你批准 · 会话名」+ 工具名 + 原因，回 `#a7k2 批准` / `#a7k2 拒绝` |
| 计划待审 | `user-questions/request`（`plan-review` 意图） | 「❓ 需要你决定」+ 选项，回 `#q2x9 1` 或 `#q2x9 批准` |
| 提问 | `user-questions/request` | 同上；没有选项时直接回文字就是答案 |
| 跑完了 / 跑失败了 | `turn/end`（completed / error / max-tokens） | 「✅ 跑完了」+ 耗时 + 结尾摘要，**不需要回复**；失败的带错误原文 |
| 文本里的「待确认」 | 回合结束时最后一条回复（如「要不要我现在发版？」「待确认 等你拍板」） | 「💬 等你回一句」+ **该回合收盘那一段原文**（约 1200 字）+ 工作目录 + 会话名；你的答复会**作为一条新消息发进那个会话** |

它**不替你做决定**：只是把已经在等你的那张卡复制一份到钉钉，两侧同时可答。

第三行那类没有控件可挂：agent 只是把话问在文本里，然后回合结束。插件在 `turn/end` 时读最后一条回复，命中问句特征（问号结尾，或含「要不要 / 需要我 / 是否 / 请确认 / 待确认 / 等你拍板 / shall I / should I」这类措辞）就发一张卡——**卡里带该回合收盘那一段原文**，因为决策依据往往在问句之前；会话没有标题时用工作目录名兜底，不会只给一个 session id；你在钉钉回的整段文字会经 `sessionController.prompt` 当作一条普通用户消息写进那个会话。你在工作台里自己回一句，对应那张卡立即作废。

## 安装

```sh
# 从 npm（registry 由仓库根的 .npmrc 锁定到 registry.npmjs.org）
dsh plugin --profile web add @chenkai114/dsh-decision-dingtalk
# 或从本机源码
dsh plugin --profile web add /Users/chenkai2/data1/www/htdocs/dsh-decision-dingtalk
```

或在 **插件 → 添加插件** 里选这个目录。装完在 profile 的 `cordis.patch.yml` 里把 `decision-dingtalk` 那行的配置填上，重启 `dsh web`。

## 配置

```yaml
- id: decision-dingtalk
  config:
    target:
      kind: group        # group=群聊(openConversationId) | user=私聊(userId)
      id: oc_xxxxxxxx    # `dws chat search --query "群名"` 可以查
    push:
      mode: dws          # dws | webhook
      robotCode: dingxxxxxxxx   # 群机器人 code；也可用 $DINGTALK_CHAT_ROBOT_CODE
    read:
      mode: dws          # dws=以你本人身份轮询回复 | none=只通知不回收答复
      allowSenders: []   # 留空=目标会话里任何真人都能答；建议填上自己的 userId
    behavior:
      answerInChat: true # false = 只提醒，裁决仍在工作台
      requireToken: true # 回复必须带 #token
      textQuestions: true        # 也盯「文本里问的待确认」；false 只盯审批/提问控件
      textQuestionMinutes: 180   # 这类卡最多等多久（分钟后自动作废）
      completionNotify: true     # 跑完了也发一条（不需要回复）
      completionMinSeconds: 10   # 只发跑超过这么多秒的轮次；0 = 每轮都发
```

`push.mode: webhook` 时改用群自定义机器人：填 `webhookUrl`（含 `access_token`），有加签就填 `signingKey`，此时不需要 `robotCode`，也不需要 `dws`。

配置没填全时插件**不会报错也不会挂**：它在日志里写一行 `not active yet: …` 并保持不激活，填好后重启即生效。

### 为什么默认落在群里而不是私聊

`dws chat message list --user <自己>` 读到的是「和自己的私聊」，读不到机器人单聊会话——所以私聊目标只能单向通知，回复收不回来。群聊两个方向都通，因此推荐建一个只有你 + 机器人的小群（`dws chat +chat-create --name "DSH 决策通道" --bots <robotCode> --yes`）当决策通道。

## 设置界面

设置 → 「等你决策 · 钉钉」：

- **环境检查**：`dws --version` 与 `dws auth status --readonly`（只读本地快照，不联网）——打开面板时先画表单，这项在后台补上；未安装或未登录会直接给出该跑的命令。
- **目标群 / 机器人**：从 `dws chat +chat-list`、`dws chat bot search` 现查现选，不用手填 id。
- **谁可以替你拍板**：从群成员列表里按名字勾选（`dws chat +chat-members-list`），不勾就是「这个群里任何真人」；不需要手填 openDingTalkId。
- **行为开关**：群里直接裁决、裸回复、文本待确认、完成通知、子代理、轮询间隔。
- **测试发送**：当场验证通道，失败原因显示在页面上。

## 回复语法

- 审批：`#a7k2 批准` / `#a7k2 拒绝`（也认 同意 / 允许 / 通过 / ok / yes / 1，拒绝侧同理）
- 单选提问：`#q2x9 2`（序号）或 `#q2x9 灰度`（原文）
- 多选提问：`#q2x9 1,3`
- 没有选项的提问：`#q2x9 你的答案`
- 一张卡里有多问：`#q2x9 1; 今天上线`（每问一段，用 `;` 分隔）

默认 `behavior.requireToken: false`：**只有一张卡在等时，群里直接回一句就认**；同时有两张以上时必须带 `#token`，否则插件会回你一行「这条不是答复：现在有 2 张卡在等你（#a… #q…）」而不是静默吞掉。

`read.allowSenders` 要与 dws 实际回报的 id 对齐——它给的是 **openDingTalkId**（`DXiPwg5VW…`），不是 staffId（`11561`）；两个都填上最稳。填错时不再静默：日志会 warn 出这条消息实际携带的 id。

## 边界

- 读到 `sendType: robot` 或带 `messageAiSendFlag`（工具借你账号发的）的消息一律**不当答复**，避免 agent 自己跟自己对话。
- 子代理会话默认不推（`behavior.includeSubagents: true` 可开）。
- 免打扰时段（`behavior.quietHours`）内不推，请求留在工作台。
- 在钉钉裁决后，网页上那张卡可能要等你点一下才消失，点它不会有副作用（会提示已失效）——卡片由工作台自己维护，插件不去改它的状态。
- 只支持 macOS/Linux 上跑 `dsh web` 的场景；`dws` 未登录、机器人不在群里这类问题会在日志里给一行 warn，不影响会话继续运行。

## 开发

```sh
node --test test/
```

29 个用例覆盖回复解析、消息渲染、配置归一、静默时段，以及桥的核心竞争语义（聊天先答 / 工作台先答 / 无应答者 / 取消 / 只通知 / 白名单 / 子代理跳过）。

## 许可

MIT