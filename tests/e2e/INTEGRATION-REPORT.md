# V5 full15 actual UI evidence

2026-10-27. Session 01a17c64-c2c7-76f1-b82c-9a45d2e240ac. Scope: E:/second-brain/tests/e2e/**.

**The single authorized fresh V5 full run passed all 15 cases in 9 files, exit 0, 27.9 seconds. Failed, skipped, timedOut, interrupted and notRun: all 0.** The new empty-goals CTA and independent knowledge validation assertions passed. PROFILE-01 completed every existing local SiYuan phase, and all six later desktop cases passed in the same worker 1. No targeted verification or second V5 full invocation occurred.

Immediate summary（本机留存：`artifacts/v5-summary.json`）, command（本机留存：`artifacts/v5-command.json`）, JSON results（本机留存：`artifacts/v5-results.json`）, HTML report（本机留存：`artifacts/v5-report/index.html`）, log（本机留存：`artifacts/v5-playwright.log`）, exit code（本机留存：`artifacts/v5-exit-code.txt`）. The summary, runtime/integrity evidence, PNGs and worker-close status were saved/printed immediately after the command, before these documents.

This establishes real UI/HTTP/SQLite behavior with synthetic data and fixture upstream, plus local SiYuan configuration persistence. Genuine SiYuan kernel/Riff, Feishu, model and Codex history integrations remain unverified.

## Exact single invocation

Working directory: E:/second-brain/tests/e2e. Start 2026-10-27T08:13:51.526Z; finish 2026-10-27T08:14:20.183Z.

~~~powershell
$env:BASE_URL = 'http://127.0.0.1:18998'
$env:SECOND_BRAIN_E2E_ISOLATED = '1'
$env:SECOND_BRAIN_E2E_PARENT_READY = 'BOTH-READY'
$env:SECOND_BRAIN_E2E_HEADED = '0'
npm.cmd run test:e2e --cache .npm-cache -- --config=artifacts/v5-config.mjs
~~~

V5 config（本机留存：`artifacts/v5-config.mjs`） imports the existing canonical config and overrides only outputDir and report destinations. Workers=1, retries=0, globalTimeout=240000 and installed headless Edge were retained. The command refused existing V5 invocation/output records. Only required syntax/config syntax and collection checks preceded the run: preparation evidence（本机留存：`artifacts/v5-preparation-summary.json`）; collection found 15 cases in 9 files and allocated no worker. No dependencies, browsers, guards or harness architecture changed.

## Authorized V5 assertion changes

- [empty.spec.mjs:5](specs/empty.spec.mjs): stable Today h1 and 先设置学习目标 heading; exactly one 设置学习目标 link to /settings; no 生成今日计划 or 重新安排今天 button; screenshot before keyboard activation; empty goals form after activation. Existing skip link, navigation, fresh Settings fields and disabled Codex scope/no-leak checks remain.
- [knowledge.spec.mjs:4](specs/knowledge.spec.mjs): question-scoped article and exact explanatory titles distinguish retention from factual validation. Fresh manual knowledge renders 未核验 before acceptance, after acceptance/search and after reload. The accepted article shows 已接受 and 未核验 together, without 证据支持. Raw validation.status is compared unchanged across create/edit/decision/reload when exposed by the actual API; retention remains accepted. Existing source identity/excerpt assertions remain.
- [layout.mobile.spec.mjs:4](specs/layout.mobile.spec.mjs): actual empty-goal Today has the same single CTA and no generation/rearrange buttons, both initially and at the final existing screenshot. Existing menu, forms, long-text, no-overflow checks and capture calls remain.

Configured goals still exercise real generation through 重新安排今天 and local template feedback in [practice.spec.mjs:4](specs/practice.spec.mjs). Zero-budget pause and 0/120/invalid-121/timezone checks remain in [profile.spec.mjs:140](specs/profile.spec.mjs). No supported, contradicted or mixed status was manufactured by mock or database seed.

## All fifteen actual results

| # | Scenario | Source | V5 |
| --- | --- | --- | --- |
| 1 | EMPTY-01 / NAV-01 | [specs/empty.spec.mjs:5](specs/empty.spec.mjs) | Passed |
| 2 | REVIEW-01 | [specs/connections.spec.mjs:4](specs/connections.spec.mjs) | Passed |
| 3 | CODEX-01 | [specs/connections.spec.mjs:20](specs/connections.spec.mjs) | Passed |
| 4 | KNOWLEDGE-01 | [specs/knowledge.spec.mjs:4](specs/knowledge.spec.mjs) | Passed |
| 5 | KNOWLEDGE-02 | [specs/knowledge.spec.mjs:57](specs/knowledge.spec.mjs) | Passed |
| 6 | OUTPUT-01 | [specs/output.spec.mjs:4](specs/output.spec.mjs) | Passed |
| 7 | PRACTICE-01 / PRACTICE-02 / PRACTICE-03 | [specs/practice.spec.mjs:4](specs/practice.spec.mjs) | Passed |
| 8 | PROFILE-01 | [specs/profile.spec.mjs:4](specs/profile.spec.mjs) | Passed |
| 9 | PROFILE-02 / PROFILE-03 | [specs/profile.spec.mjs:140](specs/profile.spec.mjs) | Passed |
| 10 | PROJECT-01 | [specs/projects.spec.mjs:4](specs/projects.spec.mjs) | Passed |
| 11 | PROJECT-02 | [specs/projects.spec.mjs:23](specs/projects.spec.mjs) | Passed |
| 12 | SAVE-FAIL-01 | [specs/projects.spec.mjs:41](specs/projects.spec.mjs) | Passed |
| 13 | TEXT-01 / VIEW-01 | [specs/security.spec.mjs:6](specs/security.spec.mjs) | Passed |
| 14 | SECRET-01 / SECRET-02 / EXPORT-01 | [specs/security.spec.mjs:30](specs/security.spec.mjs) | Passed |
| 15 | VIEW-02 / NAV-01 | [specs/layout.mobile.spec.mjs:4](specs/layout.mobile.spec.mjs) | Passed |

All 15 browser-diagnostics attachments have empty unexpected-failure lists. Runner errors and flaky cases are zero. Four expected console resource errors correspond exactly to these responses:

| Method / path | HTTP | Code | Count |
| --- | --- | --- | --- |
| POST /api/v1/review-sessions | 503 | CONNECTION_UNAVAILABLE | 1 |
| GET /api/v1/codex/threads | 503 | E2E_CODEX_LIST_UNAVAILABLE | 2 |
| POST /api/v1/projects | 500 | E2E_PROJECT_SAVE_UNAVAILABLE | 1 |

The review response is the actual unconfigured backend failure. Only the named Codex GET 503 and project POST 500 boundaries are injected. All other HTTP passes unchanged; UI metadata/bodies are observed without repair, success mocks or write seeding.

## PROFILE-01 complete local SiYuan sequence

| Stage | Existing assertion / transition | V5 |
| --- | --- | --- |
| Original profile | Goal/career/skill, budget 15 and Asia/Shanghai persist through reload. | Passed |
| Empty runtime | One SiYuan entry; configured=false, tokenConfigured=false, baseUrl/version=null, none/not_configured, Riff unavailable; runtime checked, address disabled/empty, password blank, deletion unchecked. | Passed |
| Save 1: manual dummy 6806 | Real UI PUT includes synthetic notebook and fake token with exact operationId/expectedRevision/body. Configured/tokenConfigured=true, manual/unchecked; revision grows, password clears. | Passed |
| Manual reload | Manual mode, address, notebook, token flag and revision persist; no fake-token echo. | Passed |
| Save 2: blank token | Token OMITTED; new operationId, exact prior expectedRevision; token retained/redacted and revision exactly unchanged. | Passed |
| Retention reload | Manual settings/token flag persist with the same revision. | Passed |
| Save 3: restore runtime | useRuntimeConnection=true, baseUrl=null, original notebook and token OMITTED; real change grows revision; token deletion remains unchecked. | Passed |
| Restored response/reload | configured=false and tokenConfigured=false for the active empty runtime; address empty/disabled, password blank, check/notebook buttons disabled. | Passed |
| Profile/request boundary | Original profile preserved; only permitted Settings UI reads and exactly three SiYuan PUTs; no probe/check/notebook-list/sync/import/review. | Passed |

The old manual token was never explicitly deleted. Restored tokenConfigured=false describes the active empty runtime. The request observer measures browser UI traffic; it is not a provider transport-attempt counter. Dummy 6806 settings do not establish kernel/Riff connectivity.

## Lifetime, hashes and protected history

The unchanged auto worker constructs the actual createApp with a new physical isolated root/data/SQLite/secrets, actual frontend/dist, scheduler=false, controlled read-only synthetic RPC and denied provider transport. PRAGMA database_list verifies the owned main file before bind/preflight. Attestation is revoked and app.close runs in finally; Playwright owns browser/context teardown. No service daemon, process/PID management, production 18997 or user data was used.

New workers: **3/3 closed**. All recorded workers: **16/16 closed**. Each new worker has passed preflight, verified PRAGMA and revoked attestation. Exact worker names, paths and close records are in the immediate summary（本机留存：`artifacts/v5-summary.json`）.

Runtime before（本机留存：`artifacts/v5-runtime-before.json`）, after（本机留存：`artifacts/v5-runtime-after.json`） and comparison（本机留存：`artifacts/v5-runtime-comparison.json`） hash all 25 server MJS files and all 3 current served frontend/dist files using Node fs SHA256 with Windows namespaced paths. Both lists and bytes stayed unchanged. Backend matches previous canonical server hashes. Current frontend V5 differs from V4 as expected; frontend session supplied by the root: session_82888831-8a3a-4299-ba08-7572cc1b5a14. Backend 158 and frontend 33 unit/typecheck/build results were supplied by the root and were not rerun here. Provenance uses actual source/build bytes.

| Scope | Before SHA256 | After SHA256 |
| --- | --- | --- |
| 25 server modules, aggregate | a3bd87324a898f552ae4290387f74a92705f6fec845bfe899ec1c85c94a5c6db | a3bd87324a898f552ae4290387f74a92705f6fec845bfe899ec1c85c94a5c6db |
| 3 served dist files, aggregate | f59a0ee3fbe12a13baa6883596d2a6d301cd63e0f3acd2311715e037cae07da8 | f59a0ee3fbe12a13baa6883596d2a6d301cd63e0f3acd2311715e037cae07da8 |

All application/frontend and harness source hashes stayed stable during the run; resultStale=false. Only the three authorized live spec files changed from intake. Preservation before（本机留存：`artifacts/v5-preservation-before.json`） and after（本机留存：`artifacts/v5-preservation-after.json`） show all 456 prior artifact files unchanged, including 71 canonical V4 files. Previous protection groups remain unchanged: baseline 188, historical 248, earlier full 98 and targeted/completion 14 (groups overlap). No old post-run script was invoked.

## Actual screenshots and visual review

Existing capture positions use fullPage=true; mobile PNG height may exceed its viewport. The three requested images were opened and visually inspected after the run: the desktop/mobile Today CTA is visible and the accepted article visibly has both 已接受 and 未核验.

| Position | Viewport | PNG dimensions | New artifact |
| --- | --- | --- | --- |
| Desktop Today: fresh empty-goals CTA | 1440x1000 | 1440x1000 | PNG（本机留存：`artifacts/v5-test-results/empty-EMPTY-01-NAV-01-fres-19e49-ace-and-keyboard-navigation-empty-desktop/empty-today-desktop.png`） |
| Mobile Today: empty-goals CTA | 390x844 | 390x1303 | PNG（本机留存：`artifacts/v5-test-results/layout.mobile-VIEW-02-NAV--c3149--and-forms-have-no-overflow-mobile/synthetic-mobile-today.png`） |
| Accepted knowledge: 已接受 + 未核验 | 1440x1000 | 1440x1000 | PNG（本机留存：`artifacts/v5-test-results/knowledge-KNOWLEDGE-01-man-75d2b--edit-acceptance-and-reload-desktop/synthetic-accepted-knowledge-sources.png`） |
| Mobile knowledge: long literal text | 390x844 | 390x1075 | PNG（本机留存：`artifacts/v5-test-results/layout.mobile-VIEW-02-NAV--c3149--and-forms-have-no-overflow-mobile/synthetic-mobile-knowledge-long-text.png`） |
| Desktop knowledge: inert HTML-like text | 1440x1000 | 1440x1981 | PNG（本机留存：`artifacts/v5-test-results/security-TEXT-01-VIEW-01-H-bc169-put-stay-inert-at-1440×1000-desktop/synthetic-inert-html-knowledge-desktop.png`） |

## Preserved V4 and older results

The previous canonical 15/15 run is retained as V4 history: summary（本机留存：`artifacts/canonical-summary.json`）, JSON（本机留存：`artifacts/canonical-results.json`）, HTML（本机留存：`artifacts/canonical-report/index.html`）, raw V4 report text（本机留存：`artifacts/v4-documents-before-v5/INTEGRATION-REPORT.md`） and raw V4 scenario text（本机留存：`artifacts/v4-documents-before-v5/SCENARIOS.md`）. Original versions of the three changed specs are in the same archive.

Earlier full 14/1（本机留存：`artifacts/final-summary.json`）, corrected targeted 1/1（本机留存：`artifacts/final-profile-verification-summary.json`）, preliminary 13/2（本机留存：`artifacts/preliminary-baseline-20261027053555583/results.json`） and older targeted 3/3（本机留存：`artifacts/targeted-summary.json`） remain independent, unchanged historical evidence.

## Limits and completion

Genuine SiYuan API/kernel/Riff, Feishu authorization/import, real model calls/quality, real Codex app-server/history/sync and filesystem/SQLite permission/fault scenarios remain unverified. Disabled collector scope returns before catalog RPC; successful thread/read and agentMessage execution are unverified. Other factual badge mappings rely on the frontend owner’s separate reported unit coverage.

All authorized V5 execution is complete. No app call or further test invocation follows this run. Documentation/link/hash verification is read-only. [SCENARIOS.md](SCENARIOS.md) maps all requirement scenarios to actual cases.
