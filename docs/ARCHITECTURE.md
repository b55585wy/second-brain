# 架构基线 v1 · 本地单用户 Beta

本文件保留设计约束并列出现有模块职责。当前实现与核验结果见 [实施状态](IMPLEMENTATION-STATUS.md)，REST 细节见 [API.md](API.md)，验收条件见 [ACCEPTANCE.md](ACCEPTANCE.md)。真实思源 API/Riff、四级评分及重启持久化现已通过；日常入口用官方 workspace/port 参数固定 19006，避免依赖桌面随机端口。

## 1. 质疑假设

| 假设 | 核验状态 | 处理 |
| --- | --- | --- |
| 已有可复用的应用、数据库或前端 | 已否定：初次检查时 `E:/second-brain` 不存在 | 新建独立产品，不读取或改写其他项目 |
| Windows、Node 24.22.0、原生 SQLite、Python 3.12.8、npm 可用 | 用户已提供验证事实；本阶段未重复做运行时测试 | 用 Node ESM JS 与内置模块，Python 不成为后端依赖 |
| Codex CLI 在本机可用 | 0.164.0 已通过一个授权会话的真实有界快照采集及零新增回放 | 不据此推断完整实时历史、持续同步或真实 fork 祖先已验证 |
| SiYuan 3.8.8 已可连接、可建笔记本且 Riff 可评分 | 真实专用笔记本写读、四级评分、完整调度状态及重启持久化已通过 | 证据限本机固定版本和本地访问配置，见真实验收报告 |
| 对话读取总能提供稳定消息 ID 与 fork 祖先 | 未验证 | 能力探测，证据不足则保留独立记录，手动导入作为明确标记的后备 |
| 模型输出能当作已验证知识 | 不成立：一次生成不提供外部验证证据 | 来源、用户决定、事实验证元数据分别建模 |
| 记忆评分能证明应用技能 | 不成立：评分只记录一次回忆自评 | 练习输出、辅助程度、rubric 和证据单独建模 |
| 用户已有明确职业方向，或愿意上传全部对话 | 未授权 | 职业/目标初始为空，采集与外部处理默认关闭 |
| 必须有云模型、飞书、向量库或第二个调度器 | 不由本地单用户约束推出 | 手动/模板路径可用；不添加这些强制依赖 |

## 2. 不可再分的事实与限制

1. 本地单用户的持久化需求是有限数量的结构化记录；没有已知多租户、跨机写入或高并发需求。
2. 一个进程可以串行修改 SQLite，并用事务保证本产品记录原子提交；SQLite 事务不能涵盖一次远程 SiYuan HTTP 写入。
3. HTTP 响应超时不能证明远端未提交。因此“重试一次”并不能保证写操作只发生一次。
4. SiYuan 才知道其原生块和 Riff 调度状态；本产品无法凭本地计数重建或冒充这些事实。
5. 15 分钟是有限的用户时间，计划任务估时之和必须小于等于实际配置预算；没有来源和目标就不能伪造有针对性的练习或到期卡数。
6. 相同文本可由独立消息产生；文本哈希相同只证明内容相同，不证明事件身份相同。
7. 本机网页可以发起浏览器请求；监听回环地址仍需要 Host、Origin、JSON 和自定义请求头边界，不能宣称其具有多用户认证隔离。

## 3. 从事实重建最小实现

