# Backend implementation handoff

Implemented only `server/**` and `tests/backend/**`. Root bootstrap/docs, frontend, runtime, user notes, and other repositories were not edited. No external runtime installer was run. No production API process is left running.

## Run and integrate

- Requires Node 24; verified with Node **24.22.0** on Windows. No backend dependencies or package install are required.
- From `E:/second-brain`: `node.exe server/main.mjs`.
- Default address: **http://127.0.0.1:18997**. `SECOND_BRAIN_PORT` can select another port. Binding is always loopback; an occupied port is reported without stopping its owner.
- Factory: `import { createApp } from './server/app.mjs'` (also exported by `main.mjs`). Use `createApp({root, dataDir, dbPath, secretsPath, frontendDir, transport, rpcFactory, scheduler})`, `await app.listen(0)`, and `await app.close()` for isolated integration tests.
- Production root is resolved from `import.meta.url`. Product SQLite: `data/second-brain.sqlite`; credentials: `data/secrets/credentials.json`. SQLite WAL, parameterized local queries, transactions, revisions, operation records, job leases and receipt recovery persist across restarts.
- Built `frontend/dist` is served when present, including SPA history routes. APIs work before a frontend build. Static files cannot traverse directories or escape through symlinks/junctions.
- Canonical DTOs follow `docs/API.md`. All writes require JSON, `X-Second-Brain-Client: local-ui`, and an `operationId` of 8–128 letters/digits/underscores/hyphens. Updates require `expectedRevision`. A completed operation replays before revision checks; changed requests with the same ID fail.
- Production browser requests must use the exact API origin and Host. Vite should proxy `/api` rather than add arbitrary cross-origin access.

## Delivered modules

| Files | Responsibility |
| --- | --- |
| `main.mjs`, `app.mjs`, `http.mjs` | Entry/factory, all v1 routes, health, loopback HTTP, request limits, operation replay, static serving, graceful shutdown |
| `store.mjs`, `validation.mjs`, `errors.mjs`, `dto.mjs` | SQLite records/transactions/operations, validation, public errors and explicit DTOs |
| `domain.mjs`, `sources.mjs` | Empty learning profile, revisions, projects/checkpoints, draft candidates, source snapshots/versions, explicit decisions and factual validation |
| `learning.mjs`, `model.mjs` | Bounded daily plans, durable practices/attempts/evidence snapshots, feedback, output revisions, optional compatible-model requests |
| `settings.mjs`, `secrets.mjs`, `transport.mjs` | Credential flags, actual runtime discovery, owner-only secret files, redaction, URL allowlists, bounded reads/timeouts and safe-read retry |
| `siyuan.mjs`, `reviews.mjs` | Public SiYuan connector, app-owned notebook/card mapping, pinned Riff review sessions, reveal gating, grading locks/receipts and read-only reconciliation |
| `codex-rpc.mjs`, `collector.mjs` | Explicit scopes/exclusions, safe CLI spawning, initialize/initialized handshake, read-only RPC allowlist, pagination/legacy fallback, identity/digest dedup and resume checkpoints |
| `feishu.mjs` | Opt-in tenant-token exchange, selected docx/wiki document resolution and actual authorized text import |
| `jobs.mjs`, `scheduler.mjs` | Persistent serial worker, queue limit, leases, crash recovery, opt-in bounded scheduler slots; no OS autostart |
| `backup.mjs`, `import-schema.mjs` | Secret-free JSON artifacts, strict nested schema validation, atomic merge, conflicts, dependency/source identity maps and inactive backup restoration |

## Product behavior and boundaries

Fresh data contains only configuration defaults: no invented goals, career, project, knowledge, attempts or outputs. Default learning budget is 15 minutes in Asia/Shanghai. Manual knowledge, practices, attempts, writing, template feedback and exports require no model, SiYuan or Feishu credential.

Knowledge acceptance is independent of factual validation and SiYuan synchronization. Imported/collected claims remain draft/unverified. Local extraction uses explicit source-linked transcript segments or a labeled source-excerpt template; it does not pretend to be model verification. Source updates preserve user answers and prior snapshots, reset validation and flag accepted knowledge for recheck. Only a separate explicit sync may write app-owned SiYuan blocks.

Attempts preserve the user's output, assistance level and immutable evidence snapshots. Completing a practice means a submission exists. Template feedback reports `not_assessed`; model feedback remains a suggestion and assessed findings must quote actual supplied output/evidence. There are no mastery percentages, fabricated correctness scores or autonomous tools. URL evidence is retained as a reference and never fetched for feedback.

