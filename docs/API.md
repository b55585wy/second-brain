# REST 契约 v1 · bootstrap specification

**本文件是稳定的实施目标，本次 bootstrap 不实现或验收 HTTP 服务。** 所有例子均为说明数据。后端与 Kimi 共同以此文件为 DTO/行为依据；破坏性变化必须同时修订契约、消费者和验收场景。其他执行器的并行实现须另做契约核对；SiYuan/Codex 内部协议不透传给前端。

## 1. 传输、身份与通用约定

- 默认 origin：`http://127.0.0.1:18997`。唯一非版本路由是 `GET /api/health`；其余本文件路径都在 `/api/v1` 下。例：`/projects` 表示 `/api/v1/projects`。
- 请求/响应为 UTF-8 JSON，`Content-Type: application/json`。成功为 `{data: T}`，失败为 `{error:{code,message,retryable?}}`，两者互斥。错误不增加调试堆栈、请求体或上游原文。
- 所有集合的 `data` 都是 `{items:T[],total:number}`，`total` 为过滤后的总数、分页前计数。空集合为 `{"data":{"items":[],"total":0}}`。非集合中的内嵌数组不加分页 envelope。
- 集合通用 query：`limit` 整数 1..100，默认 20；`offset` 整数 0..100000，默认 0。默认 `createdAt DESC, id ASC`；线程按 `updatedAt DESC, id ASC`，sources 按 `capturedAt DESC,sourceId ASC`，notebooks 按 `name ASC,id ASC`，connections 按固定种类顺序。`q` 为去首尾空格的大小写不敏感字面子串，最多 200 字符；不解释正则/SQL/指令。无匹配返回空集合。未声明的 query 或 writable 字段拒绝为 400/422。
- `Id`：服务端生成、持久化的非空稳定字符串，长度 1..128，字符 `[A-Za-z0-9_-]`；客户端不得从格式推导顺序或类型。外部 thread/document/block ID 单独作为 `ExternalId`，长度 1..512，不用作文件路径。
- `Instant`：UTC ISO 8601，含毫秒及 `Z`，例 `2026-10-27T01:00:00.000Z`。`LocalDate`：真实日历日期 `YYYY-MM-DD`，结合指定 IANA 时区解释；不能截取 UTC 日期代替。所有持久化事件时间为 `Instant`。
- `revision`：整数，从 1 开始，每次实际修改递增；未生成的计划为 0。`expectedRevision` 不匹配返回 409 `REVISION_CONFLICT`，不做部分更新。PATCH 未提供的字段保持，明确允许的 `null` 表示清空；其余字段不能设为 null。PUT 为文中配置字段的完整替换，唯独秘密遵循“省略保留/null 删除/字符串替换”。
- 字符串长度以 Unicode code point 计，体积限制按 UTF-8 字节计。标题 1..200；目标/技能单项 1..500；一般说明 0..10000；知识问题 1..2000、答案 1..20000；写作/练习输出最多 100000。非空条件按 trim 检查，正文保留内容。数组未声明时最多 100 项；来源/证据数组最多 50 项。所有 JSON 须为有限数值、普通对象，拒绝原型污染键和未知字段。
- 普通请求体上限 1 MiB；`POST /imports` 为 10 MiB；超限 413。秘密字段最多 8192 字符，不允许空字符串（删除用 null）。URL 禁止 userinfo、凭据 query、fragment；除指定的 SiYuan 内部链接外只允许 http/https。外链仅作为引用，不因保存而抓取或执行。
- 生产同源，无 wildcard CORS。浏览器 Origin 必须与配置的产品 origin 精确匹配，Host 只允许配置回环 host/port。所有写请求（含 DELETE）必须带 `X-Second-Brain-Client: local-ui` 和 JSON Content-Type；无 Origin 的本地 CLI 请求也要该头。Vite 开发服务器通过 `/api` 代理，后端不默认开放任意 dev origin。错误为 403 `ORIGIN_FORBIDDEN`。这是本地单用户边界，不是多租户鉴权。

```ts
type Success<T> = { data: T };
type Failure = { error: { code: ErrorCode; message: string; retryable?: boolean } };
type Page<T> = { items: T[]; total: number };
type Id = string;
type ExternalId = string;
type Instant = string;
type LocalDate = string;
type OperationId = string;
type Versioned = { revision: number; createdAt: Instant; updatedAt: Instant };
type Mutation = { operationId: OperationId };
type Update = Mutation & { expectedRevision: number };
type JobAck = { jobId: Id; operationId: OperationId };
type Notice = { code: string; message: string };
```

### 操作幂等性

每个写请求都必须提供 `operationId`（8..128 个 `[A-Za-z0-9_-]` 字符，推荐 UUID），PUT/PATCH/DELETE 也不例外。服务端持久化 `(operationId, method, canonical path, canonical request fingerprint)`，先于任何外部副作用。相同 ID、路径和请求返回第一次的 HTTP 状态与业务结果；异步操作返回同一 jobId，不创建第二项。相同 ID 不同请求为 409 `IDEMPOTENCY_CONFLICT`。更新检查发生在首次处理时，重放优先返回原结果，即使当前 revision 已变化。

记录在本地业务事务中提交，跨重启有效。进行中的外部操作复用已持久化 job。客户端因超时只可用**同一个** operationId 重发/查询作业，不可生成新 ID“试一次”。特别是 Riff 或 SiYuan 可能已提交的写入，只能调和，不能自动重放。`retryable:true` 仅表示安全读取/明确未提交的暂时失败可以稍后重试，不授权重放 uncertain 写入。

### 错误表

`ErrorCode` 为以下 code 的并集。未列的异常统一 500 `INTERNAL_ERROR`（脱敏通用说明），新增错误码须修订此表。

| HTTP | code | 语义 / retryable 默认 |
| --- | --- | --- |
| 400 | `INVALID_JSON`, `INVALID_QUERY` | 格式/未知 query 错误；false |
| 403 | `ORIGIN_FORBIDDEN`, `SCOPE_FORBIDDEN`, `OWNERSHIP_REQUIRED` | 浏览器边界、授权范围、非 app-owned 目标；false |
| 404 | `NOT_FOUND` | ID 不存在或不可在当前范围读取；false |
| 409 | `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `INVALID_STATE` | 版本、重复操作负载、状态变更不允许；false |
| 409 | `JOB_OVERLAP`, `PROFILE_INCOMPLETE`, `DESTINATION_CONFLICT` | 同范围作业、缺目标、目标归属/映射冲突；false |
| 409 | `REVIEW_COMMIT_UNCERTAIN`, `RECONCILIATION_REQUIRED` | 不能安全提交新写入，需读后调和；false |
| 413 | `PAYLOAD_TOO_LARGE` | 字节/记录数量上限；false |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 非 JSON；false |
| 422 | `VALIDATION_ERROR`, `IMPORT_SCHEMA_UNSUPPORTED` | 类型/值/未知字段/导入 schema 错误；false |
| 429 | `RATE_LIMITED` | 本地有界队列满或上游限流；安全读取可 true，写入按提交状态处理 |
| 502 | `UPSTREAM_ERROR` | 上游无效响应，脱敏；安全读取可 true |
| 503 | `CONNECTION_UNAVAILABLE`, `MODEL_UNAVAILABLE`, `CAPABILITY_UNSUPPORTED`, `RIFF_INCOMPATIBLE`, `STORAGE_UNAVAILABLE` | 服务未配置/不可用、存储权限/空间失败或能力/固定版本不符；仅暂时离线可 true |
| 504 | `UPSTREAM_TIMEOUT` | 明确未产生副作用的读取超时；true |
| 500 | `INTERNAL_ERROR` | 本地未知失败；false，避免自动反复提交 |

例：`{"error":{"code":"REVISION_CONFLICT","message":"配置已更新，请重新读取后提交。","retryable":false}}`。空状态不冒充错误；未知服务数据用 null 加 Notice，不编造 0。

## 2. 来源、验证和生成来源

```ts
type SourceKind = "codex" | "manual_dialogue" | "siyuan" | "feishu" | "manual";
type SourceRef = {
  sourceId: Id;
  kind: SourceKind;
  externalId: ExternalId;
  title: string;
  url: string | null;
  threadId: ExternalId | null;
  messageId: ExternalId | null;
  documentId: ExternalId | null;
  blockId: ExternalId | null;
  excerpt: string | null; // 最多 2000 字符；已脱敏
  contentDigest: string; // SHA-256 小写 hex，对脱敏后规范可见内容计算
  role: "user" | "assistant" | null;
  occurredAt: Instant | null;
  capturedAt: Instant;
  redacted: boolean;
};
type SourceRefInput =
  | { sourceId: Id }
  | { kind: "manual"; title: string; url: string | null; excerpt: string | null };
type EvidenceRef = {
  kind: "source" | "output" | "url";
  id: Id | null;
  url: string | null;
  label: string; // 1..200
};
type ValidationInput = {
  status: "unverified" | "supported" | "contradicted" | "mixed";
  method: "none" | "user_review" | "source_check" | "executable_evidence";
  notes: string;
  evidenceRefs: EvidenceRef[];
};
type Validation = ValidationInput & {
  checkedAt: Instant | null;
  checkedBy: "user" | null;
};
type Provenance = {
  mode: "manual" | "template" | "model";
  label: string;
  sourceRefs: SourceRef[];
  profileRevision: number | null;
  model: { provider: "openai-compatible"; model: string } | null;
  generatedAt: Instant | null;
};
```

`SourceRefInput.sourceId` 必须存在且在授权本地范围；手动引用须至少提供 URL 或非空 excerpt，其 URL 不会被自动抓取。服务端分配来源 ID 和时间。SourceRef 中的 SiYuan url 可以是服务端构建的 `siyuan://blocks/<blockId>`，不接受用户任意协议。