1. 由事实 1、2：采用单 Node 进程、原生 `node:http` / `node:sqlite` / `node:crypto` / `node:fs`，一个元数据 SQLite 文件和串行作业 worker。暂不引入 Express、ORM、Redis、向量服务或原生安装包。
2. 由事实 2、3：先持久化操作记录，再调用外部写入。每个用户动作使用 `operationId`，重放匹配请求返回原结果；无法确认提交就进入 `uncertain`，读取证据调和，禁止盲目再次评分。
3. 由事实 4：SiYuan API 适配器创建新的专用笔记本，只更新本应用拥有的内容。导入来源只读。Riff 独占卡片到期/间隔/调度；本产品只存会话、回答、评分操作与审计证据。
4. 由事实 5：配置有版本，计划引用该版本及真实候选、卡片、练习/输出 ID。无模型时用带标签的模板与手动输入；缺目标就提示配置，不虚构职业。
5. 由事实 6：来源事件身份与内容摘要分离；增量采集用稳定源 ID 加摘要检测更新，fork 前缀只在祖先关系与有序前缀均得到证明时折叠为来源别名。
6. 由事实 7：生产 UI 与 API 同源，只监听 `127.0.0.1:18997`。敏感配置写入与普通 DTO 分离，日志不记请求体、令牌、原始对话或模型请求。

惯性方案容易从技术栈或“知识库等于聊天记录”的类比出发，堆叠服务、自动接受知识、复刻复习算法。上述推导从持久化、身份、时间和提交可观察性出发，所需模块更少，并保留不确定性。结论：**本产品协调来源、用户决定和学习证据；SiYuan 保存审核知识，Riff 调度复习。**

## 4. 模块与所有权

以下路径是当前实现；目录划分以单一职责为准，不要求把逻辑职责展开为额外服务。根包采用 ESM，无重复的 server/package.json。

