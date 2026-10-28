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

## 本轮实际联调结果

在 `E:/second-brain/frontend` 已执行并通过：

- `npm.cmd run typecheck`：TypeScript 类型检查通过；
- `npm.cmd test`：8 个测试文件、33 个测试全部通过；
- `npm.cmd run build`：生产构建通过，输出 `dist/`；
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
4. **设置**：使用 `model.endpoint/provider/enabled/allowExternalProcessing/apiKey`、`feishu.appId/appSecret/apiBase/enabled` 和完整 scheduler 字段。秘密省略保留，只有勾选明确删除才发送 `null`；模型外部处理 consent 单独勾选。响应只展示 configured 标志。
5. **今日**：无目标时“下一步”只提供 `/settings` 学习目标入口，不显示或触发生成/重排，空计划不重复提供生成主按钮。已配置目标生成发送档案和计划双修订，作业成功后才重新读取。零预算继续禁用暂停；未知 SiYuan 到期数保持未知并显示连接状态，不写成零或已完成。
6. **练习与输出**：辅助程度为 `none/hint/partial/full`，证据使用真实 `EvidenceRef`。Rubric 显示标签、说明和所需证据；模板反馈全部保持未评估，不生成掌握百分比。输出创建提供八个业务字段，更新带修订。
7. **复习**：使用嵌套 card/presentation、`again/hard/good/easy` 和实际评分作业。待确认操作保留会话、呈现、操作 ID 和回忆输入，安全重试复用同一身份。
8. **导出**：使用 `scope/projectIds/includeSourceContent`，把服务端 `content` 下载为安全文件名的 JSON Blob，不制造下载 URL。

候选、练习和计划项若返回可选 `relevance.reason` 或 `selectionReason`，界面只展示该真实理由，不推断 AI 评估或掌握程度。

## 当前状态边界

本轮仅修改前端，未启动浏览器、服务或生产 18997，未新增重复 SiYuan 客户端测试。后端与整体集成的当前状态以 [`../docs/IMPLEMENTATION-STATUS.md`](../docs/IMPLEMENTATION-STATUS.md) 为准；旧的第三轮后端发现不作为当前未决问题复述。