EvidenceRef 的 source/output 类型要求有效 id 且 url=null；url 类型要求 id=null、有效 http/https URL。引用不存在为 422；已有来源被撤销授权后不再新增采集，其已保留的历史引用仍可显示脱敏材料。引用仅表达依据，不自动证明内容为真。

新知识默认 validation 为 `{status:"unverified",method:"none",notes:"",evidenceRefs:[],checkedAt:null,checkedBy:null}`。supported/contradicted/mixed 必须有至少一条证据，method 不能为 none；checkedAt/checkedBy 由用户显式校验提交时由后端赋值。模型和采集器无权填写 supported 或用户决定。接受可以保留 unverified，界面必须同时显示两者。

## 3. 健康与仪表盘

```ts
type Health = {
  status: "ok" | "degraded";
  version: string; // 根 package 版本，当前目标为 0.0.0
  apiVersion: "v1";
  stage: "development" | "ready";
  time: Instant;
  dependencies: {
    database: "ok" | "unavailable";
    siyuan: ConnectionStatus;
  };
};
type Dashboard = {
  date: LocalDate;
  timeZone: string;
  profile: LearningProfile;
  summary: {
    projectsActive: number;
    knowledgeDraft: number;
    knowledgeAccepted: number;
    knowledgeNeedsRecheck: number;
    reviewDue: number | null;
    practiceOpen: number;
    outputsDraft: number;
  };
  dailyPlan: DailyPlan;
  recentCheckpoints: Checkpoint[]; // 最新最多 5 条
  connections: Connection[];
  warnings: Notice[];
};
```

| 方法 / 路径 | 请求 | 成功 |
| --- | --- | --- |
| `GET /api/health` | 无 body/query | 200 `Success<Health>`，也使用 data envelope |
| `GET /dashboard` | 无 body/query，以当前 profile 时区的今天为 date | 200 `Success<Dashboard>` |

数据库未就绪时 health 可返回 200 degraded（存活状态，非 readiness 保证）；业务路由返回 503。可选服务离线不使整个仪表盘失败，reviewDue=null、相应 connector 状态和 warnings。全新数据库 summary 中产品计数为 0，recentCheckpoints=[]，dailyPlan 为 not_generated，profile 为空目标默认配置。

Health 例：`{"data":{"status":"degraded","version":"0.0.0","apiVersion":"v1","stage":"development","time":"2026-10-27T01:00:00.000Z","dependencies":{"database":"ok","siyuan":"not_configured"}}}`。当前 bootstrap 尚无该路由，不得把此示例当健康探测结果。

## 4. 学习配置与修订

```ts
type ProfileFields = {
  goals: string[]; // 0..20，非空项最多 500 字符
  careerDirection: string; // 0..1000，不预置身份
  skills: string[]; // 0..50，非空项最多 500 字符
  dailyBudgetMinutes: number; // 整数 1..120，默认 15
  timeZone: string; // Node Intl 可识别的 IANA 名，默认 Asia/Shanghai
};
type LearningProfile = ProfileFields & Versioned;
type ProfileRevision = {
  id: Id;
  profileRevision: number;
  values: ProfileFields;
  changedAt: Instant;
  actor: "user" | "import" | "initialization";
};
```

| 方法 / 路径 | 请求 | 成功 / 特殊行为 |
| --- | --- | --- |
| `GET /learning-profile` | 无 | 200 `Success<LearningProfile>`；首次 revision=1，goals=[]、careerDirection=""、skills=[] |
| `PUT /learning-profile` | `Update & ProfileFields`，所有五个业务字段必填 | 200 `Success<LearningProfile>`；事务写新修订，相关旧计划变 stale |
| `GET /learning-profile/revisions` | 通用分页 | 200 `Success<Page<ProfileRevision>>`，按 profileRevision DESC |

不重复保存相同值（revision 不增，但该 operationId 仍记录成功）。无效时区、0/121 分钟、小数预算、超长数组或空技能项为 422；并发配置为 409，不能覆盖另一页面修订。

例 PUT：`{"operationId":"op-profile-001","expectedRevision":1,"goals":["能独立解释并验证当前项目的设计取舍"],"careerDirection":"","skills":["技术写作"],"dailyBudgetMinutes":15,"timeZone":"Asia/Shanghai"}`。这是用户输入示例，不能作为初始目标植入产品。

## 5. 项目与检查点

```ts
type ProjectStatus = "active" | "maintenance" | "paused" | "archived";
type Project = Versioned & { id: Id; title: string; goal: string; status: ProjectStatus };
type Checkpoint = {
  id: Id;
  projectId: Id;
  progress: string;
  nextAction: string;
  openQuestion: string;
  createdAt: Instant;
};
```

| 方法 / 路径 | 请求 | 成功 |
| --- | --- | --- |
| `GET /projects` | 分页 + `q?`（title/goal）+ `status?:ProjectStatus` | 200 `Success<Page<Project>>`；未设 status 返回全部含归档 |
| `POST /projects` | `Mutation & {title:string,goal:string,status?:ProjectStatus}`，goal 0..2000、status 默认 active | 201 `Success<Project>` |
| `PATCH /projects/:id` | `Update & {title?:string,goal?:string,status?:ProjectStatus}`，至少一项 | 200 `Success<Project>` |
| `DELETE /projects/:id` | JSON `Update` | 200 `Success<{projectId:Id,status:"archived",revision:number}>`，只归档 |
| `GET /projects/:id/checkpoints` | 通用分页 | 200 `Success<Page<Checkpoint>>` |
| `POST /projects/:id/checkpoints` | `Mutation & {progress:string,nextAction:string,openQuestion:string}` | 201 `Success<Checkpoint>` |

检查点三个字段各 0..4000，至少一项非空。归档项目可读，不能新增检查点或默认计划项（409 INVALID_STATE）；可 PATCH 回其他状态后继续。四种项目状态可互转；删除归档保留关联知识、检查点、SiYuan 块及作业审计，再次归档不增 revision。不存在项目为 404，包括其子路径。

例：`POST /projects` body `{"operationId":"op-project-001","title":"当前项目复盘","goal":"记录可复用的设计决策","status":"active"}`；随后 checkpoint body `{"operationId":"op-checkpoint-001","progress":"已整理约束","nextAction":"验证一个失败场景","openQuestion":"超时后怎样确认是否提交？"}`。

## 6. 知识候选、决定和同步状态

```ts
type KnowledgeStatus = "draft" | "accepted" | "rejected" | "needs_recheck" | "archived";
type SyncState = {
  status: "not_synced" | "pending" | "synced" | "stale" | "uncertain" | "failed";
  lastSyncedRevision: number | null;
  lastSyncedAt: Instant | null;
  jobId: Id | null;
  lastError: Failure["error"] | null;
};
type Knowledge = Versioned & {
  id: Id;
  projectId: Id | null;
  question: string;
  answer: string;
  sourceRefs: SourceRef[];
  status: KnowledgeStatus;
  origin: "manual" | "codex" | "manual_dialogue" | "siyuan" | "feishu" | "backup";
  provenance: Provenance;
  siyuanBlockId: ExternalId | null;
  validation: Validation;
  lastDecision: {
    action: "accept" | "reject";
    actor: "user";
    operationId: OperationId;
    at: Instant;
  } | null;
  sync: SyncState;
};
type KnowledgeCreate = Mutation & {
  projectId: Id | null;
  question: string;
  answer: string;
  sourceRefs: SourceRefInput[];
};
type KnowledgePatch = Update & {
  projectId?: Id | null;
  question?: string;
  answer?: string;
  sourceRefs?: SourceRefInput[];
  status?: "draft" | "needs_recheck" | "archived";
  validation?: ValidationInput;
};
type KnowledgeRead = Knowledge & {
  readonly relevance: {
    status: "unconfigured" | "unmatched" | "matched";
    reason: string;
    matchedGoals: string[];
    matchedSkills: string[];
  };
};
```

| 方法 / 路径 | 请求 | 成功 |
| --- | --- | --- |
| `GET /knowledge` | 分页 + `q?`（question/answer/source title）+ `projectId?:Id` + `status?:KnowledgeStatus` + `sourceKind?:SourceKind` + `validationStatus?:ValidationInput["status"]` | 200 `Success<Page<KnowledgeRead>>`，过滤为 AND |
| `GET /knowledge/:id` | 无 body/query | 200 `Success<KnowledgeRead>` |
| `POST /knowledge` | `KnowledgeCreate` | 201 `Success<Knowledge>`，只能生成 draft，origin=manual |
| `PATCH /knowledge/:id` | `KnowledgePatch`，至少一项可写字段 | 200 `Success<Knowledge>` |
| `POST /knowledge/:id/decision` | `Update & {decision:"accept"|"reject"}` | 200 `Success<Knowledge>`；仅用户显式动作 |
| `POST /knowledge/:id/sync` | `Update` | 202 `Success<JobAck>`；见连接与作业章节 |

知识 GET 响应的 `relevance` 是按读取时当前 profile 派生的只读元数据：未配置明确目标为 `unconfigured`；已配置但目标/技能均无字面匹配为 `unmatched`；任一明确目标或技能有字面匹配为 `matched`。它仅含上述四个字段，不返回 `score` / `careerScore`，不表示事实正确性、技能掌握或全面语义判断。`relevance` 不接受写入，也不加入基础 `Knowledge` 或 `ExportData` 的导出记录字段。

