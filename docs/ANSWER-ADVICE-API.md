# 回答建议接口 · 0.4

点评输入使用原题、原目标、原评价要点、已保存回答与当前授权的来源片段；不会自动抓取外链。内容是模型建议，不代表事实已核验或长期能力已掌握。

## 配置与调用

- `GET /api/v1/advice-settings`：返回 `enabled`、`dailyCallLimit`（0–20）、`revision`、`callsToday`、`remainingToday`、`modelConfigured`。
- `PUT /api/v1/advice-settings`：使用既有 JSON、`operationId`、`expectedRevision` 与本地客户端标记，更新 `enabled`、`dailyCallLimit`。
- `GET /api/v1/attempts/:id/advice`：只读查询，不触发点评。
- `POST /api/v1/attempts/:id/advice`：显式请求已保存回答的建议，接受 `operationId` 和可选布尔 `retry`；返回当前状态，HTTP 200。

新安装与升级默认关闭自动点评，每天默认上限 3 次；开启不回批历史回答。开启后新回答与点评任务在同一事务保存，网页和飞书共用记录。已有回答可显式请求点评；成功结果直接复用，失败或结果不明的重新请求须显式使用 `retry: true`。

`GET /api/v1/today` 新增 `adviceSettings` 与可空 `advice`，原字段保持兼容。保存回答的旧接口和 DTO 保持不变。

## 状态 DTO

返回 `attemptId`、`status`、可空 `jobId`、可空标准 `feedback`、`message`、`canRequest`、`canRetry` 和可空 `lastError`。

`status` 为 `off`、`idle`、`queued`、`running`、`ready`、`failed`、`uncertain`、`limited`、`unavailable` 或 `stale`。`lastError` 只含 `code`、用户可读 `message` 与 `retryable: false`。是否能请求以服务端给出的按钮标记为准。

成功点评沿用现有反馈格式，含摘要、各评分项的观察、至多一个下一步及限制说明。已评估的观察须引用本次输入中的回答原文；未覆盖的评价项记为 `not_assessed`。来源不明确、回答太长或缺少依据时说明覆盖范围和未知项。

## 额度与持久性

本功能的 `advice-call` 与自动提炼的 `automation-call` 独立，按学习档案时区计日。新点评调用前预留次数，失败与结果不明也计入；没有隐式模型修复重试。供应商返回完整有效 token 用量时保存，缺少或无效时记为未知。

持久请求身份、调用预留和成功反馈用于去重。重启发现已有未确认请求时不重发；用户显式重试会建立新的请求记录并继续受额度限制。

原有高级 `POST /attempts/:id/feedback` 的显式 `mode: model` 保持原行为，不计入本自动建议入口的新额度；网页和飞书的新建议流程使用本接口。原始回答和旧反馈始终保留，模板自查不会覆盖已经保存的模型建议。

## 飞书与导出

新回答先得到保存确认，随后投递简短建议；`点评` 读取或请求当前回答建议，`重新点评` 用于失败后的显式重试。没有回答、额度不足或模型不可用时说明原因并保留本地自查。消息投递仍使用现有持久发件箱和绑定检查，题目或来源已变化时不投递旧点评内容。

反馈及回答随原有 v1 导出，新增 `answer_advice` 任务可作为历史导入；点评开关、运行队列和额度账本不会作为可恢复的处理权限导入，导入不自动请求模型。
