# 前端交接

## 实现位置

- 公共 DTO：`src/types.ts`
- 中央请求、操作身份、修订、任务轮询、来源/证据编码和导出检查：`src/services/api.ts`
- 服务端响应归一化：`src/services/adapters.ts`
- 中文流程：`src/pages/`、`src/components/SourceRefs.tsx`
- 单元与真实 API 合约测试：`src/pages/*.test.tsx`、`src/services/api.test.ts`、`src/services/api.contract.test.ts`
- 详细场景与当前状态边界：`README.md`

## 本轮完成

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
