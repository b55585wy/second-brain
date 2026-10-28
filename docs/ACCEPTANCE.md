# 验收计划 · 实现之前定义

本文件定义验收条件；当前交付为本地单用户 Beta，实际结果见 [实施状态](IMPLEMENTATION-STATUS.md)。未覆盖及真实连接未验证项保留 NOT RUN/BLOCKED；不得以场景列表、接口替身或单项检查代替完整需求证据，任何必需场景失败均不得宣布该需求完成。

## 1. 交付与执行规则

本应用是独立中文本地网页，Codex 负责架构/后端及集成核验，Kimi 负责 `frontend/**`。后续编辑和测试遵循用户最新 AGENTS.md，直接执行，不再要求 codeagent；产品任务范围为 `E:/second-brain`，不启动/停止别的项目进程。测试临时文件也只能放在该根下隔离目录；不得使用真实原生笔记、用户对话或凭据作可破坏 fixture。

先从下表选择需求及场景，再写实现/测试。检查分为纯领域/校验、HTTP+SQLite 集成、连接器协议模拟、固定版本真实适配验证、键盘/响应式人工检查、关键任务 E2E；不能用纯 mock 通过推导真实 SiYuan 或 Codex 兼容。

当前检查分布于 `tests/backend/*.test.mjs`、`frontend/src/**/*.test.ts(x)` 和 `tests/e2e/specs/`。根目录 `npm.cmd test` 运行打包、后端和前端测试；浏览器验收单独报告。文件数量不代表覆盖度，以下场景才是检查清单。

证据记录每项至少包含：scenario ID、版本/环境、所用非敏感 fixture、实际预期对比、pass/fail、脱敏输出/截图链接。真实连接器测试记录适配版本、请求方法/字段和实际响应语义，但不记录 token/完整原始日志。没有凭据/服务时记录 BLOCKED/NOT RUN，不能用“可选”一词把必需核心降为通过。

## 2. 需求到检查映射

| 需求 | 必须覆盖的场景 | 验证层 / 责任 |
| --- | --- | --- |
| 独立产品、范围隔离、bootstrap、模块清单、诚实脚本 | B01–B05 | 静态 / Codex |
| 稳定 REST envelope、列表、类型、日期、错误及同源边界 | H01–H05 | HTTP contract / 后端 |
| 默认 15 分钟/上海时区、不发明职业目标、配置修订 | L01–L04、D01–D05 | 领域 + 持久化 + UI |
| 项目 CRUD、检查点及归档保留 | P01–P03 | 领域 + HTTP + SQLite |
| 来源链接、候选审核、验证元数据、显式接受与幂等 | K01–K06 | 领域 + 集成 |
| 新 SiYuan notebook、API-only、app-owned 显式同步 | C01–C05、R06、N01 | 适配模拟 + 真实 3.8.8 |
| 可选飞书服务 API 导入，凭据缺失不阻断核心 | C04–C05、S01–S04、U03 | 连接器 + E2E |
| Codex 只读方法、能力检测、范围及本地授权 | X01–X04 | 协议模拟 + 本机只读核验 |
| 增量摘要、rerun、fork 前缀与独立同文事件 | X05–X09 | 身份/版本领域 + 连接器 |
| 手动对话导入后备 | X10、U03 | HTTP + 集成 |
| 真实有界日计划、明确目标与 provenance | D01–D06 | 领域 + 集成 |
| 练习、assistanceLevel、rubric、证据反馈、写作 | F01–F07 | 领域 + HTTP + UI |
| 无模型手工/模板路径，无假 AI 分数或掌握率 | F04–F06、S02–S04、U03 | 领域 + E2E |
| Riff 唯一调度、四级语义、揭示前无答案 | R01–R06 | contract + 真实 3.8.8 + UI |
| 双提交、可能已提交评分、调和及崩溃恢复 | R04、R07–R09、J01–J03 | 故障注入 + SQLite |
| 持久化任务/进度/错误、overlap locks、有限 catch-up | J01–J06 | 作业集成 + 可控时钟 |
| 设置与 write-only 凭据、无泄漏、外发默认禁止 | S01–S05、E02、H04、X04 | 安全 contract + UI |
| 带版本导出、合并恢复、上限/去重、无凭据 | E01–E06 | 导入导出集成 |
| 原生数据保全、重启持久化、本地失败路径 | N01–N04 | SQLite + 文件访问审计 |
| prompt injection 是数据，Markdown/外链不执行 | H05、X04、F06、E04、U02 | 领域 + 浏览器 |
| 中文响应式、键盘与关键任务 E2E | U01–U05 | Kimi + 联合 E2E |
| AGPL 独立运行时、不复制源码、不预设商业闭源 | B04、N01 | 静态审计与发布前义务核对 |