Plans only generate for today in the profile's timezone, use real saved practices/outputs and compatible Riff reads, fit the budget, and preserve completed evidence. Unavailable Riff counts remain null. Scheduler flags default off; scheduled work only collects explicitly authorized Codex scope or generates local template plans. It never accepts, syncs, grades or invokes an external model.

## Optional connector configuration

**SiYuan:** `GET /connections` returns `not_configured` unless a real manual connection or valid `runtime/connection.json` exists. Runtime discovery reads `{baseUrl,version,tokenFile}`; relative token files resolve beside the manifest and must stay inside the project. No counterfeit manifest is created. The connector sends POST plus `Authorization: Token ...`, checks `code` even on HTTP 200, and flushes `/api/sqlite/flushTransaction` before generated SQL reads. It creates a dedicated notebook/deck and checks custom ownership attributes before updating existing card blocks. Source originals and native internal files are never edited.

**Riff:** only **SiYuan 3.8.8** is compatible. The pinned dependency defines Again=1, Hard=2, Good=3, Easy=4. Due cards are obtained from the native scheduler; the backend does not implement FSRS. `next` never includes answers, excerpts or validation. Reveal and presentation identity are persistent. An external native state change is checked before grading. Confirmed receipts recover locally without regrading; ambiguous writes stay locked and require read-only reconciliation. Counts/time changes alone do not prove which operation committed.

**Codex:** installed CLI version **0.164.0** and its experimental JSON schemas were inspected locally. Actual history was not listed or ingested. Spawn uses an argument array, `windowsHide`, a JavaScript entry via `node.exe` or an executable, and `mcp_servers={}`; PowerShell/CMD shims are rejected. Unknown CLI versions must explicitly advertise `useStateDbOnly` support or listing stops before any potentially repairing call. The only allowed RPC methods are initialize, thread/list, thread/read, thread/turns/list and thread/items/list, plus the initialized notification. No start, resume, fork, inject, archive or inference method is sent.

The initial scope is disabled and empty. Thread/project allowlists, exclusions, archived permission, and manual import permission follow the contract. Metadata listing is also scoped. `days` filters thread update time; it is not a claim that every message in a selected thread occurred within that window. Missing message times remain null. Same text in independent events/threads remains distinct. Cross-thread inherited aliases are deliberately not created without proven ancestry; results report zero and `ANCESTRY_UNAVAILABLE`.

**Manual Codex fallback:** `POST /api/v1/codex/manual-import` returns a persistent JobAck and accepts exactly:

```ts
{
  operationId: string, projectId: string | null, title: string,
  externalSourceId: string,
  messages: Array<{
    sourceMessageId: string, role: 'user' | 'assistant',
    content: string, occurredAt: string | null
  }>
}
```

Keep externalSourceId/sourceMessageId stable across imports. Origin is `manual_dialogue`; repeated imports deduplicate and changed source messages create versions. The endpoint works without app-server or a model. It does not execute transcript instructions.

**Models:** settings require explicit enablement and an endpoint/model. Remote content processing additionally requires `allowExternalProcessing=true` and a configured key. HTTP loopback models may have no key. Remote hosts are restricted to api.openai.com, api.deepseek.com, api.moonshot.cn, api.moonshot.ai, openrouter.ai and api.siliconflow.cn. Model outputs are strictly checked and may use an explicitly labeled template fallback.

**Feishu:** disabled by default. Requires appId/appSecret in settings. The selected region API exchanges the tenant token, resolves an explicitly supplied tenant docx/wiki URL, then reads raw_content. Arbitrary URL scraping and chat ingestion do not exist. HTTP 401/403 and permission codes become scope errors; 429 is retryable for reads. Token cache identity changes with the region/app/secret.

## API alignment notes for the parent/frontend

