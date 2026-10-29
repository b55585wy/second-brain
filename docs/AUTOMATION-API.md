# 自动学习接口（0.2）

以下接口与原有 API 共存。所有写入沿用 `operationId`、JSON、同源检查及 `X-Second-Brain-Client: local-ui`；自动开关使用 `expectedRevision`。GET 仅查询，不启动采集或模型请求。

## GET /api/v1/automation

返回 `enabled`、开关 `revision`、`state`、用户可读 `message`、`setup: {profile, scope, model}`、`dailyCallLimit`、`callsToday`、`nextRunAt`、`lastSuccessAt` 和可空的 `lastError: {code, message, retryable}`。

`state` 为 `off`、`setup`、`collecting`、`organizing`、`ready`、`waiting`、`limited` 或 `error`。这些是后台状态，不是知识已被核验或用户已掌握的证明。

## PUT /api/v1/automation

请求为 `{operationId, expectedRevision, enabled}`，返回与 GET 相同的 DTO。开启会安排一次有界后台工作，配置未完成时保持待配置状态；关闭后不再安排后续工作。在途模型结果仍须通过开关、档案、授权、模型配置及来源摘要校验才能提交。

此开关独立于旧定时器和 Codex 范围权限，不能扩大已保存授权。自动模式下，旧周期采集让出执行，显式手动采集仍可使用。

## GET /api/v1/today

返回 `date`、完整 `profile`、`automation`、至多三个 `highlights`、可空标准 `practice`、可空最近 `attempt` 和 `generatedAt`。

每个重点包含 `id`、`title`、`summary`、`goal`、`whyRelevant`、标准 `sourceRefs`。摘要最多 200 个 Unicode 字符，来源引用必须来自本次有界输入，引用片段须为材料中的原文。零个相关重点是有效结果；时间预算为零时不安排练习。

成功响应中的空数组和 `null` 为权威状态，客户端不能把因档案、范围或来源变化而失效的旧内容补回来。网络失败可保留最近成功读取的数据。同一练习的草稿与已确认提交应抵御较早轮询响应，不能污染另一个练习。

作答仍使用原有 `/practices/:id/attempts`；首页保存后自动读取本地模板自查提示。反馈失败不应重新提交已经保存的回答。

## 后台与持久化

`learning_automation` 使用现有持久化单工作者和定时器。有界批次通过独立的自动采集游标接续，不逐条创建回答草稿；成功采集收据与来源写入同事务保存。提炼只处理当前授权收据覆盖的来源，不扫描全库推断权限。

来源文本单次最多 12,000 个 Unicode 字符，长来源保留片段偏移。正常提炼间隔一小时，每天最多三次；调用前预留预算，失败和结果不明也计入。连接失败后可等待至少 60 秒进行一次计入额度的短重试，连续失败恢复长间隔；认证、限流、超时及格式错误不因此快速重发。同一已预留作业在进程重启后不会重新发送模型请求。

`focusArtifacts` 保存模型来源及重点，在 v1 导出中为新增集合；旧 v1 缺少该集合时按空集合处理。导入不激活自动整理或已有焦点的处理上下文。原有知识、练习、输出和手动 API 继续可用。