sourceRefs=[] 的手工候选可保存并显示“无来源/待核验”，但显式 accept 必须至少有一个有效来源（手工引用也可以），否则 422 VALIDATION_ERROR；reject/归档可保留无来源历史。采集/服务导入的候选至少带一个来源。手动保存不要求模型或 SiYuan，provenance.mode=manual；模板/模型提取分别标明 provenance。origin、provenance、siyuanBlockId、lastDecision、sync、checkedAt/checkedBy 不可由客户端赋值。源变化不悄悄重写已审核答案。

| 当前状态 | 允许操作 / 结果 |
| --- | --- |
| draft | decision accept→accepted / reject→rejected；PATCH archived→archived |
| accepted | 编辑 question/answer/sourceRefs→needs_recheck；decision reject→rejected；PATCH needs_recheck/archived |
| rejected | PATCH status=draft 重新编辑；PATCH archived；不可直接 accept |
| needs_recheck | decision accept→accepted / reject→rejected；PATCH archived |
| archived | PATCH status=draft 恢复；不可直接 decision/sync |

纯 projectId 关联或用户显式 validation 更新不改变接受状态；validation 变更仍递增修订并使已同步元数据 stale。对同状态的同一决定可作为新用户审计事件但不制造第二张卡；同 operationId 严格重放。PATCH 不接受 accepted/rejected，防止绕过显式决定。question/answer/sourceRefs 内容变化或来源版本更新时，accepted 自动转 needs_recheck，验证重置 unverified（保留历史审计）；内容 PATCH 不得同时写 validation，422 拒绝，以便随后单独核查。已有块不自动改写。对 draft 的普通编辑仍为 draft。其余非法状态转移返回 409 INVALID_STATE。

sync 只允许当前 accepted 且期望修订匹配的 app-owned 知识；第一次明确同步可创建新的专用笔记本与目标块。接受动作不写 SiYuan；同步也不把来源原文搬写/覆写到原始笔记。同步之后编辑标记 stale。离线可以保留本地审核，sync 报 503 或持久化作业失败；可能已写入则 uncertain。客户端不得 PUT 任意块 ID 指定覆盖目标。

例创建：`{"operationId":"op-knowledge-001","projectId":null,"question":"请求超时是否代表远端没有提交？","answer":"不能据此判断，需要读取可关联的提交证据。","sourceRefs":[{"kind":"manual","title":"项目讨论记录","url":null,"excerpt":"超时与提交状态需要分别处理。"}]}`。

例接受：`{"operationId":"op-accept-001","expectedRevision":1,"decision":"accept"}`。例响应概要中的真实 DTO 字段应完整返回：`status=accepted` 可同时 `validation.status=unverified`、`siyuanBlockId=null`、`sync.status=not_synced`，不能显示“已验证且已同步”。

## 7. 连接、来源导入与 SiYuan 写入

```ts
type ConnectionStatus =
  | "not_configured" | "unchecked" | "connected" | "degraded"
  | "unavailable" | "incompatible" | "disabled";
type ConnectionBase = {
  status: ConnectionStatus;
  lastCheckedAt: Instant | null;
  lastError: Failure["error"] | null;
};
type SiYuanConnection = ConnectionBase & {
  kind: "siyuan";
  revision: number;
  configurationSource: "runtime" | "manual" | "none";
  configured: boolean;
  baseUrl: string | null; // 有效回环 URL，不含 token 或 tokenFile
  tokenConfigured: boolean;
  expectedVersion: "3.8.8";
  version: string | null;
  compatibility: "unchecked" | "compatible" | "incompatible";
  notebookTitle: string;
  notebook: { id: ExternalId; title: string; appOwned: true } | null;
  riff: { status: "unchecked" | "compatible" | "incompatible" | "unavailable"; reason: string | null };
};
type CodexConnection = ConnectionBase & {
  kind: "codex";
  configured: boolean;
  cliVersion: string | null;
  protocolVersion: string | null;
  capabilities: {
    threadList: boolean;
    threadRead: boolean;
    visibleMessages: boolean;
    forkAncestry: boolean;
  };
  scopeRevision: number;
  lastSyncAt: Instant | null;
};
type ModelConnection = ConnectionBase & {
  kind: "model";
  configured: boolean;
  enabled: boolean;
  endpoint: string | null;
  model: string | null;
  apiKeyConfigured: boolean;
  allowExternalProcessing: boolean;
};
type FeishuConnection = ConnectionBase & {
  kind: "feishu";
  configured: boolean;
  enabled: boolean;
  appId: string | null;
  appSecretConfigured: boolean;
  apiBase: "https://open.feishu.cn" | "https://open.larksuite.com";
};
type Connection = SiYuanConnection | CodexConnection | ModelConnection | FeishuConnection;
type Notebook = { id: ExternalId; name: string; closed: boolean; appOwned: boolean };
type CheckState = "passed" | "failed" | "not_checked";
type SiYuanCheck = {
  connection: SiYuanConnection;
  checks: { version: CheckState; auth: CheckState; notebooks: CheckState; riff: CheckState };
  notices: Notice[];
};
type SiYuanPut = Update & {
  useRuntimeConnection: boolean;
  baseUrl: string | null;
  notebookTitle: string;
  token?: string | null; // WRITE ONLY；不出现在任何响应中
};
type SourceImport = Mutation & { projectId: Id | null; extractCandidates?: boolean } & (
  | { kind: "siyuan_document"; documentId: ExternalId }
  | { kind: "siyuan_block"; blockId: ExternalId }
  | { kind: "feishu_document"; url: string }
);
type Source = SourceRef & {
  projectId: Id | null;
  text: string | null; // 已脱敏快照最多 1 MiB；仅引用/元数据恢复时为 null
  revision: number;
  updatedAt: Instant;
};
```

| 方法 / 路径 | 请求 | 成功 / 空状态 |
| --- | --- | --- |
| `GET /connections` | 通用分页 | 200 `Success<Page<Connection>>`；固定顺序 siyuan,codex,model,feishu，始终有四种状态记录 |
| `PUT /connections/siyuan` | `SiYuanPut` | 200 `Success<SiYuanConnection>`；保存配置后为 unchecked，不隐式建笔记本 |
| `POST /connections/siyuan/check` | `Mutation` | 200 `Success<SiYuanCheck>`，表示检查已完成；离线也返回检查项 failed/not_checked 和脱敏 lastError |
| `GET /siyuan/notebooks` | 通用分页 | 200 `Success<Page<Notebook>>`；空笔记本=[]；未配置/不可读为 503/403 |
| `POST /sources/import` | `SourceImport`，extractCandidates 默认 true | 202 `Success<JobAck>`，JobResult kind=source_import |
| `GET /sources` | 分页 + `q?`（title/text）+ `kind?:SourceKind` + `projectId?:Id` | 200 `Success<Page<SourceRef>>`；帮助用户选择已导入的来源 |
| `GET /sources/:id` | 无 query/body | 200 `Success<Source>`；只返回本地脱敏快照，未包含快照时 text=null，不存在为 404 |
| `POST /knowledge/:id/sync` | `Update` | 202 `Success<JobAck>`，JobResult kind=knowledge_sync |

useRuntimeConnection=true 时 baseUrl 必须 null，只读 `runtime/connection.json`，预期 `{baseUrl,version,tokenFile}`；清单缺失为 not_configured。false 时 baseUrl 必须是有效 `http://127.0.0.1:<port>`、`http://localhost:<port>` 或 `http://[::1]:<port>`（不得含路径前缀、query、userinfo）；手工 token 存本产品 data，不能改运行时文件。token 省略保留现有显式覆盖，null 删除覆盖后恢复可用的运行时令牌；token 字符串替换。绝不返回 token、tokenFile、mask 后的 token 片段。notebookTitle 必填 1..200，初始为“第二大脑”；一旦已有专用 notebook，修改名称不改变目标 ID，也不自动重命名外部笔记本。

notebooks 可列出用户可读笔记本，appOwned 只能由本产品映射和已验证的所有权标记判定。同名不能作为证据。不提供“把任意已有笔记本变成写入目标”的接口；第一次明确 sync 必须通过 SiYuan API 创建新的专用笔记本。连接检查不创建任何远端资源。导入 SiYuan 文档/块或飞书文档只读原始来源；不会接受知识、改原文、建卡或评分。

飞书导入只接受用户明确提供的 `https://<tenant>.feishu.cn/docx/<token>`、`.../wiki/<token>` 或对应 `*.larksuite.com` 地址，经选定区域服务 API 解析可读文档。禁止任意主机、重定向、下载文件路径和抓取内网 URL；权限不足为作业错误 SCOPE_FORBIDDEN，缺配置为 CONNECTION_UNAVAILABLE。单次最多 1 MiB 脱敏文本，超出限制明确失败，不静默截断为“完整导入”。

候选提取永不接受。无模型/未允许外部处理时，source_import/codex_sync 可以成功保存来源并返回 candidatesCreated=0 与 `MANUAL_REVIEW_REQUIRED` notice；用户用 sources 选择来源手工创建知识。若使用本地模板产生 draft，必须保存真实来源并标明模板，不能把模板当核查结论。