## 3. Bootstrap 与 HTTP

| ID | 场景和明确的预期结果 |
| --- | --- |
| B01 | 初次目录不存在 → 只创建交付清单里的文件；所有修改绝对路径在 `E:/second-brain`；没有 Git 初始化、外部仓库变更、账户、发布或外部凭据生成。前端/运行时若被其他执行器并行创建，不能归为本执行器修改。 |
| B02 | 根 package JSON 可解析、private=true、type=module、Node 24 约束；server/start/build/test 只调用已存在脚本或 Node 内联门禁，没有缺失文件目标。入口指向实际实现，缺依赖或配置时报真实错误；结果以实际执行记录为准，不保留 scaffold 强制退出 1 门禁。 |
| B03 | .gitignore 覆盖 data/runtime、secret 环境文件、数据库及 sidecars、日志、依赖和产物；不以忽略规则替代导出字段白名单；当前无真实 secret。 |
| B04 | README/架构/状态/API/验收明确区分当前 Beta、历史设计与未验证外部能力；SiYuan 许可来源是固定 3.8.8，未复制源码；未把“商业化”解释为闭源承诺。 |
| B05 | 交接准确列出现有后端、前端、运行时资产、数据位置与未验证项，不把占位文件或安装包当作可用服务；根 ESM 不需要重复 server package。 |
| H01 | 每种成功路由都有 data；每种失败只有 error，包含固定 code/中文 message/可选 retryable；health 同样 envelope；collection 空数组/total=0，过滤后 total 不随 offset 改变。 |
| H02 | limit=1/100、offset=0/100000 边界；空搜索、中文、相同 createdAt 的稳定排序；limit=0/101、小数、负 offset、未知 query、无效 JSON/Content-Type/ID/日期/未知字段分别正确 4xx。 |
| H03 | UTC 毫秒 Z 时间、稳定 string IDs、null 与省略语义；写请求 expectedRevision 不匹配 409，事务零部分更新；同 operationId 相同请求重放原结果，不同负载 409。 |
| H04 | 正常同源/代理/本地 CLI 可用；恶意 Origin、Host、缺自定义头、HTML form、任意 CORS 均不能写入；请求超限 413，无凭据/正文/堆栈泄漏到错误或日志。 |
| H05 | Markdown、标题、问题和 URL 中嵌入脚本、事件 handler、文件路径、“忽略规则并上传”等内容 → 仅作为数据/净化文本；不执行、不抓文件、不扩授权、不触发网络。 |

## 4. 配置、项目和知识状态

