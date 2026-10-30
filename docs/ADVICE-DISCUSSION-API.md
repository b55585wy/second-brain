# 先讨论，再保存建议

本轮目标是允许用户针对一次回答的建议继续追问、补充情境或要求修改，确认满意后再收藏。讨论不提交新的练习回答，不覆盖原回答或原点评。网页继续保留原点评；明确采纳的新版建议进入现有成果库。

## 交互与费用

- 飞书建议卡片提供“继续讨论”输入框与“发送补充”，也可引用该建议消息回复。没有明确讨论上下文的消息不猜测目标建议。
- 每轮 AI 回复关联原题、原回答、原点评与有界的最近讨论。新版建议先作为草稿；收到回复、发送“OK”或打开卡片均不会自动收藏。
- 仅点击“保存建议”采纳当前可用版本。正在生成时不可保存；旧版按钮不会采纳尚未看过的新版本。已保存版本保持不变，后续新版本需要再次明确保存。
- “暂不采纳”记录当前选择，不删除讨论、回答或已保存成果。
- 每轮 AI 讨论与自动点评共用现有日额度，开关与额度仍在设置中。一次新请求最多一次模型调用，失败或结果不明也计入，不自动修复或重发。
- 每条补充最多 1000 字，模型输入最多 20,000 个 Unicode 字符；最多带最近三组完整对话，必要时先省略最早历史，不截断最新问题。完整本机历史保留。

## API 契约

接口前缀 `/api/v1`，沿用本地客户端标记、operationId 与写入去重。GET 不启动讨论、模型或收藏。

| 方法与路径 | 请求 | 行为 |
| --- | --- | --- |
| GET `/feedback/:id/discussion` | 无 | 读取指定反馈的当前建议、版本、回复和可用操作 |
| POST `/feishu-chat/open-advice` | `feedbackId, operationId` | 向已绑定的自己打开现有建议卡片，不调用模型或创建成果 |
| POST `/feedback/:id/discussion` | `message, expectedVersion, operationId` | 保存一条补充，异步准备回复和候选版本 |
| POST `/feedback/:id/discussion/retry` | `turnId, expectedVersion, operationId` | 对可重试失败明确发起一次新的有界请求 |
| POST `/feedback/:id/discussion/save` | `expectedVersion, operationId` | 采纳当前版本，同版本重复保存复用成果 |
| POST `/feedback/:id/discussion/dismiss` | `expectedVersion, operationId` | 暂不采纳该版本，保留历史 |

讨论 DTO 包含 `feedbackId, attemptId, version, candidate, lastUserMessage, reply, status, message, pendingTurnId, canReply, canSave, canRetry, saved, dismissed`。`candidate` 采用已有反馈内容结构：summary、observations、nextActions、limitations。`version=0` 表示原建议；读取它不创建记录。

## 数据与约束

`advice-discussion` 保存当前版本指针，`advice-discussion-turn` 保留补充、回复及状态，`advice-discussion-version` 保留候选内容与明确采纳的成果关联。`advice-call` 继续记录每次外部调用，不另建隐形额度。

讨论历史及候选版本作为可选集合进入正常备份，旧备份缺少这些集合仍可导入。恢复的讨论不恢复任务、绑定或模型处理权限；原队列及调用账本不作为可恢复授权导出。已采纳内容仍属于正常成果记录。

引用消息须属于当前绑定的私聊和应用，并且已确认送达；仅凭转发、猜测消息 ID 或旧按钮不能采纳新内容。讨论任务在调用前和发布前都复核材料授权、原回答以及飞书绑定。来源或授权变化会阻止外发，原记录继续保留。

本轮不建设通用聊天机器人，不根据聊天自动修改学习档案，不将讨论后的建议当作事实核验或长期能力掌握证明。