sync 调用把指定知识修订的 app-owned 文档/块写入新专用笔记本，持久化 mapping/摘要；已映射块的修改也只能更新本产品所有权。作业开始前再检查 accepted/revision/所有权，不匹配则失败且不写。写后本地事务丢失或响应超时进入 uncertain；读取唯一操作/知识标记才能确认。未确认前再次 sync 返回 409 RECONCILIATION_REQUIRED。原始来源绝不作为覆盖目标。

例配置：`{"operationId":"op-siyuan-001","expectedRevision":1,"useRuntimeConnection":true,"baseUrl":null,"notebookTitle":"第二大脑"}`；例导入：`{"operationId":"op-source-001","projectId":null,"kind":"siyuan_block","blockId":"20261027090000-abcdefg","extractCandidates":false}`；例异步响应：`{"data":{"jobId":"job_import_001","operationId":"op-source-001"}}`。

## 8. Codex 授权范围、只读同步与手动后备

```ts
type CodexScopeFields = {
  enabled: boolean;
  allowedThreadIds: ExternalId[]; // 最多 1000
  allowedProjectPaths: string[]; // 最多 100；只选择用户授权项目
  excludedThreadIds: ExternalId[]; // 最多 1000，优先于允许
  excludedProjectPaths: string[]; // 最多 100，优先于允许
  includeArchived: boolean;
  allowManualImports: boolean;
};
type CodexScope = CodexScopeFields & Versioned;
type CodexThread = {
  id: ExternalId;
  title: string;
  projectPath: string | null;
  archived: boolean;
  allowed: boolean; // 已授权列表始终为 true；发现列表按当前有效授权计算
  createdAt: Instant;
  updatedAt: Instant;
  lastSyncedAt: Instant | null;
  parentThreadId: ExternalId | null;
  ancestryVerified: boolean;
};
type ManualDialogueImport = Mutation & {
  projectId: Id | null;
  title: string;
  externalSourceId: ExternalId; // 用户稳定保留，不能每次导入随机生成
  messages: {
    sourceMessageId: ExternalId; // 此手动来源内稳定且唯一
    role: "user" | "assistant";
    content: string;
    occurredAt: Instant | null;
  }[];
};
```

| 方法 / 路径 | 请求 | 成功 |
| --- | --- | --- |
| `GET /connections/codex/scope` | 无 | 200 `Success<CodexScope>` |
| `PUT /connections/codex/scope` | `Update & CodexScopeFields`（七个范围字段全量提供） | 200 `Success<CodexScope>`；记录修订 |
| `GET /codex/discovery` | `days?:integer`（1..30，默认 7）、`limit?:integer`（1..50，默认 20） | 200 `Success<Page<CodexThread>>`；显式浏览近期元数据，`total` 为本次有界返回数量 |
| `GET /codex/threads` | 分页 + `q?`（title）+ `projectPath?:string` | 200 `Success<Page<CodexThread>>`；仅列授权范围的元数据 |
| `POST /codex/sync` | `Mutation & {threadIds?:ExternalId[],projectId?:Id|null,maxThreads?:number,maxMessages?:number}` | 202 `Success<JobAck>`，kind=codex_sync |
| `POST /codex/manual-import` | `ManualDialogueImport` | 202 `Success<JobAck>`，kind=manual_dialogue_import；明确的可选后备 |

初始 enabled=false、所有集合为空、includeArchived=false、allowManualImports=true。enabled=false 或正向范围均为空时 GET threads 返回空列表，不启动读取；显式 sync 为 403 SCOPE_FORBIDDEN。已启用但本机不可用为 503 CONNECTION_UNAVAILABLE，缺只读接口为 503 CAPABILITY_UNSUPPORTED；不调用 resume 作为读取手段。

`GET /codex/discovery` 是独立的显式浏览入口，在页面点击「查看近期对话」后调用，不随页面挂载自动执行。它允许尚未启用或正向范围为空的用户浏览近期标题或短预览、项目路径与时间，便于选择对话；不读取完整正文、不保存来源/知识/游标/连接检查、不修改采集范围。返回复用 `CodexThread`，`allowed` 按当前有效授权计算，未授权项为 false；不返回独立 preview 字段或消息正文。标题沿用脱敏和 200 字符上限。负向排除、归档设置及范围修订仍有效，修订变化后中止该次浏览。

发现请求只使用已核验 `useStateDbOnly=true` 的 `thread/list` 与必要初始化，所有列表尝试共享最多 5 页预算；不回退到正文、resume 或扫描会话文件。参数必须为边界内整数，未知参数拒绝。返回列表有界，不代表完整历史数量。发现列表中的 ID 本身不构成采集授权：前端需经明确「保存所选对话」调用原 `PUT /connections/codex/scope`，再显式同步。旧 `GET /codex/threads` 和同步接口的授权限制保持不变。

allowlist 为“匹配 thread ID **或**匹配 allowedProjectPaths 边界内的项目”，然后应用 thread/path 排除及 archived 规则。路径要求绝对本地路径，规范化分隔符、Windows 大小写及真实路径边界，解析失败为 422；不递归扫描目录文件。projectPath query 只能收窄已授权范围，不能扩大。指定 threadIds 含任意不授权项则整个请求 403，不先处理一部分。projectId 是本产品的关联，不是 Codex 项目授权依据。撤销范围后停止后续读取/排队任务，不抹除已有审计及审核知识。

maxThreads 默认 20，范围 1..100；maxMessages 默认 500，范围 1..1000，为单作业总上限。超出本次额度不删除/跳过剩余数据，返回 hasMore=true；检查点只推进到已事务保存的事件，后续 sync 接续。未提供 threadIds 时选授权的有更新线程，按 updatedAt DESC,id ASC 有界处理。

适配器必须记录 CLI/协议版本和能力，仅读取经本机 schema/handshake 核验的 `thread/list` 与 `thread/read`（及必要初始化握手）。thread/list 必须支持并使用 `useStateDbOnly=true`，避免其默认扫描/修复元数据；无法保证只读则 CAPABILITY_UNSUPPORTED。不得使用 start/resume/turn/fork/archive/执行类方法。只捕获 user 和 assistant 最终可见材料；排除 reasoning、系统/开发者文本、工具完整日志和凭据。未显式配置模型外发时只本地处理，不以采集授权推导上传授权。

当前已按本机 CLI **0.164.0、0.165.0** 生成的 `ThreadListParams` 核验 `useStateDbOnly` 为布尔参数，其 true 语义为从状态数据库返回、跳过 JSONL 扫描与元数据修复。仅识别精确的已核验版本标记；未知版本仍须提供明确的能力声明，否则拒绝标题与正文读取。后续 CLI 升级需重新核验此契约。

去重键是来源身份，不是全文 hash：稳定 threadId+messageId 定位事件，SHA-256 摘要检测事件更新；同一线程两个相同文本的独立 messageId 均保留。fork 只有在可信祖先关系、有序源事件与前缀摘要均对应时，才建立 inherited alias；无祖先证据的独立同文线程保留，不能删除。部分列表、暂时不可见消息、授权撤销不触发历史删除。来源变化保留版本，关联 accepted 知识变 needs_recheck，不覆盖用户答案。

手动后备仅在 allowManualImports=true 时可用，不要求 app-server 或外部模型。messages 为 1..500 条，每条非空 content 最多 20000 字符，总请求仍限 1 MiB；只允许两个 role，sourceMessageId 来源内唯一。使用 `(manual_dialogue, externalSourceId, sourceMessageId)` 幂等采集，修改内容建新版本；不从相同文本推断 fork。输入不得夹带完整日志/秘密；服务端仍按同一规则脱敏。origin/SourceKind 均是 manual_dialogue，UI 不能显示“自动采集成功”。

例范围：`{"operationId":"op-scope-001","expectedRevision":1,"enabled":true,"allowedThreadIds":["thread-selected-1"],"allowedProjectPaths":[],"excludedThreadIds":[],"excludedProjectPaths":[],"includeArchived":false,"allowManualImports":true}`。

例同步：`{"operationId":"op-codex-001","threadIds":["thread-selected-1"],"projectId":null,"maxThreads":1,"maxMessages":100}`。例手动：`{"operationId":"op-dialogue-001","projectId":null,"title":"用户手动选择的讨论","externalSourceId":"manual-discussion-1","messages":[{"sourceMessageId":"message-1","role":"user","content":"怎样验证超时后的提交状态？","occurredAt":null}]}`。

## 9. 设置与秘密写入

```ts
type ModelSettings = {
  enabled: boolean;
  provider: "openai-compatible";
  endpoint: string | null;
  model: string | null;
  apiKeyConfigured: boolean;
  allowExternalProcessing: boolean;
};
type FeishuSettings = {
  enabled: boolean;
  appId: string | null;
  appSecretConfigured: boolean;
  apiBase: "https://open.feishu.cn" | "https://open.larksuite.com";
};
type SchedulerSettings = {
  enabled: boolean;
  codexSyncEnabled: boolean;
  dailyPlanEnabled: boolean;
  codexSyncIntervalMinutes: number; // 整数 5..1440，默认 60
  dailyPlanLocalTime: string; // 严格 HH:mm，默认 09:00，使用 profile 时区
  catchUpEnabled: boolean;
};
type Settings = Versioned & {
  model: ModelSettings;
  feishu: FeishuSettings;
  scheduler: SchedulerSettings;
};
type SettingsPut = Update & {
  model: Omit<ModelSettings, "apiKeyConfigured"> & { apiKey?: string | null };
  feishu: Omit<FeishuSettings, "appSecretConfigured"> & { appSecret?: string | null };
  scheduler: SchedulerSettings;
};
```