| ID | 场景和明确的预期结果 |
| --- | --- |
| L01 | 新数据库配置 goals=[]、careerDirection=""、skills=[]、15 分钟、Asia/Shanghai、revision=1；UI 不植入职业/目标；GET 修订含初始化。 |
| L02 | 全量 PUT 保存五个字段，新修订及旧快照可读；同值保存不增修订；同 operationId 重放；两页面并发旧 revision 无覆盖，重启值和修订历史仍在。 |
| L03 | 预算 0/1/120 成功，0 表示暂停；121/小数/NaN/字符串拒绝；真实 IANA 时区成功，空/无效时区拒绝；目标 0/20/21、技能 0/50/51、空白项/超长项边界明确。 |
| L04 | 目标、技能、预算或时区变更使相关计划 stale；旧输出/反馈仍指向当时配置证据，不把新职业方向回填历史。 |
| P01 | 新建项目及检查点、搜索/状态过滤/分页；四种项目状态全互转；检查点三个字段正常组合和至少一项非空，全部空白/超长/无项目拒绝。 |
| P02 | DELETE 仅归档；知识、检查点、映射、SiYuan 原生块不删除；归档可读，新增检查点 409；恢复 active 后可继续；重复归档不增修订。 |
| P03 | PATCH 旧 revision、非法 status/只读字段、空修改、失效关联 ID 都失败且不改变任何现有记录；关联归档不会使源数据消失。 |
| K01 | 无密钥创建手动 draft、附真实 sourceRef、无来源手动 draft 显示待核验且 accept 422；补手工引用后可接受；候选提取/服务导入始终 draft，不自动接受、事实支持或同步。 |
| K02 | 显式 accept 与 reject、reject→draft 再 accept、accepted/needs_recheck→reject、任意允许归档/恢复；所有未允许转移 409。PATCH accepted/rejected、写 blockId/sync/origin 等绕过字段 422。 |
| K03 | accepted 可同时 unverified/未同步；用户验证支持/反驳/混合必须有证据和非 none method；checkedAt/By 服务端赋值；模型不能写用户决定或 verified 状态。 |
| K04 | 改 question/answer/sourceRefs 或来源新版本 → needs_recheck、旧答案及历史不被采集覆盖；旧映射 stale、不自动写原生块；纯 projectId 变更不假造再审核。 |
| K05 | 同 operationId 双接受/双拒绝/超时重发/重启重放只产生一个决定；接受本身绝无 SiYuan 写请求。新 operationId 对同状态可记录新审计但不能重复造卡。 |
| K06 | q/项目/状态/来源/验证过滤为 AND；空结果 total=0；invalid source ID、超长问题/答案、证据引用失效/超数/非法协议失败，存储无半条数据。 |

## 5. 来源服务和 Codex 身份

| ID | 场景和明确的预期结果 |
| --- | --- |
| C01 | 缺清单/令牌/连接时显示 not_configured；读取正确清单后可检查，版本/鉴权/notebooks/Riff 检查状态分开；检查绝不创建 notebook/card 或评分。清单 version 错、tokenFile 越界/符号链接逃逸、baseUrl 非回环拒绝。 |
| C02 | 用户明确同步 accepted 知识后用 API 新建专用笔记本；同名已有笔记本不被认领；只更新带应用标记的知识块，导入原始 notebook/文档及用户其他块保持不变。 |
| C03 | 同步新建/更新/block-card 分阶段、双提交和同知识新 operationId；一张知识仅一张卡，lastSyncedRevision 仅在确认后更新；中途失败保留已确认映射，不删除原生内容；不确定写先读标记调和。 |
| C04 | SiYuan document/block 和飞书 docx/wiki URL 正常只读导入、反复导入身份去重；缺权限、无效 ID/URL、错误区域/租户、任意 host/重定向、超 1 MiB 文本、服务超时给出真实错误，不能转抓原生文件。 |
| C05 | 飞书无凭据不阻断目标/项目/手工知识/练习/写作；配置只调用服务 API，不建机器人或消息入口；没有模型时来源保存成功且候选=0/待人工 notice，不填假候选。 |
| X01 | scope 初始关闭/空白 → threads 空、不调用 app-server；显式 sync 403；启用选定 thread 或 path 只看到授权元数据；能力/版本不支持时明确 CAPABILITY_UNSUPPORTED。 |
| X02 | thread OR 项目路径允许，排除优先；Windows 大小写、分隔符、真实边界、符号链接、E:/a vs E:/ab、archived 标志及无效路径；query 只能收窄；请求含一个越权 thread 即全拒绝。 |
| X03 | 记录模拟及真实只读 RPC；仅初始化与经核验 thread/list/read，list 必须 useStateDbOnly=true，缺该只读保证则能力不足；未调用 start/resume/turn/fork/archive/delete/执行；要求 resume 才能读取的版本被标为不支持；不控制已有用户进程。 |
| X04 | user/assistant 可见消息正常捕获；analysis/reasoning、system/developer、工具完整日志跳过；合成 secret 脱敏；恶意源指令不扩 scope、不执行、不外发。未配置/未允许模型时网络捕获证明无上传。 |
| X05 | 同一来源/稳定 messageId 同内容 rerun 无重复；原事件摘要变化建新版本并触发关联 needs_recheck；checkpoint 与 source/candidate 原子持久化，断点前后重跑结果一致。 |
| X06 | 已证明 fork 父子关系、有序继承前缀匹配 → 只为继承事件建立 alias；fork 后新消息保留；fork 后新消息即便文本等于祖先也保留，不能按全局 digest 删除。 |
| X07 | 无祖先关系的两个独立线程相同文本、同线程不同 messageId 的相同文本均保留；缺祖先/稳定事件位置时不猜测折叠，报告能力/ANCESTRY_UNAVAILABLE，不误删独立来源。 |
| X08 | maxThreads=1/100、maxMessages=1/1000、超过上限/非法值；达到额度 hasMore=true，仅推进已保存水位；partial snapshot、暂时缺消息、撤销范围不触发历史删除。 |
| X09 | 采集进行中撤销授权 → 停止未开始读取，排队任务取消/阻塞；已有审核数据保留；重启后依 scope revision 复核，不用旧授权继续扫全部线程。 |
| X10 | 无 app-server 手动导入 user/assistant 对话可用，明确 manual_dialogue 标记；稳定 externalSourceId/messageId rerun 去重、改内容保留版本；0/501 条、重复 sourceMessageId、未知 role、超长/超体积及 allowManualImports=false 拒绝。 |

