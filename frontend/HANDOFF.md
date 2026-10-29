# 前端交接

## 实现位置

- 公共 DTO：`src/types.ts`
- 中央请求、操作身份、修订、任务轮询、来源/证据编码和导出检查：`src/services/api.ts`
- 服务端响应归一化：`src/services/adapters.ts`
- 中文流程：`src/pages/`、`src/components/SourceRefs.tsx`
- 单元与真实 API 合约测试：`src/pages/*.test.tsx`、`src/services/api.test.ts`、`src/services/api.contract.test.ts`
- 详细场景与当前状态边界：`README.md`

## 飞书学习首步设置

网页绑定区使用只读 `GET /feishu-chat/entry` 展示当前应用的官方私聊链接与折叠手机二维码，已绑定也可使用。入口失败局部显示并保留提醒草稿，刷新清除旧入口，注册后重新读取，不增加写请求或轮询。Codex 集成验证完整前端174、后端399、打包35及合成浏览器10通过；详见 [当前验收](../docs/FEISHU-VERIFICATION-20261029.md)。

- 独立组件 `src/components/FeishuChatSettings.tsx` 使用 `GET/PUT /feishu-chat`、显式 `POST /pair` 与 `POST /send-today`；聊天修订独立，请求体严格限定任务字段。状态读取失败局部展示，刷新与失败保留提醒勾选和时间草稿，同时采用服务端最新 enabled；较低修订 GET 不撤销更新成功。StrictMode 和显式刷新不重叠 GET，卸载清理读取与过期计时器。
- `src/components/FeishuRegistration.tsx` 实现无应用时的首要“扫码连接飞书”：挂载仅 GET，显式 POST 防重复，starting/waiting 每次 GET 完成或拒绝后间隔 2 秒非重叠续读，卸载清理；重新打开 waiting 不自动 POST。原样展示授权 URL 与后端 qrDataUrl，轮询失败保留 QR、状态和错误直到恢复，覆盖完成、错误、过期和显式重试，不自动重建。完成（包括初始 complete）每次挂载只刷新一次聊天与 Settings，不循环；Settings 原地更新，不卸载扫码组件。授权完成不冒充已连接，并提示可能仍需发布应用或管理员审核。
- 未配置时保留既有 `#feishu` App ID/App Secret 高级手工入口，直接 hash 与 hash 导航均展开；未复制秘密或接收人表单。旧设置的完整三对象保存、秘密清除、文档来源和 scheduler 行为不变。Today、导航及其他旧功能未修改。
- 绑定码显示私聊指令、到期时间和过期重试，不自动换码；外部绑定只通过显式只读刷新反映，不自动发送。发送按钮严格受 enabled/bound/connected/pending 限制；发送结果在无练习回退前区分 completed、alreadySent/sent、queued/pending/sending、uncertain、failed/cancelled。uncertain 后禁止重复发送并提供网页 Today 入口，刷新不恢复发送或自动 POST。聊天 DTO 接受可选 state/lastError/snoozedUntil/pendingMessages，未暴露未验证调试字段。
- `AssistanceLevel` 新增 `unknown`，现有归一化原样保留；手工输出默认值未改。新增扫码生命周期、初始/恢复完成刷新、发送兼容、提醒草稿/enabled 和修订竞争测试，并扩展 Settings/API 测试。
- 隔离验证：`npm.cmd test -- --exclude src/services/api.contract.test.ts` 为 11 个测试文件、173 个测试全部通过；`npm.cmd run typecheck`、`npm.cmd run build`、`git diff --check -- frontend` 通过。按要求未运行后端合约测试，未启动后端或浏览器，未做真实外部调用、截图式视觉验证或依赖安装；集成浏览器验收由协调方执行。

## Round 3：Today 成功响应权威替换

- 每次 `api.today` 成功都原样采用响应的 `highlights` 和 `practice`，包括 `[]` 与 `null`，不再按 collecting/organizing/waiting/limited/error 从旧显示内容回退。请求 pending 或 rejected 时没有成功替换，继续保留当前显示；旧 focus 仍有效时由服务端显式返回并继续展示。
- 同一显式返回 practice 的已确认尝试、反馈保留、草稿与迟到结果隔离，以及 automation revision 单调性均保留。成功响应为 `practice: null` 时，本地 confirmedAttempt 不会恢复旧练习。
- 回归覆盖档案修订变化后的工作状态空响应、scope/model 失效空响应、GET 拒绝保留、五种过渡/错误状态显式返回旧 focus，以及 confirmedAttempt 不复活 null practice。原先错误的“成功空响应回退”参数化场景已改为显式返回有效 focus。
- 本轮变更文件：`src/pages/TodayPage.tsx`、`src/pages/TodayPage.test.tsx`、`README.md`、`HANDOFF.md`。未增加 contextKey、后端字段、端点或依赖。

## 自动整理与 Today 重构（Round 2 基线）