| 方法 / 路径 | 请求 | 成功 |
| --- | --- | --- |
| `GET /settings` | 无 | 200 `Success<Settings>`，只有 configured flags |
| `PUT /settings` | `SettingsPut`，三个配置对象及所有非秘密字段必填 | 200 `Success<Settings>`，持久化配置修订；不回显秘密 |

初始 model enabled=false、endpoint/model=null、apiKeyConfigured=false、allowExternalProcessing=false；feishu enabled=false、appId=null、appSecretConfigured=false、apiBase 为 open.feishu.cn；scheduler 的四个布尔字段均 false，interval=60、localTime=09:00。ModelSettings.provider 仅是线协议选项，不代表已验证任意服务兼容。endpoint 是完整的 API base URL，最多 2048 字符；启用模型时 endpoint/model 必须非空。非回环 endpoint 仅允许 https，且 allowExternalProcessing=true 才能传输任务内容。回环 http 模型可不设 key，但仍需 enabled=true。不能因输入 URL 含秘密而绕过写-only 规则。

飞书 enabled=true 需要 appId 与已配置的 appSecret；只通过该区域服务 API 换取令牌和读取明确选中的文档。缺少配置不影响手工知识/计划模板/练习/写作/本地导出。PUT 只改本地配置，不做自动远端生成、消息发送或数据上传。

秘密省略=保留，null=删除，非空字符串=替换；响应没有 apiKey/appSecret/token 字段，更不含其部分值。更新日志只记录字段名/操作 ID，不记值。错误、模型 trace、作业 payload、导出、fixtures 都不得带真实秘密；本地 secret 文件必须限制为当前 OS 用户可读，若权限设置失败则拒绝写入并报告脱敏错误。

例无密钥设置：`{"operationId":"op-settings-001","expectedRevision":1,"model":{"enabled":false,"provider":"openai-compatible","endpoint":null,"model":null,"allowExternalProcessing":false},"feishu":{"enabled":false,"appId":null,"apiBase":"https://open.feishu.cn"},"scheduler":{"enabled":false,"codexSyncEnabled":false,"dailyPlanEnabled":false,"codexSyncIntervalMinutes":60,"dailyPlanLocalTime":"09:00","catchUpEnabled":false}}`。

## 10. 每日计划、练习、尝试、反馈和写作

```ts
type PlanItem = {
  id: Id;
  kind: "review" | "practice" | "output";
  title: string;
  goal: string | null;
  skill: string | null;
  offsetMinutes: number; // 从本次学习开始计的分钟偏移，不是假日历预约
  estimatedMinutes: number; // 整数 >=1
  knowledgeIds: Id[];
  practiceId: Id | null;
  outputId: Id | null;
  reviewLimit: number | null;
  state: "pending" | "completed" | "blocked";
  provenance: Provenance;
};
type DailyPlan = {
  id: Id | null;
  revision: number;
  date: LocalDate;
  timeZone: string;
  profileRevision: number | null;
  budgetMinutes: number;
  scheduledMinutes: number;
  unallocatedMinutes: number;
  reviewDueCount: number | null;
  status: "not_generated" | "ready" | "completed" | "blocked" | "stale";
  items: PlanItem[];
  notices: Notice[];
  generationJobId: Id | null;
  createdAt: Instant | null;
  updatedAt: Instant | null;
};
type RubricCriterionInput = { label: string; description: string; expectedEvidence: string[] };
type RubricCriterion = RubricCriterionInput & { id: Id };
type Practice = Versioned & {
  id: Id;
  projectId: Id | null;
  kind: "explanation" | "new_scenario" | "artifact";
  goal: string; // 1..500，用户明确目标
  skill: string; // 0..500，允许未指定
  prompt: string; // 1..10000
  estimatedMinutes: number; // 整数 1..120
  rubric: RubricCriterion[]; // 1..10
  sourceRefs: SourceRef[];
  provenance: Provenance;
  status: "open" | "completed";
};
type PracticeListItem = Practice & { readonly selectionReason?: string };
type PracticeCreate = Mutation & {
  projectId: Id | null;
  kind: Practice["kind"];
  goal: string;
  skill: string;
  prompt: string;
  estimatedMinutes: number;
  rubric: RubricCriterionInput[];
  sourceRefs: SourceRefInput[];
};
type AssistanceLevel = "none" | "hint" | "partial" | "full";
type EvidenceSnapshot = {
  reference: EvidenceRef;
  revision: number | null;
  digest: string | null;
  text: string | null;
  capturedAt: Instant;
};
type Observation = {
  criterionId: Id;
  finding: "met" | "partial" | "not_met" | "not_assessed";
  comment: string;
  evidenceRefs: EvidenceRef[];
};
type Feedback = {
  id: Id;
  attemptId: Id;
  mode: "manual" | "template" | "model";
  basis: "user_judgment" | "deterministic_checklist" | "model_suggestion";
  summary: string;
  observations: Observation[];
  nextActions: string[];
  limitations: string[];
  provenance: Provenance;
  createdAt: Instant;
};
type Attempt = {
  id: Id;
  practiceId: Id;
  output: string;
  assistanceLevel: AssistanceLevel;
  evidenceRefs: EvidenceRef[];
  evidenceSnapshots: EvidenceSnapshot[];
  submittedAt: Instant;
  feedback: Feedback | null; // 最近一次反馈，历史保留用于导出/审计
};
type Output = Versioned & {
  id: Id;
  projectId: Id | null;
  practiceId: Id | null;
  title: string;
  content: string; // draft 可以为空，final 必须非空，最多 100000
  goal: string; // 0..500
  status: "draft" | "final"; // final 只是本地完成，不向外发布
  sourceRefs: SourceRef[];
  evidenceRefs: EvidenceRef[];
};
type OutputFields = {
  projectId: Id | null;
  practiceId: Id | null;
  title: string;
  content: string;
  goal: string;
  status: "draft" | "final";
  sourceRefs: SourceRefInput[];
  evidenceRefs: EvidenceRef[];
};
```

| 方法 / 路径 | 请求 | 成功 / 空状态 |
| --- | --- | --- |
| `GET /daily-plan` | `date?:LocalDate`、`timeZone?:string`，默认当前 profile 时区的今天 | 200 `Success<DailyPlan>`；不存在为 not_generated，不是伪造任务 |
| `POST /daily-plan/generate` | `Mutation & {date?:LocalDate,expectedProfileRevision:number,expectedPlanRevision:number,mode?:"template"|"model",allowTemplateFallback?:boolean}` | 202 `Success<JobAck>`，kind=daily_plan_generate |
| `GET /practices` | 分页 + `q?`（prompt/goal/skill）+ `projectId?:Id` + `kind?:Practice["kind"]` + `status?:Practice["status"]` | 200 `Success<Page<PracticeListItem>>` |
| `POST /practices` | `PracticeCreate`，手动练习补充路径 | 201 `Success<Practice>`，provenance.mode=manual |
| `POST /practices/:id/attempts` | `Mutation & {output:string,assistanceLevel:AssistanceLevel,evidenceRefs:EvidenceRef[]}` | 201 `Success<Attempt>` |
| `GET /practices/:id/attempts` | 通用分页，按 submittedAt DESC,id ASC | 200 `Success<Page<Attempt>>`，刷新后恢复真实尝试/反馈 |
| `POST /attempts/:id/feedback` | `Mutation & {mode:"template"|"model"|"manual",allowTemplateFallback?:boolean,manual?:{summary:string,observations:Observation[],nextActions:string[],limitations:string[]}}` | 202 `Success<JobAck>`，kind=practice_feedback |
| `GET /outputs` | 分页 + `q?`（title/content/goal）+ `projectId?:Id` + `practiceId?:Id` + `status?:Output["status"]` | 200 `Success<Page<Output>>` |
| `POST /outputs` | `Mutation & OutputFields`，八个业务字段全量提供 | 201 `Success<Output>` |
| `PATCH /outputs/:id` | `Update & Partial<OutputFields>`，至少一项业务字段 | 200 `Success<Output>` |

`GET /practices` 的 `selectionReason` 是可选只读字符串，仅在已存 `provenance.label` 非空时返回；标签缺失或为空字符串时省略。它直接读取创建时冻结的标签（可能附有当时的选材理由），不随当前 profile 改变而重算；`POST /practices` 仍返回基础 `Practice`。`selectionReason` 不接受写入，也不加入 `ExportData` 的练习记录字段；原有 `provenance.label` 仍照常导出。

### 计划是真实的有界安排

generate 的 date 默认今天，只允许**当前 profile 时区的今天**，不预测未来到期卡或补造过去学习记录；历史 GET 可读取任意有效日期和已保存时区。expectedPlanRevision 取 GET 的 revision，未生成为 0。生成时用匹配的 profile/plan 修订，任何一方在入队后变化则作业 409 REVISION_CONFLICT，不覆盖新版本。mode 默认 template，allowTemplateFallback 默认 true；显式 model 不可用且不允许回退时，作业 MODEL_UNAVAILABLE。回退时 provenance=template 并给出 TEMPLATE_FALLBACK。

同一 `(date,timeZone)` 只有一份当前计划。items 按 offsetMinutes 连续排列，第一个 offset=0；每项 estimatedMinutes 是正整数，scheduledMinutes 等于估时总和，`scheduledMinutes <= budgetMinutes`，unallocatedMinutes=budgetMinutes-scheduledMinutes。估时是安排，不宣称用户实际耗时。小预算只能排下能在该预算内开始完成的短模板/已有任务，其余明确省略，不使用固定 15 分钟覆盖用户设置。