## 6. 时间预算、练习与写作

| ID | 场景和明确的预期结果 |
| --- | --- |
| D01 | 无计划 GET 为 not_generated/空 items、无伪历史；有真实 accepted 来源+用户目标后生成真实 practice ID、rubric 和 provenance；只引用存在记录，不返回样例统计。 |
| D02 | 预算 1、15、120；每项正整数分钟、offset 连续、总和<=快照预算，未安排分钟计算正确；模板足够短才可纳入，不能固定塞满所有任务；再生成复用未完成练习并保留真实完成记录。 |
| D03 | 无目标不发明职业；可排真实复习/已有写作；无目标且无材料为 blocked 空计划。无 accepted 材料但明确用户目标时只生成引用 profileRevision 的产物模板，无虚构技术结论。 |
| D04 | Asia/Shanghai UTC 跨日边界（UTC 16:00）、合法闰日、无效日期、UTC 与其他 IANA 时区；GET 历史按保存时区，generate 只限当前时区今天；排队跨午夜/配置修订后不覆盖错误日期/版本。 |
| D05 | 预算/时区/目标变化 stale，旧 revision 生成 409；并发同日期/时区只一份当前计划；下调预算低于已完成估时不产生超预算新任务，历史不被篡改。 |
| D06 | SiYuan/Riff 缺失 reviewDueCount=null，绝不假 0；可排本地任务；无模型使用 template 标签；显式不允许模板回退时模型失败保留真实错误。 |
| F01 | 手动创建 explanation/new_scenario/artifact，目标、rubric、provenance 和来源齐备；无 key 正常；rubric 1/10 项成功，0/11、空 label/非法估时/错误项目或 source 拒绝。 |
| F02 | 四种 assistanceLevel 都可提交并保持区别；独立输出与 full 辅助输出不混为独立技能证据；非空输出正常，空/超长/未知 level/无练习 4xx。 |
| F03 | 同 operationId attempt 重放一条；新 operationId 的真实重做产生另一条；practice open→completed 表示已提交；重启后所有尝试与最近反馈可读，原输出不可变。 |
| F04 | template 反馈 basis=deterministic_checklist、全部 finding=not_assessed、有明确局限，无假 AI 分数/掌握率；manual 标记用户判断，rubric criterion 不缺不多；model 标记建议并引用实际证据。 |
| F05 | 模型无 key/离线/权限/无效结构/超时，fallback=true 明示模板，false 作业失败；配置模型不改变知识决定或 Riff；反馈请求双击不生成重复。 |
| F06 | 提交后修改关联写作仍引用旧证据快照/digest；URL 未抓取标未检查；超 snapshot 限制 413；恶意模型内容/来源指令不能越权、执行、发消息或改验证状态。 |
| F07 | 无模型写作 draft 空内容可保存、final 必须非空、draft↔final 与并发 revision 处理正确；final 不对外发布；搜索/分页/空列表、归档关联、失效 evidence 引用均按契约。 |

## 7. Riff 与外部提交窗口

