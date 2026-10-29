# 知行前端

React + Vite + TypeScript 的本地个人学习工作台。保留现有中文界面与视觉系统；运行时数据只来自实际 API，不包含生产 fixture，也不在浏览器保存服务密钥。

## 命令

```bash
npm.cmd install
npm.cmd run dev       # http://localhost:5173，/api 代理至 127.0.0.1:18997
npm.cmd run typecheck
npm.cmd test
npm.cmd run build     # 输出 dist，由后端同源托管
```

## 本轮隔离验证结果

在本隔离 `frontend/` 已执行并通过：

- `npm.cmd run typecheck`：TypeScript 类型检查通过；
- `npm.cmd test -- --exclude src/services/api.contract.test.ts`：11 个测试文件、173 个测试全部通过；
- `npm.cmd run build`：生产构建通过，输出 `dist/`；
- `git diff --check -- frontend`：通过；本轮未启动浏览器或后端，未做截图式视觉验证；
- V4 既有 `npm.cmd audit --json` 与 `npm.cmd audit --omit=dev --json` 结果：均为 0 个漏洞，无剩余公告；本轮无依赖变化。

依赖解析为 `vitest 4.1.12`、`react-router-dom 7.18.2`、`@types/node 24.19.2`（Node `24.22.0`）、`vite 6.4.5`、`@vitejs/plugin-react 4.7.0`、`esbuild 0.25.12`。旧 Vitest 带来的 Vite 5、vite-node、旧 esbuild 和 Tinypool 已不在解析树中。React Router `7.18.0` 仍命中当前公告 `GHSA-qwww-vcr4-c8h2`，故采用最小修复版本 `7.18.2`；未改变 React 18、Vite 6 或普通 SPA 架构。

其中 `src/services/api.contract.test.ts` 直接通过 Node 加载 `server/app.mjs`，使用 `frontend/.tmp/api-contract-*` 独立目录和随机回环端口，调度关闭，外部传输和 Codex RPC 显式拒绝。fetch 包装只把 `/api/...` 翻译成测试 origin，不补 `operationId` 或修订。真实通过的场景包括：

1. 学习档案读取和带修订保存；
2. 项目创建、检查点创建；
3. 手工结构化来源、知识接受、编辑后 `needs_recheck`、再次接受；
4. 日计划 `JobAck`、真实作业轮询、重新读取计划；
5. 练习尝试、模板反馈作业及按练习读取最新尝试；
6. 输出创建和带修订完成；
7. 写入隔离测试秘密后，再次保存省略秘密字段，configured 标志保持且响应/导出均不回显秘密；
8. 导出 `{filename,content,...}`、秘密字段检查及 Blob 文本往返。

测试不会连接 18997/18998，不写真实用户数据库，也不访问第三方服务。临时产物保留在已忽略的 `.tmp/`，不递归清理。

## 场景与线协议

1. **通用写入**：`src/services/api.ts` 对每个非 GET/HEAD 请求生成一个 `operationId`，显式提供的 ID 原样保留。档案、项目、知识、输出、设置、思源和 Codex 范围从真实响应追踪修订；更新发送 `expectedRevision`。冲突提示重新加载并保留输入，用户无需填写修订或操作 ID。
2. **知识**：`sourceRefs` 始终保留结构化身份。已有引用编码为 `{sourceId}`，新增 URL/摘录编码为 `{kind:"manual",title,url,excerpt}`；编辑不清空或伪造来源身份。展示标题、URL 和摘录，不直接渲染对象。已接受内容编辑后可复核接受，拒绝与同步使用实际修订。接受状态与事实核验徽标独立；核验仅读取 `validation.status` 的 `unverified/supported/contradicted/mixed`，缺失或未知值显示“未核验”，接受/同步/相关性不代表事实正确，证据状态也不保证绝对真理。
3. **来源导入与 Codex**：来源导入区分 `siyuan_document`、`siyuan_block`、`feishu_document` 及各自标识。手动对话使用 `externalSourceId` 和 `sourceMessageId/role/content/occurredAt`。范围使用七个真实授权字段；自动列表失败不阻断手动后备。
4. **设置**：档案、独立自动整理与飞书学习位于首屏；模型、飞书凭据和 scheduler 高级配置折叠，`#profile/#model/#feishu` 可直接定位。飞书学习使用独立 `/feishu-chat` 状态、修订、显式绑定与发送命令；读取失败不清空提醒草稿或阻断凭据表单，绑定码过期不自动换码，发送仅在 enabled/bound/connected 且无命令 pending 时可用。设置保存仍严格使用 `model/feishu/scheduler` 三个对象，秘密省略保留，只有勾选明确删除才发送 `null`；自动整理和学习聊天均不写入 SettingsInput。
5. **今日与每日计划**：`/` 只展示 `/today` 返回的最多三条重点和一项练习，状态文案采用 `automation.message`，设置入口按 profile、scope、model 顺序只显示第一项。每次成功的 `/today` 响应都权威替换重点和练习，包括任何 automation 状态下的 `[]`/`null`；pending 或 rejected 请求保留当前显示，仍有效的旧 focus 由服务端显式返回。成功返回 null practice 时，本地已确认尝试不会使其复活。每次轮询完成或失败后继续调度，请求不重叠；同一练习的草稿、已保存输出、反馈与错误隔离保护保持不变，切换练习不会被迟到结果污染。尝试保存后自动请求模板反馈，反馈失败可单独重试且不会重复提交尝试。自动整理以显式修订防止旧 GET 撤销新 PUT。原生成、暂停、时区、双修订和未知到期数计划流程完整保留在 `/plan`。
6. **练习与输出**：辅助程度接受 `none/hint/partial/full/unknown`；`unknown` 用于飞书等外部回答并由现有归一化原样保留，手工输出仍默认 `none`。证据使用真实 `EvidenceRef`。Rubric 显示标签、说明和所需证据；模板反馈全部保持未评估，不生成掌握百分比。输出创建提供八个业务字段，更新带修订。
7. **复习**：使用嵌套 card/presentation、`again/hard/good/easy` 和实际评分作业。待确认操作保留会话、呈现、操作 ID 和回忆输入，安全重试复用同一身份。
8. **导出**：使用 `scope/projectIds/includeSourceContent`，把服务端 `content` 下载为安全文件名的 JSON Blob，不制造下载 URL。

候选、练习和计划项若返回可选 `relevance.reason` 或 `selectionReason`，界面只展示该真实理由，不推断 AI 评估或掌握程度。

## 当前状态边界

Kimi 隔离交付未访问生产服务或个人数据；Codex 完成 0.3.0 完整前端 174/174（含后端合约）、生产构建及 10 个真实浏览器合成场景。当前状态和截图见 [飞书整体验收](../docs/FEISHU-VERIFICATION-20261029.md)；0.2.0 历史结果见 [简化版验收](../docs/SIMPLE-VERIFICATION-20261029.md)。