review 项必须来自当前经兼容 Riff API 读取的真实到期集合，reviewLimit=1..100，practiceId/outputId=null；Riff 离线时 reviewDueCount=null，省略/阻塞 review 项并给出 SIYUAN_UNAVAILABLE，不能写假“0 张到期”。practice 项必须有已保存的 practiceId，reviewLimit/outputId=null；output 项必须引用已有本地 draft outputId，practiceId/reviewLimit=null。所有 knowledgeIds 必须真实存在且适合当前项目/状态。

目标明确时，每次日计划优先包含一个可行的短 explanation/new_scenario/artifact 练习，可复用当天未完成练习，不重复造任务；引用已接受知识及明确目标。没有已接受知识时可基于用户明确目标创建“提交一个可检查产物”的模板，provenance 只引用 profileRevision，不伪造技术结论/来源。目标为空时不生成针对性职业练习，给出 NO_GOALS；真实到期复习或已有写作仍可安排。没有任何可行动数据时 status=blocked、items=[]、scheduledMinutes=0，不能填充示例卡片。

首次 GET 无计划：id=null、revision=0、profileRevision=null、status=not_generated、items=[]、scheduledMinutes=0、unallocatedMinutes=当前预算、generationJobId=null、createdAt/updatedAt=null；date/timeZone 为查询值，reviewDueCount 若未检查为 null。入队后 generationJobId 可指向真实 job，不能伪装 ready。改变目标/预算/时区使受影响旧计划 stale，不改变历史已完成证据；再次生成保留已完成项并计入当前预算。若已完成项的原估时已超出新预算，生成作业失败 INVALID_STATE，不新增任务；GET 保留原预算的 stale 历史及 BUDGET_EXHAUSTED notice，新预算从下一日安排生效。任何成功生成的计划均严格使用匹配配置预算，不造负数或超额分钟。

计划项完成来自已确认的复习记录、提交的练习尝试或 final 输出；完成练习仅表示已提交，不代表技能掌握。daily plan 不读写 Riff 的间隔或下次到期时间。

### 练习、辅助与反馈

Rubric 每项 label 为 1..200，description 为 1..2000，expectedEvidence 为 0..10 个非空字符串（每项 <=500）；由服务端生成 criterion ID。模板/模型练习必须保存 rubric、来源、具体目标与生成方式。手动创建可完全无密钥，goal 必须是用户明确输入；不能从 careerDirection 自动补造职业。

Attempt.output 为 1..100000，assistanceLevel 必填：none=独立完成，hint=只用提示，partial=借助部分内容，full=主要依赖给定答案/生成内容。四者均可提交，呈现时保持区分，不把 full 当独立证据。Attempt 不可修改，重做产生新 attempt；首次有效提交使 practice status 从 open→completed，后续允许再尝试，不改写过去输出。不存在练习/尝试为 404。

提交时对已有 source/output 证据保存脱敏快照和 digest/revision，每个 text 最多 20000 字符、总快照上限 1 MiB；超限明确 413，不偷偷以完整证据标签截断。URL 引用不自动抓取，text/digest/revision=null；必须在反馈中标明未检查该 URL 内容。写作后续修改不会改变过去尝试证据。feedback 以该次 output、assistanceLevel、rubric 和快照为依据。

manual 模式必须提供 manual 对象，其他模式禁止该字段。每个 rubric criterion 在 observations 中恰好一次，不得引用别的 rubric；comment 0..4000，summary 1..4000，nextActions/limitations 各 0..10 个 <=2000 字符项。manual 的 basis=user_judgment，属于用户判断；template 的 basis=deterministic_checklist，finding 全为 not_assessed，仅列可机械检查的提交/引用存在性及待验证证据；model 的 basis=model_suggestion，结论必须关联真实输出片段或证据。任何模式都不返回“掌握百分比”、虚构 AI 评分或自动事实验证。

反馈 allowTemplateFallback 默认 true。model 缺失/失败可生成明确标注的模板反馈（mode/basis/provenance 都为 template），并说明限制；false 时作业报 MODEL_UNAVAILABLE 或脱敏上游错误，不伪装生成成功。一个 attempt 可有多份新反馈，GET attempts.feedback 为最近版本；同 operationId 不重复创建。反馈不自动接受知识、不更新职业能力等级、不改 Riff。

### 输出

写作无需模型、SiYuan 或飞书。status draft↔final 可转换，title 必填、final 内容非空；PATCH 受 revision 约束。practiceId/projectId 关联必须存在；归档项目可保留/编辑既有输出，但不自动加入新计划。不实施外部发布。若用户希望评价写作，可将其作为 practice attempt 的 output 或 output evidenceRef 提交，再请求反馈。

例计划：`{"operationId":"op-plan-001","date":"2026-10-27","expectedProfileRevision":2,"expectedPlanRevision":0,"mode":"template","allowTemplateFallback":true}`。

例练习提交：`{"operationId":"op-attempt-001","output":"我会先记录操作身份，再读取能关联该操作的提交证据；没有证据时保留不确定状态。","assistanceLevel":"none","evidenceRefs":[]}`；例反馈：`{"operationId":"op-feedback-001","mode":"template"}`。

例写作创建：`{"operationId":"op-output-001","projectId":null,"practiceId":null,"title":"一次设计取舍的说明","content":"","goal":"","status":"draft","sourceRefs":[],"evidenceRefs":[]}`。没有输出时 GET outputs 的 items=[]，不能显示虚构历史。

## 11. SiYuan Riff 复习会话

```ts
type ReviewRating = "again" | "hard" | "good" | "easy";
type ReviewSession = {
  id: Id;
  projectId: Id | null;
  deckId: ExternalId;
  limit: number;
  reviewedCount: number;
  status: "active" | "completed" | "blocked" | "uncertain";
  pendingJobId: Id | null;
  lastResponseId: Id | null;
  createdAt: Instant;
  updatedAt: Instant;
};
type ReviewNext =
  | { state: "question"; session: ReviewSession; card: {
      presentationId: Id; cardId: ExternalId; knowledgeId: Id; question: string; revealed: boolean;
    } }
  | { state: "empty"; session: ReviewSession; reason: "no_due_cards" | "session_limit_reached" }
  | { state: "blocked"; session: ReviewSession; failure: Failure["error"] }
  | { state: "rating_pending" | "uncertain"; session: ReviewSession; jobId: Id };
type RevealedCard = {
  session: ReviewSession;
  presentationId: Id;
  cardId: ExternalId;
  knowledgeId: Id;
  question: string;
  answer: string;
  sourceRefs: SourceRef[];
  validation: Validation;
};
type ReviewResponse = {
  id: Id;
  sessionId: Id;
  presentationId: Id;
  cardId: ExternalId;
  knowledgeId: Id;
  rating: ReviewRating;
  elapsedMs: number;
  operationId: OperationId;
  status: "confirmed";
  committedAt: Instant;
  riffEvidence: {
    method: "response" | "read_after_write";
    externalResponseId: ExternalId | null;
    checkedAt: Instant;
  };
};
```

| 方法 / 路径 | 请求 | 成功 |
| --- | --- | --- |
| `POST /review-sessions` | `Mutation & {projectId:Id|null,limit?:number}`，limit 默认 10、1..100 | 201 `Success<ReviewSession>`；同项目已有可恢复会话则 200 返回该会话，保留原 limit |
| `GET /review-sessions/:id/next` | 无 query/body | 200 `Success<ReviewNext>`，任何分支都不含 answer/source excerpts/validation |
| `POST /review-sessions/:id/reveal` | `Mutation & {presentationId:Id,cardId:ExternalId}` | 200 `Success<RevealedCard>`；持久化本次 reveal |
| `POST /review-sessions/:id/responses` | `Mutation & {presentationId:Id,cardId:ExternalId,rating:ReviewRating,elapsedMs:number}` | 202 `Success<JobAck>`，kind=review_response |

会话仅包含本产品专用 Riff deck 中已同步、仍 accepted 的 app-owned 知识。projectId=null 表示全部；非空必须存在。不兼容 3.8.8/无评分能力为 503 RIFF_INCOMPATIBLE；未连接为 503 CONNECTION_UNAVAILABLE；没有卡是正常 empty。服务端不可为展示效果返回样例卡/到期数量。

next 对当前未评分 presentation 始终返回同一 question，直到确认评分或会话结束；重复 GET/reload 不跳卡。即使已 reveal，GET next 仍无答案，revealed=true 允许客户端再次显式 reveal 恢复界面。每次呈现分配 presentationId，Riff 再次给出同一 cardId 时产生新的 presentationId，不能把两次真实复习误判为重复。

reveal 只允许当前 presentation/card 组合；responses 必须已经 reveal，且 card、presentation、会话均匹配。未 reveal/过期 presentation 为 409 INVALID_STATE。elapsedMs 为整数 0..3600000，表示本次可见活跃耗时，不是技能分数。不同 operationId 双击相同 presentation/rating/elapsedMs 也复用第一次评分 job；若改变 grade/elapsedMs 则 409 INVALID_STATE，不发生第二次评分。只有已明确调和为 not_committed 的前次操作，才允许新的用户动作再次提交同 presentation；uncertain 绝不例外。

| rating | 中文语义 | 记录的性质 |
| --- | --- | --- |
| again | 未能正确回忆，需要再学 | 记忆自评 |
| hard | 正确回忆，但很费力 | 记忆自评 |
| good | 正确回忆，难度适中 | 记忆自评 |
| easy | 立即且轻松地正确回忆 | 记忆自评 |