- `/` 改为服务端驱动的 Today：最多三条目标重点、一项已选练习、原文展开、按练习保存的浏览器草稿、保存后自动模板反馈及反馈单独重试。每次读取完成或失败后都继续调度，collecting/organizing 为 4 秒，其余为 60 秒；请求不重叠，卸载清理计时器，失败保留已有内容。
- 尝试、输出、反馈和错误按 practice ID 隔离。A 保存或反馈在切到 B 后完成时，只更新 A 的缓存，返回 A 可恢复结果，不会覆盖 B 的草稿或隐式重复提交。自动整理 PUT 同步更新最新修订，旧 GET 不能撤销较新的状态。
- 原今日计划完整迁移到 `/plan` 和 `PlanPage`，原测试场景保留。主导航仅“今天 / 偏好设置”，六项旧工具及 `/plan` 收进可折叠高级工具并支持移动端关闭。
- 新增 `/today`、`/automation` DTO、标准嵌套适配和修订缓存；Today 的嵌套档案修订可供未显式传修订的 `saveProfile` 使用。自动整理 PUT 使用显式修订，独立于 scheduler 与 Codex scope；attempt/feedback POST 形状保持不变。设置首屏保留档案和自动整理，模型、飞书和定时配置折叠，`#profile/#model` 可直接进入。Codex 权限文案改为“允许读取已选对话”。
- 变更文件：`src/App.tsx`、`src/types.ts`、`src/components/Layout.tsx`、`src/components/Layout.test.tsx`、`src/pages/{TodayPage,PlanPage,SettingsPage,CodexPage}.tsx` 及对应测试、`src/services/{api,adapters}.ts`、`src/services/api.test.ts`、`README.md`、`HANDOFF.md`。

### 隔离验证

- `npm.cmd test -- --exclude src/services/api.contract.test.ts`：9 个测试文件、113 个测试全部通过。
- `npm.cmd run typecheck`：通过。
- `npm.cmd run build`：通过，Vite 生产构建输出 `dist/`。
- `git diff --check -- frontend`：通过。
- 按要求未运行 `api.contract.test.ts`，未启动后端、生产端口、外部 API 或真实模型，未安装依赖。
- 项目没有可在纯 mock 环境运行的浏览器工具，因此本轮未做截图式视觉验证；以响应式语义、键盘详情控件、移动导航和可访问名称测试替代。后端集成仍由协调方验证。

## 既有完成

今日页以 `dashboard.profile.goals` 判断目标配置。无目标且非零预算暂停时，“下一步”仅提供一个指向 `/settings` 的“设置学习目标”链接，不显示或调用生成/重排；空计划不再重复显示生成主按钮。已配置目标的生成仍携带真实档案/计划修订并通过既有 API 轮询任务，零预算禁用暂停、时区日期、未知 SiYuan 到期数和已有计划展示保持不变。

知识页将接受状态与事实核验状态作为两个独立徽标展示。事实状态仅读取 `validation.status`，支持 `unverified/supported/contradicted/mixed`；缺失或未知状态显示“未核验”，不由接受、同步或相关性推断正确性。提示文案说明证据支持/反证/混合证据及不保证绝对正确的边界，窄屏可换行；未新增核验编辑或自动评估。

既有写入操作身份、修订冲突、任务轮询、结构化来源、秘密省略、安全导出、复习恢复及真实 API 合约行为均保留。

## 依赖安全升级（V4 既有结果）

本轮仅升级直接依赖并更新锁文件：`vitest` 固定为 `4.1.12`，`react-router-dom` 固定为 `7.18.2`，`@types/node` 固定为 `24.19.2`，与实际 Node `24.22.0` 对齐。`vite` 保持 `6.4.5`，`@vitejs/plugin-react` 保持 `4.7.0`，共用 `esbuild 0.25.12`；旧 `vite 5.4.21`、`vite-node`、`esbuild 0.21.5` 和 `tinypool` 已从解析树移除。

React Router 先验证过官方修复版本 `7.18.0`，但当前 npm audit 显示其仍受 `GHSA-qwww-vcr4-c8h2`（影响 `>=7.12.0 <7.18.2`）影响，因此仅继续升级到最小修复版本 `7.18.2`。未使用强制 audit 修复、override 或其他功能改动，现有源码和测试无需兼容修改。

## 验证结果

本轮在 `E:/second-brain/frontend` 执行并通过 `npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build`：8 个测试文件、33 个测试全部通过，TypeScript 类型检查和生产构建通过。新增覆盖无目标设置入口/不生成、带双修订的已配置目标生成、已接受但未核验，以及四种已知、未知和缺失事实状态；既有 24 项需求断言保留。

V4 已执行 `npm.cmd audit --json` 与 `npm.cmd audit --omit=dev --json`，完整审计和 omit-dev 审计均为 0 个漏洞。本轮无依赖变化，沿用该结果，未重复声明为本次新审计。

真实合约测试使用隔离 root/dataDir、随机端口、关闭调度和拒绝外部传输；只翻译 URL 前缀，不替客户端补 operationId/expectedRevision。覆盖档案、项目+检查点、结构化知识编辑复核、计划任务、练习+模板反馈、输出、设置秘密省略、导出 Blob。未写生产端口、真实用户数据或第三方服务，临时目录未递归删除。

## 当前状态边界

未修改 server/root/runtime/tests-e2e，未启动浏览器、服务或生产 18997，未新增重复 SiYuan 客户端测试。后端及整体集成的当前状态以 [`../docs/IMPLEMENTATION-STATUS.md`](../docs/IMPLEMENTATION-STATUS.md) 为准；旧的第三轮后端发现不作为当前未决问题复述。