| ID | 场景和明确的预期结果 |
| --- | --- |
| R01 | 有真实到期卡新建/恢复会话；只含 accepted+synced+app-owned 卡；无到期为正常 empty；服务缺失/3.8.8 不符/缺能力为明确错误，不用本地 scheduler。 |
| R02 | next 网络 DTO、HTML/隐藏 DOM、前端状态和日志在 reveal 前无 answer/来源摘录/完整 Knowledge；重复 next 不跳卡；刷新 revealed 标志持久化，但 GET 仍无答案。 |
| R03 | 仅当前 presentation/card 可 reveal；reveal 后才可 response；无会话、旧卡、未揭示、completed、非法 elapsed/rating 都拒绝；正常状态 question→revealed→pending→confirmed→next/completed。 |
| R04 | 相同 operationId、不同 operationId 的相同双击都只评分一次；改 grade/elapsed 不覆盖；Riff 真实再次返回同 cardId 有新 presentationId，可进行新一次回忆，不能误去重。 |
| R05 | again/hard/good/easy 的中文语义及 pinned 3.8.8 数值映射逐一真实核验；确认后 reviewedCount 加一次；记忆评级不改变技能证据、掌握率或用户事实验证。 |
| R06 | 列出 pinned Riff 方法、请求/响应、建 deck/card、到期读取及评分提交语义的实际证据；版本/capability/错误状态可见；代码/依赖树无 ts-fsrs 或本地到期算法；原生调度不被本地导入重建。 |
| R07 | 在发出前、发出后未响应、远端已提交但本地未确认、远端成功后本地事务前后分别注入断线/超时/进程退出；只有可能已发出窗口转 uncertain，重启不盲目再发。 |
| R08 | 可关联的唯一证据确认→原 job 成功并推进一次；明确未提交→失败释放并等待新用户动作；不可证明/冲突→保持 uncertain，next 返回 jobId，原生核对提示；到期变化本身不当成操作证明。 |
| R09 | uncertain 时重新打开页面/新 session/同卡不同操作 ID/并发 deck 写均不能重评；只读 reconcile 可再检查；协议无足够证据时诚实保持阻塞，不伪造失败或强制成功。 |

## 8. 设置、作业与重启

| ID | 场景和明确的预期结果 |
| --- | --- |
| S01 | 秘密省略保留、null 删除、字符串替换；GET settings/connections、dashboard、Job、错误、日志、导出和页面只见 configured flags，没有 token/key/secret 片段；使用合成凭据贯穿捕获检查。 |
| S02 | 所有可选服务初始关闭，空凭据与不兼容 endpoint 不冒充连接成功；有效设置修订跨重启；任意非秘密缺字段/只读 flags 写入/含凭据 URL/无效 HH:mm/interval 边界拒绝。 |
| S03 | 外部 endpoint 配好但 allowExternalProcessing=false 不发送；允许且显式 model 请求才发送最少脱敏选中材料；定时模板任务不借模型配置外发；本地模型 enabled=false 也不调用。 |
| S04 | 飞书 appId/secret 缺失、403、过期 token/限流/服务离线不阻断核心；不发消息、不建立飞书入口，不把登录飞书作为本地 app 使用条件。 |
| S05 | secret 文件权限拒绝/磁盘失败时拒绝配置成功，flags 不撒谎；日志与报错无秘密；已知键值/token 形态在源预览、反馈和下载中脱敏，记录脱敏计数不显示原值。 |
| J01 | queued/running/progress/error/operations/checkpoints 重启后可读；只读任务从已保存进度继续、不重复候选；running may_have_committed→uncertain，不擅自改为 queued。 |
| J02 | 同类型同范围两个 operationId 并发→JOB_OVERLAP，同 ID 复用 job；SQLite 唯一锁/lease 在进程重启/重复 tick 仍有效；不靠前端按钮/内存标志。 |
| J03 | 队列 100 与 101 边界、total=null/0/正数、completed 不越界；安全瞬时读取只重试一次，权限/能力不重试；uncertain 写 0 次自动重放；failed 作业 HTTP 200 data.error 不被当成功。 |
| J04 | 调度默认关闭零任务；开启后只采集已授权来源/生成模板计划，不接受/同步/评分；UTC interval slot/local 日 slot 去重，配置修订和重启不重复同 slot。 |
| J05 | catch-up 关闭、刚好 24h、超过 24h、停机多日；开启每类最多补一个周期，日计划只补当前本地日，无不限量 backlog；进度与游标持久。 |
| J06 | DST gap/fold、时区更换、localTime 更换、午夜边界和重复启动：按契约 gap 后第一个有效时刻/同日只一次，入队快照不混新预算；不修改任何 Riff due 状态。 |
| N01 | 文件访问审计与 fixture/native sentinel：只改本产品 data，SiYuan 仅 API 访问；允许读取约定清单/令牌，不直接碰工作区文件/SQL；正常/失败/导入/归档后原生数据完整。 |
| N02 | SQLite 事务中途失败/存储权限拒绝/磁盘满/损坏报真实错误不半写；迁移失败保留本产品备份和 schema version，不操作 SiYuan 数据库。 |
| N03 | 正常关启后项目、修订、检查点、知识/决定、来源版本、计划、尝试/反馈、输出、作业与会话证据都持久，timestamps/IDs 不重生；未配置服务不阻止启动核心。 |
| N04 | 第二实例/端口已占用/相同数据目录锁冲突清晰退出，不 kill 进程或改其他应用；可选 frontend/dist 尚不存在时 API 能启动并诚实说明 UI 未构建（后端阶段验证）。 |