前端只发送语义字符串，不发送 SiYuan 数值评级。后端必须在固定 3.8.8 核验映射，不猜值、不替换调度算法。评分作业在远端确认后才增加 reviewedCount、写 confirmed response 并允许 next；Riff 仍决定下一张/到期时间。completed 不可继续 reveal/评分；重新开始新会话。

评分请求可能已发出后断线/超时/进程退出：job.status=uncertain，session.status=uncertain，next.state=uncertain，只给 jobId。UI 禁用重复评分，展示“提交状态待核对”。相同 operationId 返回原 job，不重发。涉及同一卡片/deck 的新评分受锁阻止，返回 REVIEW_COMMIT_UNCERTAIN。安全调和只读原生 API 可关联的提交证据，不能仅凭到期时间变化猜是该操作；无法证明就保持 uncertain，并提示检查原生 SiYuan。不得向用户假报已失败并建议重新点。

例创建：`{"operationId":"op-review-session-001","projectId":null,"limit":5}`；例 next：

```json
{"data":{"state":"question","session":{"id":"rs_1","projectId":null,"deckId":"deck-app-owned","limit":5,"reviewedCount":0,"status":"active","pendingJobId":null,"lastResponseId":null,"createdAt":"2026-10-27T01:00:00.000Z","updatedAt":"2026-10-27T01:00:00.000Z"},"card":{"presentationId":"present_1","cardId":"card-1","knowledgeId":"kn_1","question":"请求超时能证明什么？","revealed":false}}}
```

例 reveal：`{"operationId":"op-reveal-001","presentationId":"present_1","cardId":"card-1"}`；例评分：`{"operationId":"op-rate-001","presentationId":"present_1","cardId":"card-1","rating":"good","elapsedMs":12000}`。不能提前把 Knowledge DTO、答案、来源摘录或隐藏 DOM 文本放进 next 响应/前端页面。

## 12. 持久化作业、调度与不确定提交

```ts
type JobType =
  | "codex_sync" | "manual_dialogue_import" | "source_import" | "knowledge_sync"
  | "daily_plan_generate" | "practice_feedback" | "review_response" | "reconcile";
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "uncertain" | "cancelled";
type CommitState = "not_applicable" | "not_started" | "may_have_committed" | "confirmed" | "not_committed";
type CollectorCheckpoint = {
  sourceKey: string; // 稳定来源身份，不含正文/令牌
  lastMessageId: ExternalId | null;
  digest: string;
  updatedAt: Instant;
};
type CollectionResult = {
  kind: "codex_sync" | "manual_dialogue_import";
  sourcesCreated: number;
  sourcesUpdated: number;
  inheritedAliasesCreated: number;
  candidatesCreated: number;
  knowledgeIds: Id[];
  hasMore: boolean;
  checkpoints: CollectorCheckpoint[];
  notices: Notice[];
};
type JobResult =
  | CollectionResult
  | { kind: "source_import"; sourceIds: Id[]; knowledgeIds: Id[]; candidatesCreated: number; notices: Notice[] }
  | { kind: "knowledge_sync"; knowledgeId: Id; knowledgeRevision: number; siyuanBlockId: ExternalId;
      notebookId: ExternalId; cardId: ExternalId; syncedAt: Instant }
  | { kind: "daily_plan_generate"; plan: DailyPlan }
  | { kind: "practice_feedback"; feedback: Feedback }
  | { kind: "review_response"; response: ReviewResponse }
  | { kind: "reconcile"; originalJobId: Id;
      resolution: "confirmed" | "not_committed" | "still_uncertain" | "conflict";
      checkedAt: Instant; reason: string };
type Job = {
  id: Id;
  type: JobType;
  trigger: "user" | "scheduler" | "recovery";
  status: JobStatus;
  commitState: CommitState;
  operationId: OperationId;
  parentJobId: Id | null; // reconcile 指向原 job
  progress: { completed: number; total: number | null; unit: "threads" | "messages" | "items" | "steps" };
  attemptCount: number;
  createdAt: Instant;
  startedAt: Instant | null;
  updatedAt: Instant;
  finishedAt: Instant | null;
  error: Failure["error"] | null;
  result: JobResult | null;
};
```

| 方法 / 路径 | 请求 | 成功 |
| --- | --- | --- |
| `GET /jobs/:id` | 无 query/body | 200 `Success<Job>`；不存在 404，错误作业仍为 200 且 data.error 有值 |
| `GET /jobs` | 分页 + `status?:JobStatus` + `type?:JobType` | 200 `Success<Page<Job>>`，便于重启后查看真实任务 |
| `POST /jobs/:id/reconcile` | `Mutation`；只允许 uncertain 的外部写作业 | 202 `Success<JobAck>`，新 reconcile job 以 parentJobId 指向原 job，只做读取 |

后台操作入队前验证本地参数/配置/权限；明显无配置可以立即返回表中的 4xx/503，不制造必然成功的 job。已返回 202 后，上游错误写入 Job.error；succeeded 要有对应 result，failed/blocked/uncertain 不能把空 result 当成功。进度 completed 为非负整数，total 未知为 null，已知时 `0 <= completed <= total`；不能按定时器伪造进度百分比。客户端按 1s 起步、最长 5s 间隔轮询，离开页面停止轮询不取消任务。

状态：queued→running→succeeded/failed/blocked/uncertain；queued 可因授权撤销→cancelled；blocked 表示明确等待服务/配置、没有不明副作用，安全检查恢复后才可再排队；uncertain 只能经读取证据变为 succeeded 或 failed，不能直接变 queued。新 reconcile job succeeded 只表示完成检查，若 resolution=still_uncertain/conflict，原 job 仍 uncertain。

commitState 区分是否可能产生外部副作用；纯读取/本地作业为 not_applicable，外部写入排队时 not_started，发出前持久化 may_have_committed，确认后 confirmed。明确证明未提交则 not_committed。重启看到 running+may_have_committed 必须恢复成 uncertain；本地事务/只读任务可以检查 checkpoint 后安全恢复，不从 0 再制造来源或候选。

同一 operationId 复用同一任务；不同 ID 的相同类型/范围活跃任务返回 409 JOB_OVERLAP。范围键为 collector 的已选来源范围、plan 的 date/timeZone、sync 的 knowledgeId，Riff 写入额外使用 app deck 的串行锁。数据库唯一锁+lease 和持久化操作登记不能只靠进程内布尔值；单 worker 串行执行，排队上限 100，超出为 429 RATE_LIMITED。lease 过期只允许恢复者接管，不能据此推断外部未提交。

安全读取瞬时错误最多自动重试一次（总尝试 2）；鉴权/校验/能力错误不重试。可能已经提交的写入绝不自动重放。reconcile 读取唯一标记或可关联的版本证据，不能把“到期变化/时间接近”当成唯一评分证据：

- confirmed：原作业 succeeded、commitState=confirmed，原结果和会话推进在本地事务中完成一次。
- not_committed：原作业 failed、commitState=not_committed，释放阻塞；只有用户看见此结论后的新显式动作可用新 operationId 再提交，原 ID 仍返回原 job。
- still_uncertain / conflict：保持原作业/会话 uncertain，禁止同 presentation/card/deck 的再次写入，提示原生检查。没有手工“强制成功”接口。

knowledge_sync 的阶段是专用 notebook/文档/块、app-owned Riff deck/card 的创建/更新与最终映射，每步持久化标记；只能在受支持 API 下执行。同步目标 accepted 知识对应一张 app-owned 卡；幂等重放不重复建卡。中途失败保留已确认映射，未确认步骤走调和，不删除原生数据或整个 notebook。lastSyncedRevision 只在所需步骤确认后更新。

调度不是复习算法。scheduler.enabled=false 时没有定时采集/生成；开启具体 flags 后，只自动做已授权 codex_sync 和模板 daily_plan_generate，不自动接受、向 SiYuan 同步、调用评分或外发模型请求。采集周期按持久化 UTC slot，日计划按 profile 时区 localTime；每个 slot 的唯一键确保重复 tick/重启只产生一次。配置修订不会改写已完成 slot。

catchUpEnabled=false 跳过错过周期；true 时，每种任务只补最近 24 小时内**最多一个**周期，日计划只补当前本地日期。不得把多日缺勤变成不限量队列。DST 缺失的 localTime 在当天第一个有效时刻运行；重复 localTime 当天只运行一次。时区变化后的新 slot 仍检查 `(date,timeZone)` 与配置修订和去重键；正在执行的任务保留入队快照，不能半途混用新预算。

例 queued：`{"data":{"id":"job_1","type":"codex_sync","trigger":"user","status":"queued","commitState":"not_applicable","operationId":"op-codex-001","parentJobId":null,"progress":{"completed":0,"total":null,"unit":"messages"},"attemptCount":0,"createdAt":"2026-10-27T01:00:00.000Z","startedAt":null,"updatedAt":"2026-10-27T01:00:00.000Z","finishedAt":null,"error":null,"result":null}}`。

例 uncertain 的关键状态为 `status=uncertain,commitState=may_have_committed,error.code=REVIEW_COMMIT_UNCERTAIN,result=null,finishedAt=null`。GET 不是失败的 HTTP 响应，UI 不得用“HTTP 200”推导评分成功。

## 13. JSON 导出与安全合并导入

