# Second Brain finite Playwright harness

**PRELIMINARY baseline executed once on 2026-10-27: 13 passed, 2 failed, 0 skipped, no test/global timeout. Final acceptance is PENDING.** Parent readiness authorized this baseline only. All executor edits and evidence stay in E:/second-brain/tests/e2e. See INTEGRATION-REPORT.md for current failures, teardown and archived artifacts.

Read [SCENARIOS.md](SCENARIOS.md) for requirements and [INTEGRATION-REPORT.md](INTEGRATION-REPORT.md) for status and source observations.

## Permitted offline checks

Use PowerShell and npm.cmd:

~~~powershell
Set-Location E:\second-brain\tests\e2e
npm.cmd run check:syntax --cache .npm-cache
npm.cmd run check:safety --cache .npm-cache
npm.cmd run list --cache .npm-cache
~~~

These commands check syntax, inert Node guard/helpers and collection only. Playwright --list needs no target/readiness values, does not run worker fixtures, does not import server/app.mjs and creates no app database or worker storage. Exact final commands, exit codes, logs and before/after worker-directory observations are saved in worker-preparation-checks.json（本机留存：`artifacts/worker-preparation-checks.json`）. They do not establish live success.

The existing independent package/lock remains pinned to @playwright/test 1.64.1. Do not install programs, dependencies or browsers for this preparation. The config selects existing Edge, with existing Chrome as fallback. The preliminary run used the installed Edge headlessly; no install or browser download occurred.

## One finite owner

[support/fixtures.mjs](support/fixtures.mjs) declares an automatic worker-scoped fixture. Its [isolated-worker.mjs](support/isolated-worker.mjs) helper performs the only application construction:

1. Require all three exact values before filesystem allocation or app import: BASE_URL=http://127.0.0.1:18998, SECOND_BRAIN_E2E_ISOLATED=1 and SECOND_BRAIN_E2E_PARENT_READY=BOTH-READY. The parent supplied BOTH-READY and explicit execution authorization for the preliminary baseline; final execution remains pending.
2. Allocate a unique worker name containing a UUID. Create dataDir under artifacts/isolated-data/<worker>/, a separate empty root under artifacts/isolated-root/<worker>/ and evidence under artifacts/workers/<worker>/. Check physical paths, reject symlinks/junctions and nonempty storage, and never reuse a DB or remove prior directories.
3. Dynamically import the actual ../../../server/app.mjs relative to support. Pass explicit root, dataDir, dbPath, secretsPath, the actual project frontend/dist, scheduler:false, origin, port:18998, controlled synthetic rpcFactory and a transport.fetch that always throws before provider egress. Project data/ and runtime/ are never used for storage/discovery.
4. Query the actual app.store.db with PRAGMA database_list. Require exactly one main file matching the owned dbPath and verify its physical file before listen.
5. Await this app's listen(18998). A port conflict fails; no probing/reuse of another service and no process control. Run read-only preflight against this owned instance, checking fresh profile/core lists, no credential flags, unconfigured SiYuan, disabled collector/providers/automatic jobs, and connections.items.
6. Mint a private in-process attestation only after the owned DB, bind and preflight pass. Yield to the normal Playwright fixtures/tests. Revoke it on exit and always await app.close in try/finally, including DB validation, listen, evidence, readiness or test failures after construction.

Each project or failed-worker replacement can create another fresh worker directory. Configuration fixes workers:1, retries:0 and globalTimeout:240000, with independent empty-desktop, desktop and mobile projects. Every fixture lifetime is inside the same finite Playwright invocation. The standard browser/context fixtures close through Playwright. No app is exposed for tests to seed or write directly.

There is no standalone app start command, service process, daemon, PID file or signal manager. Only the explicitly unused scripts/launch-isolated-app.mjs was removed; its reusable validation/options moved to support/isolation.mjs. No other file removal or cleanup is part of this preparation.

## Preliminary baseline command

The following finite invocation was authorized and executed once for the preliminary baseline. No additional full-suite execution is authorized by this report:

~~~powershell
Set-Location E:\second-brain\tests\e2e
$env:BASE_URL = 'http://127.0.0.1:18998'
$env:SECOND_BRAIN_E2E_ISOLATED = '1'
$env:SECOND_BRAIN_E2E_PARENT_READY = 'BOTH-READY'
npm.cmd run test:e2e --cache .npm-cache
~~~

Do not pre-start an app, reuse a service or override workers/retries/dependencies/time bounds. No standalone launcher accompanies this command. A failure preserves artifacts and closes only its own app.

## Request and upstream boundaries

The generic target policy retains its existing loopback rejection tests; actual config/worker execution is narrower and permits only the exact origin above. Production 18997, Vite 5173/4173, arbitrary origins, redirects, unexpected WebSockets and browser egress remain rejected.

Default guards reject Codex threads listing and sync. Environment toggles and lookalike objects cannot attest an app. Only GET threads on the actual attested worker's origin may pass; sync is always forbidden. The capability is not serialized and is revoked before close. EMPTY-01 checks the real synthetic catalog through the UI; CODEX-01 covers its named unavailable boundary.

The in-memory RPC allowlist is initialize, thread/list, thread/read, thread/turns/list and thread/items/list. Thread/turn/item IDs are stable synthetic UUIDs. userMessage uses content:[{type:"text",text:synthetic...}], and agentMessage uses text. Titles/content are synthetic. No real Codex process, history, SiYuan, Feishu or model call is permitted. The fixture preserves agentMessage; the baseline catalog was blocked before RPC by disabled scope, so that message path remains untested.

**This is real UI/HTTP/SQLite + fixture upstream, NOT true external integration.**

## UI contract and diagnostics

The mutation helper only observes real UI requests/responses and asserts their local-ui header and operationId. It does not fill operationId/expectedRevision, patch bodies, mock successful responses or seed writes. All successful saves and refresh persistence require the rendered UI and actual backend. Bounded API reads verify persisted records/jobs.

Only two fault injections are allowed: named GET /api/v1/codex/threads 503 (one or two mount requests), and a single POST /api/v1/projects 500. All other calls pass real HTTP unchanged, once, with redirects/retries disabled. REVIEW-01 expects the real unconfigured SiYuan 503; it is not injected.

Locators follow the current visible UI: 稳定来源 ID; 手工来源（每行一条 URL 或摘录）; output title/content/目标（可选）/状态; practice 新增 URL 证据（每行一条） and 获取模板反馈. Knowledge checks visible excerpts and structured sourceId persistence through a real edit, acceptance and reload.

Export registers page.waitForEvent('download') and the real content-response observer BEFORE clicking 导出数据. It inspects the POST's operationId and returned job, awaits actual job completion, requires the same-origin API artifact, verifies the blob's embedded origin, saves and parses the real JSON bytes, compares them to backend content, and checks the unique fake-secret sentinel is absent. No visible link or fabricated URL is assumed. The preliminary baseline confirmed a direct-artifact export response without the required job/content flow; the assertion remains failed for the parent to resolve.

Current worker evidence is under artifacts/workers/<worker>/isolation.json and preflight.json. Baseline browser evidence is artifacts/results.json, report/ and test-results/. The preserved snapshot is artifacts/preliminary-baseline-20261027053555583/, including real 1440x1000 and 390x844 viewport captures. See INTEGRATION-REPORT.md for exact outcomes and limits. Historical preparation and rejection records remain separate.