1. The explicit user requirement overrides the document's one-minute minimum: **dailyBudgetMinutes supports 0–120**, including a genuinely empty zero-budget plan. The root API document should be aligned to zero.
2. Canonical review rating is `again`; `forgot` is also accepted as an alias for the user's normative request and is recorded as `again`.
3. An empty connected installation can return `ReviewSession.deckId=null` before any explicit knowledge sync creates an app-owned deck. This prevents inventing a remote deck ID. Update that DTO to nullable.
4. `knowledge_sync.result.cardId` is nullable if the native card has never appeared in an accessible due response. A known real card ID is persisted and reused when that card is no longer due. The actual block/notebook IDs and confirmed API write result remain available.
5. Async pending state is always observable through JobAck/GET jobs; refresh the knowledge DTO after completion. Completed sync records carry the actual job ID.
6. Additional read endpoints: `GET /projects/:id`, `GET /knowledge/:id`, and `GET /exports/:id`. Export POST sets `Location` to the latter; it returns the same ExportArtifact envelope. Download the exact `content` UTF-8 string and verify its byteLength/sha256.
7. Additional local Codex options: `GET/PUT /connections/codex/options`. Initial revision is 0 if absent. PUT requires operationId/expectedRevision plus `{cliPath:string|null,days:1..90,maxThreads:1..100,pageSize:1..100,maxPages:1..20}`. Defaults are null/7/20/100/20. No arbitrary CLI argument input is accepted.
8. Backups contain no credentials/configuration/executable payloads. Accepted knowledge restores as needs_recheck with external authority cleared; sessions restore blocked, job history remains audit only, and profile application is opt-in with revision mapping. Source text omitted from a backup remains unavailable; local source GET exposes an empty text field rather than claiming to have fetched it.

## Verification and limitations

Exact final command, from `E:/second-brain`:

```text
node.exe --test tests/backend/*.test.mjs
```

**67 tests passed, 0 failed, 0 skipped**, across 9 requirement-oriented test files; final run approximately 2.18 seconds. `tests/backend/SCENARIOS.md` was written before tests and maps requirements to files. Tests use scratch SQLite databases, fake HTTP providers and a real spawned fake RPC process. They cover restarts, source changes, normal/empty/boundary/error cases, state transitions, reveal safety, operation replay, uncertain upstream commits, readonly pagination/legacy/exclusions, credential redaction, import conflicts, Unicode/timezone/budget rules, worker leases, static traversal/junctions, model grounding and no-key usability.

No real SiYuan or Feishu workspace credential was available to this invocation. Their request shapes were checked against official sources and exercised against fake upstreams; authenticated live integration and the concurrently built frontend remain parent integration checks. No actual Codex conversation was read. There is no fake connector success or fake due queue.

When native APIs cannot correlate a timed-out write with its operation, reconciliation honestly returns still_uncertain. In particular, unknown Riff grades are never retried on the basis of reps/time alone. Unknown knowledge-sync stages also remain blocked unless a local confirmed completion receipt exists. Native SiYuan has no conditional-write/operation-receipt API here, so simultaneous external native UI writes cannot be made atomic with this backend; the backend serializes its own writes and checks the baseline before sending a grade.

During verification, a Windows child-process cleanup race and PowerShell-pipe localization encoding issue were found and repaired. A raw HTTP client verifies Host because fetch normalizes it. Generated schema dumps and failed-run scratch artifacts were removed after verification; no production database was initialized by these tests.

## Verified primary references