```ts
type ExportSource = Omit<Source, "text"> & { text: string | null };
type ExportAttempt = Omit<Attempt, "feedback"> & { latestFeedbackId: Id | null };
type JobSnapshot = Pick<Job,
  "id" | "type" | "trigger" | "status" | "commitState" | "operationId" |
  "progress" | "createdAt" | "updatedAt" | "finishedAt" | "error"
>;
type ExportData = {
  profile: LearningProfile;
  profileRevisions: ProfileRevision[];
  projects: Project[];
  checkpoints: Checkpoint[];
  sources: ExportSource[];
  knowledge: Knowledge[];
  practices: Practice[];
  attempts: ExportAttempt[];
  feedback: Feedback[];
  outputs: Output[];
  plans: DailyPlan[];
  reviewSessions: ReviewSession[];
  reviewResponses: ReviewResponse[];
  jobHistory: JobSnapshot[];
};
type ExportDocument = {
  schemaVersion: "second-brain.export.v1";
  productVersion: string;
  exportedAt: Instant;
  sourceContentIncluded: boolean;
  redactionCount: number;
  data: ExportData;
};
type ExportArtifact = {
  filename: string;
  mediaType: "application/json";
  schemaVersion: "second-brain.export.v1";
  content: string; // JSON 编码的 ExportDocument；作为下载文件的确切 UTF-8 内容
  byteLength: number;
  sha256: string;
};
type EntityName = keyof ExportData;
type ImportReport = {
  id: Id;
  schemaVersion: "second-brain.export.v1";
  importedAt: Instant;
  counts: Record<EntityName, { inserted: number; skipped: number; conflicted: number }>;
  conflictTotal: number;
  conflicts: { entity: EntityName; id: Id; reason: "different_existing_value" | "missing_dependency" }[];
  needsRecheck: number;
  profileApplied: boolean;
  notices: Notice[];
};
```

| 方法 / 路径 | 请求 | 成功 |
| --- | --- | --- |
| `POST /exports` | `Mutation & {scope:"all"|"projects",projectIds:Id[],includeSourceContent?:boolean}` | 200 `Success<ExportArtifact>`，不是裸文件旁路 |
| `POST /imports` | `Mutation & {document:ExportDocument,mode:"merge",applyProfile?:boolean,expectedProfileRevision?:number}` | 200 `Success<ImportReport>`，完整验证后事务合并 |

scope=all 时 projectIds 必须 []；projects 时必须 1..100 个存在的项目。导出包含所选项目关联记录及传递依赖，单例 profile/其修订仍包含；没有所选项目的 job history 仅 all 包含，projects 导出 jobHistory=[]。includeSourceContent 默认 false，此时 sources.text=null、所有 SourceRef.excerpt=null、reference.kind=source 的 evidenceSnapshots.text=null；练习输出、用户写作、知识答案和 output 证据快照仍是本产品数据，可导出，但经过同一秘密脱敏。显式 true 才包含已有的授权脱敏来源快照和摘录；恢复后的 null 快照不自动联网补取。

filename 是服务端生成的 `second-brain-<UTC紧凑时间>.json`，不含本地路径。前端将 content 按 UTF-8 存成 JSON 文件，sha256/byteLength 对该确切内容计算；可显示下载前摘要。内容最大 9 MiB，记录（ExportData 各顶层实体数组项数之和加一个 profile，不计实体内 refs/rubric 等子数组）最多 10000，超出 413 并提示选择项目范围；导入总请求最大 10 MiB、document 仍限 9 MiB/10000 条，避免导出的文件自身无法放进导入 envelope。

导出白名单仅 ExportDocument：**没有 settings、connections、secret 文件、访问令牌、api key、cookie、tokenFile 路径、原始日志、模型 trace、可执行作业 payload/lease**。jobHistory 是只读审计快照，不是可执行任务。所有字符串再做已知秘密模式脱敏并记录 redactionCount，不在报告中列出被遮盖值。导出不是 SiYuan 原生数据库/文件备份，不遍历其内部目录。

导入仅支持精确 schemaVersion，严格 DTO/长度/大小/引用校验；未知版本为 422 IMPORT_SCHEMA_UNSUPPORTED，畸形结构/额外凭据字段为 422 VALIDATION_ERROR，验证失败零写入。它不接受 ZIP、文件路径、脚本、prototype 键或任何 service credentials。来源文本中的指令仍是数据，不触发网络请求。权限/空间失败不留下半份恢复。

mode 只有 merge，没有替换/删除。相同稳定实体 ID 且相同规范业务内容跳过；ID 相同但内容不同记录 conflict、不覆盖本地记录。来源另按稳定外部事件身份+摘要查重，独立同文消息不合并。导入映射/摘要持久化，同一个文件以新 operationId 再导入也不重复插入。因冲突无法解析的依赖记录记录 missing_dependency、不悬空写入；conflicts 最多返回前 100 项，conflictTotal 保留真实数量，counts 的 EntityName 键全部返回。

applyProfile 默认 false（跳过 profile/profileRevisions，计入 skipped）。true 必须 expectedProfileRevision，匹配后把导出的配置/历史作为新本地修订与导入审计保存，不覆盖已有修订；当前配置以导出 profile 为最终新修订。来源修订号/时间到本地修订的映射保存在 import audit，相关 provenance 引用据此重映射；不应用 profile 时旧 profile 引用保留在导入审计，当前 DTO profileRevision=null，避免假指向本地同号修订。

恢复的 accepted 知识一律变 needs_recheck（计入 needsRecheck），保留原用户决定和验证证据，origin=backup，外部映射重置为 not_synced/siyuanBlockId=null；旧映射完整保留导入审计，不能立即覆写/重建原生块。用户复核后再次显式接受和同步。未完成计划标为 stale，completed 计划保留历史；reviewSessions 作为 blocked 历史、pendingJobId=null；reviewResponses 只是历史证据。jobHistory 归档存储，不入实时 jobs 队列；不回放定时任务、评分或同步。

所有导入只写本产品 data，不调用 SiYuan/飞书/Codex/模型，不编辑原生数据。导入审计保留已脱敏的原始业务快照及 ID/修订映射；不会因转换状态丢失用户原始记录，也不把备份的秘密或活跃会话变成当前权限。

例导出请求：`{"operationId":"op-export-001","scope":"all","projectIds":[],"includeSourceContent":false}`。以下是结构有效的空产品导入示例（时间/ID 是说明值，不是用户数据）：

```json
{
  "operationId": "op-import-001",
  "mode": "merge",
  "applyProfile": false,
  "document": {
    "schemaVersion": "second-brain.export.v1",
    "productVersion": "0.0.0",
    "exportedAt": "2026-10-27T01:00:00.000Z",
    "sourceContentIncluded": false,
    "redactionCount": 0,
    "data": {
      "profile": {"goals":[],"careerDirection":"","skills":[],"dailyBudgetMinutes":15,"timeZone":"Asia/Shanghai","revision":1,"createdAt":"2026-10-27T01:00:00.000Z","updatedAt":"2026-10-27T01:00:00.000Z"},
      "profileRevisions": [], "projects": [], "checkpoints": [], "sources": [],
      "knowledge": [], "practices": [], "attempts": [], "feedback": [],
      "outputs": [], "plans": [], "reviewSessions": [], "reviewResponses": [], "jobHistory": []
    }
  }
}
```

完整空文档仍须有真实 profile 和 ExportData 的全部数组；不能用省略字段伪装受支持 schema。实际导出含初始化 profile 修订，本例允许导入只保留当前配置的最小文件。

## 14. Notice、空状态与消费者约束

Notice.code 固定为以下集合，message 为简短中文且不含秘密：`NO_GOALS`、`NO_ACCEPTED_KNOWLEDGE`、`SIYUAN_UNAVAILABLE`、`RIFF_INCOMPATIBLE`、`PROFILE_CHANGED`、`NO_ACTIONABLE_ITEMS`、`BUDGET_EXHAUSTED`、`MANUAL_REVIEW_REQUIRED`、`TEMPLATE_FALLBACK`、`HAS_MORE_SOURCES`、`ANCESTRY_UNAVAILABLE`、`IMPORT_CONFLICTS`、`REDACTED_CONTENT`。若需要新的稳定 code，先更新契约。缺模型/服务的具体错误在连接状态或 Job.error 中，不假填反馈/卡片。

| 情况 | 可见返回与 UI 行为 |
| --- | --- |
| 新用户、无目标/项目/知识 | 空集合和默认 profile；提示填写自己的目标，展示真实未生成计划 |
| 模型/飞书未配置 | configured=false；核心编辑、模板练习和写作可用 |
| 无到期卡 | next.state=empty/no_due_cards，不显示示例卡或失败提示 |
| SiYuan 离线/版本不符 | 连接 unavailable/incompatible，reviewDue=null，给出阻塞原因 |
| 上游读取权限不足 | 403 或异步 Job.error SCOPE_FORBIDDEN，不扩大授权、不读本地原生数据库 |
| 202 / running / uncertain | 轮询真实 job；uncertain 显示核对提示，禁重复写入 |
| 对话/模型/导入文本包含指令 | 当作来源数据显示/净化，不执行、不改变范围、不上传 |
| 导入冲突/过期配置 | 显示统计/修订冲突，保留本地数据与原生来源 |

Kimi 可从本文件的 DTO/例子编写明确标注的 mock；生产页面只消费实际 API。关键交互须支持键盘、窄屏、可见焦点、表单 label、错误提示和处理中禁重复提交；不能仅靠前端禁用按钮保证幂等。应用没有隐藏答案预取、自动接受按钮副作用或无证据的能力百分比。