## 9. 导出、恢复和关键界面

| ID | 场景和明确的预期结果 |
| --- | --- |
| E01 | 空产品、全部和单项目导出；profile 与空数组完整、关联依赖完整、content 可下载并再次解析、byteLength/sha256 对精确 UTF-8 内容正确；不冒充原生备份。 |
| E02 | 默认无源全文/摘录，显式开启才有脱敏快照；配置/令牌/tokenFile/cookie/原始日志/可执行 job payload 不在任何字段；合成秘密遍历检查，非敏感写作数据保留。 |
| E03 | 9 MiB document / 10 MiB request / 10000 记录上下边界（含中文 UTF-8）、无数据/全部数组/schema/长度/引用限制；超限无截断、无半导入，导出本身可重新导入。 |
| E04 | 未知 schema、伪凭据字段、prototype 污染、脚本/文件路径、畸形外部 URL、缺依赖/无效时间拒绝；整个校验失败事务零写入、零服务调用，文本指令无副作用。 |
| E05 | 同文件同 ID/新 operationId 重导跳过；同 ID 不同内容冲突保留本地；缺依赖报告，最多 100 冲突细节/真实总数；来源身份摘要去重但独立同文事件不合并；profile 默认不应用，显式应用保留旧修订。 |
| E06 | accepted 恢复为 needs_recheck、旧决定证据与外部映射审计完整；外部链接不自动写回；未完成计划 stale、会话 blocked、jobHistory 只归档；无评分/调度/上传回放，原生数据不变。 |
| U01 | 中文独立网页直接打开 127.0.0.1:18997；320/375/768/1440 宽度关键流程无横向遮挡；语义元素/label/可见焦点、Tab/Enter/Space/Escape、状态播报、对比度可用；关键操作不只依赖鼠标/颜色。 |
| U02 | 真实空状态、加载/离线/失败/uncertain/修订冲突清晰；mock 有明显标签且生产不填假统计；任何答案预取/隐藏 DOM 泄漏失败；提示注入/脚本只显示净化内容。 |
| U03 | 无模型/无飞书/无 Codex 可用的 E2E：填写用户目标→建项目/检查点→手动来源知识→审核→模板日练习→提交输出/辅助程度→模板反馈→本地写作→刷新/重启恢复→导出/合并导入，核心不被 key 设置挡住。 |
| U04 | 授权采集 E2E：选范围→同步并查看真实进度→核对 source-linked draft→用户改/验证/接受→显式 sync 到新 notebook→真实 Riff next/reveal/rate→练习/证据反馈→写作；每步可追溯来源、决定、输出，不把模型响应当事实。 |
| U05 | 键盘双提交、请求超时/断网后刷新、第二页面并发编辑、评分 uncertain 和模型离线完整 E2E；不重复决定/卡片/评分/尝试；展示原 job、保留用户未保存正文并给出可理解错误。 |

## 10. 交付门槛与当前结果

后端实现完成需提供需求矩阵每项对应的检查与结果；真实 3.8.8、真实只读 Codex 能力、重启/故障窗口和 UI E2E 分开报告。纯 mock、HTTP 200、模板文字、一个单测或安装成功均不是上述全链路的替代证据。任何缺服务/权限项如实列出，不编造通过。

当前状态与实际执行证据见 [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)。B01 保留初始创建的范围约束，B02–B05 核对当前入口和交接；其他场景按各自证据层报告。真实 SiYuan/Riff 等未验证项不得勾选通过。