- SiYuan 3.8.8 POST/auth, public block/notebook/SQL/flush semantics: [official API](https://github.com/siyuan-note/siyuan/blob/v3.8.8/docs/API.md).
- Due cards and review payload/null result: [pinned Riff API](https://github.com/siyuan-note/siyuan/blob/v3.8.8/kernel/api/riff.go), [request/response contracts](https://github.com/siyuan-note/siyuan/blob/v3.8.8/kernel/apicontract/riff.go).
- Rating mapping: [SiYuan dependency pin](https://github.com/siyuan-note/siyuan/blob/v3.8.8/kernel/go.mod), [Riff 228528e70754 store.go](https://github.com/siyuan-note/riff/blob/228528e70754/store.go).
- Feishu: [tenant_access_token/internal](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal), [wiki get_node](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space/get_node), [docx raw_content](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content).
- Codex protocol source: installed `@openai/codex` **0.164.0**, verified with `codex.js --version` and `codex.js app-server generate-json-schema --experimental`. No shell shim or conversation collection was involved in schema verification.


## Authorized backend follow-up and merge — 2026-10-27

This section supersedes the earlier 67-test verification count. The original isolated 112-test delivery was extended by 46 requirement scenarios. After per-file original-baseline SHA256 checks, **21 actual changed server/backend code and test files** were merged individually; every main after-hash matches the tested isolated file. Current root package.json, tests/backend/SCENARIOS.md and removed protocol schemas were preserved. No frontend source, dependency, lockfile, runtime, production data, global PATH or Codex configuration was edited.

Collector frozen queue saves now retain only required authorized metadata and redact title/name/preview display text before durable persistence and truncation. Exact thread IDs and canonical paths remain authorization inputs. Six failure/timeout variants verify checkpoint/database, response/export/audit redaction, process reopen and bounded resume.

SiYuan now has one persistent current canonical URL/stable-manifest identity and internal epoch. Same-instance saves, token rotation, manual/runtime mode swaps and restart preserve notebook/deck/card bindings. Genuine changes archive secret-free local binding metadata, cancel definitely unsent native sync/rating/import jobs, invalidate unsubmitted review contexts, and clear active block/sync mappings in a local transaction. Accepted question/answer/status/sourceRefs/validation, attempts, confirmed ratings/responses and historical jobs survive; old remote resources are neither modified nor deleted. New connections get a fresh app-owned destination identity. Native operations, queued work, review contexts and check/import results carry epoch guards; controlled delayed old responses cannot persist into or target a new instance. Every native request retains a single effective URL/token snapshot.

Switches reject with RECONCILIATION_REQUIRED before config/credential mutation when native writes are running/uncertain/may_have_committed, review writes are inflight/uncertain, or notebook/deck/document creation is pending. These locks survive restart. Missing/invalid runtime manifests clear the effective endpoint/token/check while preserving uncertain evidence; a guarded valid manifest change is not swallowed as an invalid manifest. A native workspace replacement at the same URL without a stable instanceId/workspaceId is inherently unidentifiable. Tokens, auth mode, file mtime, version and display title are not identity evidence; returning to an older instance does not reactivate an archived binding.

Actual checks from E:/second-brain, all exit 0:

- npm.cmd run test:backend — **158/158 passed**, 0 failed/skipped/cancelled, 13 backend test files. The seven Windows credential scenarios invoke actual trusted System32 tools on successful paths; narrow failure injection verifies owner/ACL/tool failures. No credential success stub hides ACL failures.
- npm.cmd run test:frontend — **24/24 passed**, 8 test files, including the current frontend API client against the actual backend and actual native credential-file behavior.
- npm.cmd run typecheck — passed (tsc --noEmit).
- Isolated final node --test tests/backend/*.test.mjs — **158/158 passed**, exit 0. No unrelated build/audit repeat was needed.

Bounded original-projection smoke (2026-10-27): **READY — actual positive collection, quota continuation and deduplicated replay proven**. This supersedes the earlier empty-private-projection blocker. The established canonical-rollout-filename harness correction is retained; no product API compatibility defect or runtime patch was needed. Scope is the approved original one-thread projection bounded by the existing private prefix, **not full live history**.

The original root first counted **11 turns / 1241 items / 1 projection-state row / 0 realtime rows**; the consistent snapshot transaction subsequently counted **11 / 1255 / 1 / 0** under other active writers. Source access was SQLite **URI mode=ro**, **PRAGMA query_only=ON**, and one consistent **BEGIN** read transaction using the existing WAL/SHM; **immutable was not used**, **total_changes=0**, and **0 source DB/SHM files were created**. Changes made by other active writers are not attributed to this query-only connection. All body-row SQL bound the one authorized thread ID and completed turn set. No original rollout body was reopened, other-thread body/future body was not selected, and no source writes, migrations, repair, checkpoint, history-mode change, credentials or configuration copies occurred.

Copied **3 genuinely completed turns / 31 genuine items / 1 private projection-state row / 0 realtime rows**. Completed turn endpoints exactly match the captured prefix, with ordinals within **0..127**, end byte offsets **<=430013**, and item creation/update ordinals within bounds and their completed turns. All **31 item IDs** match the actual prefix item_completed records; first-user, final-agent and root-turn references resolve without expansion. NULL bounds are excluded rather than inferred; original nullable fields stay NULL. Original and existing SDK-created private table/index schemas match exactly. IDs, ordinals, item_json/error_json raw bytes and SQLite storage types were verified unchanged during copying and again after all RPCs. Only private projection metadata was clipped to **next_ordinal=128 / next_byte_offset=430013**. The one-root paginated state retains the corrected native dated hierarchy/basename and consistent private rollout_path. Prefix stays **430013 bytes / 128 complete JSONL lines**, SHA256 **4fb1fe6094794a7c284cfe5e0fce23a1665bb6ca3ac23898b8980d5410d69575**.

Actual unmodified MAIN **createApp / collector / CodexRpc / RpcError**, from one module tree, used installed CLI **0.164.0**, a new isolated appRoot/data/Secrets and private CODEX_HOME. Original version, state-only and method/thread guards remained active. Exact-thread scope, **allowedProjectPaths=[]**, **maxThreads=1**, **pageSize=32**, first/continuation **maxMessages=8**: first quota produced **8 sources / 4 candidates**; continuation produced **4 normal new later sources / 3 candidates / 0 old-source duplicates**. Completed totals: **12 real sources / 7 assistant sources / 7 draft, unverified candidates / 14 genuine sourceRefs**. Scheduler/model/Feishu/SiYuan remained off; application external HTTP throws.

On the **same private prefix, projection, root and already-filled app data**, only **1 collector-cursor / 2 collector-thread** local fixture checkpoints were reset; stored sources/candidates stayed untouched. Re-reading all bounded messages with **maxMessages=32** produced **0 new sources / 0 new candidates / 0 updates**, with no truncation. First-capture old sets remain stable through continuation and replay; completed source/candidate sets and stored-record digests remain stable on replay. Actual native IDs were required directly from SDK replies, without fallback-generated IDs, and their payload digests matched across all three reads. Sorted native item-ID SHA256: **4508e9ffc8e6189a843353e28fd77147d1544808d9a9b565d7d46ce9b4207d43**; completed/replay source-ID SHA256: **02321580e19271cef885d80d6a46101813987794a6cf0896a265085d0edca015**; candidate-ID SHA256: **ef8b7b4990f98646333312768d771783d05eca489f03e10f982a58a6544b2c9b**.

Actual RPC totals: **initialize=3, thread/list=2, thread/items/list=3** (**8** total), **0 SDK errors**, **0 mutation RPCs / other-thread accesses / external HTTP calls / synthetic replies**. All **3 owned children** emitted actual close events; process-local environment was restored. Combined actual validation took **4180 ms**, below the **90000 ms** total deadline. Post-RPC private payload/storage/cursor/prefix checks passed. Private ACL validation checked **131 entries / 22 source files**, with **0 disallowed Allow ACEs / 0 owner mismatches**. All **25 MAIN runtime .mjs SHA256 hashes** match their task baseline. Only this smoke subsection changed in MAIN; no runtime, test, frontend, DTO/schema, package or setup edits and no unrelated test/frontend reruns occurred. Existing **backend 158/158, frontend 24/24, typecheck PASS, canonical browser 15/15** remain prior evidence for their recorded version.

Evidence: **.tmp/projection-smoke-20261027-9b4e1f7c62/projection-snapshot-report.json**, **actual-collect-replay-report.json**, **projection-integrity-after.json**, **private-acl-report.json**, **runtime-hash-guard.json**, **verification-report.json**. The first private helper attempt stopped before any source-row copy because item_completed is nested in event_msg; its parser was corrected and its failed-attempt report retained. No SDK/product fallback patch or binary/version-gate adaptation was made.

Relevance remains deterministic literal overlap of normalized English terms and Chinese 2–4-character fragments, with explicit goal/skill evidence and coverage-based practice selection. It is not semantic relevance, factual validation or mastery measurement. Frozen queues preserve fetched bounded pages; unfetched pages can still change. Native ambiguous writes remain locked without inferred receipts or automatic resend. All SiYuan integration checks here use synthetic services with valid disjoint namespaces; no real authenticated SiYuan service or final browser E2E is claimed. Root owns final browser15; two existing nonblocking UI polish items remain pending.

Evidence directory: E:/second-brain/.tmp/backend-review-20261027-ae125ab7e9. See DELIVERY.md, changed-files.json, merge-manifest.json, follow-up-validation-evidence.json, follow-up-allgreen-final.log, main-backend-final.log, main-frontend-final.log, main-typecheck-final.log and real-readonly-smoke.json. **READY for root final browser15.**
# Current delivery verification · 2026-10-28

Current MAIN aggregate: packaging16/backend163/frontend33 passed. Windows credentials now use a deterministic current-user-only protected DACL, including migration of pre-existing files without changing contents. Real SiYuan3.8.8 verification passed four owned knowledge documents, four distinct native grades1–4, idempotent replay, exact full-card scheduling persistence across normal desktop restart, exports and ACL checks. The dedicated desktop launcher fixes the origin at http://127.0.0.1:19006; production connection checks all passed. See ../docs/NATIVE-VERIFICATION-20261028.md and ../.tmp/native-acceptance-20261028/delivery-summary.json. Earlier sections retain historical evidence and limits; real Feishu/model calls and nonempty valid SiYuan token setup remain unverified.