| 当前路径 | 职责 |
| --- | --- |
| server/main.mjs、server/app.mjs | 启动、依赖组装、回环监听、路由和前端托管 |
| server/http.mjs、server/dto.mjs、server/validation.mjs、server/errors.mjs | HTTP 边界、DTO、输入校验和错误 |
| server/store.mjs | data/second-brain.sqlite、迁移、事务及存储接口 |
| server/domain.mjs、server/sources.mjs、server/relevance.mjs | 项目/知识决定、来源快照及目标相关性 |
| server/learning.mjs | 每日计划、练习、反馈和输出 |
| server/jobs.mjs、server/scheduler.mjs | 持久化作业、恢复及可选定时任务 |
| server/siyuan.mjs、server/siyuan-state.mjs、server/reviews.mjs | 专用笔记本/块、连接身份与原生 Riff 边界 |
| server/collector.mjs、server/codex-rpc.mjs | 授权对话采集、增量身份及只读协议 |
| server/feishu.mjs、server/model.mjs、server/transport.mjs | 可选服务 API 与受限网络传输 |
| server/backup.mjs、server/import-schema.mjs | 版本化导出及合并恢复 |
| server/settings.mjs、server/secrets.mjs | 配置修订与本机凭据隔离 |
| tests/backend/*.test.mjs、tests/e2e/specs/ | 后端需求场景及浏览器验收 |
| frontend/ | Kimi 已交付 React + Vite + TypeScript；后续保持前端分工 |
| runtime/ | 已验证的连接元数据、独立工作区、官方安装包与运行说明；不包含用户凭据 |

Codex 负责架构、后端及集成核验；后续编辑与测试遵循用户最新 AGENTS.md，直接执行，不再要求 codeagent。实际结果及证据边界见 [实施状态](IMPLEMENTATION-STATUS.md)。

## 5. 数据所有权与流转

| 数据 | 真值所在 / 本产品用途 |
| --- | --- |
| 原始 Codex/飞书/SiYuan 来源 | 原服务；本地只保存授权可见材料的脱敏快照、定位与摘要 |
| 候选、用户决定、验证证据、项目/目标、输出 | SQLite；目标与配置保留修订历史 |
| 选中同步的审核知识 | SiYuan 新建的 app-owned 笔记本；SQLite 存块映射及上次同步修订 |
| 到期时间、记忆间隔、卡片调度 | SiYuan Riff；不得新增第二套 scheduler、`ts-fsrs` 或本地到期计算 |
| 回答、评分操作、技能练习、作业状态 | SQLite；回忆与能力证据不混成“掌握率” |
| 令牌/模型 key/飞书 secret | `data/secrets/` 或运行时只读令牌文件；不进普通 DTO、日志和导出 |

SQLite 持久化、迁移及事务由 server/store.mjs 实现；Node/Windows 检查与故障场景见后端交接和验收记录。第二实例不得借机停止已有进程；本产品事务不能代替外部服务的提交证据。

最小逻辑表：profile + profile_revisions、settings + settings_revisions、projects、checkpoints、sources + source_versions + source_aliases、knowledge + decisions + sync_mappings、daily_plans + plan_items、practices + attempts + feedback、outputs、review_sessions + review_responses、jobs + job_locks + scheduler_state、operations、import_runs。以上为逻辑职责，实际表、索引及迁移以 server/store.mjs 为准。

来源变更不覆盖已审核答案；将关联 accepted 项转为 `needs_recheck`。修改已同步知识产生新修订和 `stale` 映射，只有再次显式接受并显式同步才更新专用块。项目删除为归档，保留来源、笔记和历史。

## 6. 连接器与调和

### SiYuan / Riff

`runtime/connection.json` 预期为 `{baseUrl,version,tokenFile}`；这是另一个执行器的交付约定，本次没有读取其秘密或写入该目录。后端读取时验证 `baseUrl` 是回环 HTTP 地址，`version === "3.8.8"`，令牌文件路径经真实路径解析后在 `runtime/` 内；不把令牌文件路径返回 UI。手工 token 只存 `data/secrets/`，仅用于绑定的手工连接；清单模式只使用经验证的清单凭据，不以手工 token 覆盖。连接模式或地址变更按连接身份隔离原生映射，存在未确认写入时阻止切换。

检查连接不创建笔记本、不建卡、不评分。首次显式同步在 API 中创建新笔记本，持久化 app-owned 标记与 notebook ID；同名笔记本不是所有权证据。专用块带知识 ID、修订、操作 ID 和内容摘要。写入/响应不确定时先经 API 读取这些标记，唯一匹配才确认；冲突保持阻塞，不覆写其他块。应用从不直接读取/改写 SiYuan 工作区内部文件或 SQL 数据库。

Riff 适配器固定 3.8.8：逐项验证建卡、取到期卡、四级评分和可用的提交证据。产品 REST 用 `again/hard/good/easy`，数值映射须在该版本核验。版本不符或能力不足返回 `RIFF_INCOMPATIBLE`，不偷偷回退到本地调度。评分请求发出后超时，操作为 `uncertain`，冻结相关卡/会话的再次评分；后台/用户触发的调和只能做安全读取。如果该版本不能证明哪一次评分已提交，保留 `uncertain`，提示在原生 SiYuan 核对，不能把到期变化单独当成操作身份凭证。

### Codex

官方文档提供 app-server 的 `thread/list`、无需 resume 的 `thread/read`；本机命令帮助仅证明存在入口，不证明当前版本、账户或本机线程支持这些能力。[文档](https://developers.openai.com/codex/app-server/) 说明 thread/list 默认可能扫描日志并修复元数据，因此采集必须核验并使用 `useStateDbOnly=true`；无法保证只读就报告能力不足。后续启动自有只读连接时读取 CLI 版本并对本机协议 schema / handshake 做检测，不控制已有用户进程。初始化握手不执行会话业务变更。禁止 `thread/start`、`thread/resume`、`turn/start`、fork、archive/unarchive、删除或任意执行方法。若读取要求恢复会话，则判为不支持。

正向授权为 thread ID 或经规范化的项目路径集合；排除集合优先，路径按 Windows 大小写/真实边界比较，不能把 `E:/a` 匹配成 `E:/ab`。范围为空就不采集。撤销授权停止后续采集，不静默删除已审核数据。手动导入独立标记 `manual_dialogue`，不伪装成自动同步。

只处理用户/助手最终可见内容，跳过私有 reasoning、系统/开发者消息、工具完整日志和凭据。身份键优先 `(connector, threadId, messageId)`；无 message ID 时用该线程内角色、位置与稳定来源定位，摘要只用于检测内容版本。没有可靠顺序定位的源报告能力不足，不靠全文哈希猜事件身份。只有已验证祖先关系、对应事件及有序前缀都吻合，才为继承前缀建立别名；独立线程中的相同文本和同线程重复文本保留。增量水位只在快照/版本/候选持久化后推进；部分读取不删除缺失消息。

### 可选模型 / 飞书

未配置密钥和模型时，手动知识、模板练习、用户输出仍可使用。模板反馈只能明确列出尚需提供的证据或可机械核对的项目，不产生假 AI 分数。模型反馈标记为建议并引用实际 rubric/输出证据，不自动改变事实验证或知识决定。

外部模型默认关闭；必须配置 endpoint/model 并显式允许外部处理后，才发送所选任务需要的脱敏内容，不发送整库、私有 reasoning 或令牌。仅配置飞书不启用模型，也不把飞书作为入口。飞书通过服务 API 读取显式文档 URL，不部署消息机器人，不向他人发消息。连接缺失不阻断核心编辑。

## 7. 时间、作业与安全边界

配置默认 `dailyBudgetMinutes=15`、`timeZone=Asia/Shanghai`，目标字段为空。持久时间为 UTC ISO 字符串；日历日期用所选 IANA 时区计算，不能把 UTC 日期截取当本地日期。同一 `(date,timeZone)` 只有一份当前计划，预算或目标修订后旧计划标记 stale。

每项估时至少 1 分钟，按 offset 顺序排列，总和不超过预算；不够时间则排除/缩短任务并给出原因。练习必须链接明确目标及真实来源或用户配置，不能凭空制造职业目标、到期卡、历史输出。Riff 离线时到期数量为 `null`，不能冒充 `0`。

作业、进度、结构化错误、操作指纹和调度游标持久化。一个 worker，按作用域用数据库唯一锁和 lease 防重叠；重启后先区分纯本地事务、安全读取及可能已提交写入，再恢复。安全读取的瞬时错误最多自动重试一次；写入结果不确定不自动重放。调度默认关闭；开启后同一时段唯一键去重，最多补最近 24 小时内的一个周期，日计划只补当前本地日期，不累计旧日学习债。定时任务不得接受知识、同步任意笔记或评分。

HTTP 边界、请求限制和错误码详见 API 契约。来源、Markdown、模型文本和导入内容始终是数据；不作为指令执行，不渲染未净化 HTML，不自动读取其中的文件路径或跟随外部链接。令牌永不回传/记录/导出；已知凭据形态脱敏并覆盖合成凭据验收。任意字符串是否是秘密无法单靠规则证明，因此还需要明确范围、预览和默认禁止外发，不能宣称脱敏器完美。

## 8. 核验资料与仍待验证项

核验日期：2026-10-28。已阅读的 [官方 Codex App Server 文档](https://developers.openai.com/codex/app-server/) 只用于确认公开接口方向，本机有界采集另有实际证据。SiYuan 的 [v3.8.8 LICENSE](https://github.com/siyuan-note/siyuan/blob/v3.8.8/LICENSE) 确认其许可来源；本项目不复制其源码。真实 3.8.8 四级 Riff 评分及重启持久化已通过，具体范围见 [真实验收](NATIVE-VERIFICATION-20261028.md)。

早期源码网页提取失败后，已核对固定 3.8.8 官方 API 定义及其 Riff 依赖提交 228528e70754，记录见 运行时验证计划（本机留存：`../runtime/verification-plan.json`）。源码和接口替身均不单独证明真实服务兼容；本机原生 API、评分与重启验证另有 [实际证据](NATIVE-VERIFICATION-20261028.md)。应用许可、未来分发方式和商业化模式未决定；不从 AGPL 直接推导本应用必须闭源或不能商业化。
