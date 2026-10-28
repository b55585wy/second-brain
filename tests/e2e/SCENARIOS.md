# V5 finite worker requirement evidence

2026-10-27. Session 01a17c64-c2c7-76f1-b82c-9a45d2e240ac. **One actual V5 full15: 15 passed, 0 failed, 0 skipped, 0 timedOut, 0 interrupted, 0 notRun; exit 0; 27.9 seconds.** Exactly 15 existing cases in 9 files; no added case/guard/architecture, retry, targeted run or second full invocation.

Immediate V5 summary（本机留存：`artifacts/v5-summary.json`）, JSON（本机留存：`artifacts/v5-results.json`）, HTML（本机留存：`artifacts/v5-report/index.html`）, command（本机留存：`artifacts/v5-command.json`）, [complete report](INTEGRATION-REPORT.md). The prior canonical15/15 remains V4 history（本机留存：`artifacts/canonical-summary.json`）; unchanged V4 documents were archived before edits in report text（本机留存：`artifacts/v4-documents-before-v5/INTEGRATION-REPORT.md`） and scenario text（本机留存：`artifacts/v4-documents-before-v5/SCENARIOS.md`）.

## Requirements and evidence basis

The former no-goals generation wait no longer describes the actual UI. Today source now requires a goal before generation: its empty-goal action is a single real link to Settings. Retention acceptance and evidence validation are separate data/UI states, so acceptance alone cannot justify an evidence-supported claim. The V5 cases exercise the actual empty workspace and a real manually created record through edit/accept/search/reload.

Only existing EMPTY-01, KNOWLEDGE-01 and VIEW-02 assertions changed. Article locators are scoped by question/title and exact badge titles, avoiding status filter options. There is no supported-status response mock or database seed. Unknown/missing/supported/contradicted/mixed rendering is not synthesized in this E2E; the frontend owner reports separate mapping unit coverage. Configured-goal generation/feedback, zero-budget pause and every existing functional/security assertion remain.

## All normal, boundary, error and state-transition scenarios

Each write originates from the real UI with its own operationId/revision. Helpers observe request metadata and responses without filling, patching or successful-response mocking. Bounded reads verify actual persisted data.

| # | Existing case | Requirement scenarios | Source | V5 |
| --- | --- | --- | --- | --- |
| 1 | EMPTY-01 / NAV-01 | Stable Today h1; fresh no-goals heading; one CTA to /settings, no generation/rearrange; keyboard CTA to empty form; skip link/navigation/all fresh fields; disabled scope empty catalog/no leaked title. | [specs/empty.spec.mjs:5](specs/empty.spec.mjs) | Passed |
| 2 | PROFILE-01 | Original goal/career/skill, 15-minute budget/timezone reload; all nine local SiYuan stages below and exactly three UI saves. | [specs/profile.spec.mjs:4](specs/profile.spec.mjs) | Passed |
| 3 | PROFILE-02 / PROFILE-03 | 0 pauses Today; 120 persists; invalid 121 and empty timezone make no writes and preserve saved state. | [specs/profile.spec.mjs:140](specs/profile.spec.mjs) | Passed |
| 4 | PROJECT-01 | Project plus progress, next action and open question persist through checkpoint/reload. | [specs/projects.spec.mjs:4](specs/projects.spec.mjs) | Passed |
| 5 | PROJECT-02 | Empty required fields and 120-character title boundary; valid creation. | [specs/projects.spec.mjs:23](specs/projects.spec.mjs) | Passed |
| 6 | SAVE-FAIL-01 | Named POST 500 preserves input and creates no failed-save record; actual retry creates exactly one. | [specs/projects.spec.mjs:41](specs/projects.spec.mjs) | Passed |
| 7 | KNOWLEDGE-01 | Fresh manual 未核验 before/after acceptance/reload; independent 已接受 retention/title; raw validation unchanged; no false 证据支持; existing edit/search/source IDs/excerpts persist. | [specs/knowledge.spec.mjs:4](specs/knowledge.spec.mjs) | Passed |
| 8 | KNOWLEDGE-02 | No-match search, rejection and accepted/rejected filters remain distinct. | [specs/knowledge.spec.mjs:57](specs/knowledge.spec.mjs) | Passed |
| 9 | OUTPUT-01 | Create/edit goal, content and final status; same record reloads without duplicates. | [specs/output.spec.mjs:4](specs/output.spec.mjs) | Passed |
| 10 | PRACTICE-01 / PRACTICE-02 / PRACTICE-03 | Configured-goal 重新安排今天 real generation; empty submit, local draft recovery, attempt, source evidence and honest local feedback. | [specs/practice.spec.mjs:4](specs/practice.spec.mjs) | Passed |
| 11 | REVIEW-01 | Actual unconfigured 503 CONNECTION_UNAVAILABLE; no invented queue/reveal/rating/completion. | [specs/connections.spec.mjs:4](specs/connections.spec.mjs) | Passed |
| 12 | CODEX-01 | Named GET 503 at most twice; actual synthetic manual import stays usable; no real history calls. | [specs/connections.spec.mjs:20](specs/connections.spec.mjs) | Passed |
| 13 | TEXT-01 / VIEW-01 | HTML-like script/image text stays inert in knowledge/output; no overflow at 1440x1000. | [specs/security.spec.mjs:6](specs/security.spec.mjs) | Passed |
| 14 | SECRET-01 / SECRET-02 / EXPORT-01 | Disabled model, fake secret, blank omission/reload retention, actual export job/content/JSON bytes and redaction. | [specs/security.spec.mjs:30](specs/security.spec.mjs) | Passed |
| 15 | VIEW-02 / NAV-01 | Actual empty-goal Today one CTA/no generation; 390x844 menu/forms/project/knowledge/output/settings/review; long text, no overflow and original screenshots. | [specs/layout.mobile.spec.mjs:4](specs/layout.mobile.spec.mjs) | Passed |

DIAG-01 applies to all 15 cases. All diagnostic attachments have empty unexpected-failure lists; pageerror/console/HTTP/network/redirect/WebSocket/guard failures remain fatal. Expected resource errors are the actual review 503 once, named Codex GET 503 twice and named project POST 500 once. Only the latter two named boundaries are injected.

## PROFILE-01 local SiYuan stages

| Stage | Required assertion / transition | V5 |
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

These phases all passed in the one full invocation. PROFILE-01 and its six subsequent desktop cases share the same successful worker 1. Blank-token omission preserves the saved manual secret with an exact no-op revision. Restore selects the empty runtime without explicitly deleting the old manual token. This is local configuration evidence, not SiYuan kernel/Riff connectivity, and the UI request observer is not a server egress counter.

## One finite invocation and ownership

V5 config（本机留存：`artifacts/v5-config.mjs`） imports canonical-config and changes only outputDir and report destinations. Exact gates are BASE_URL=http://127.0.0.1:18998, SECOND_BRAIN_E2E_ISOLATED=1 and SECOND_BRAIN_E2E_PARENT_READY=BOTH-READY. Installed Edge ran headlessly with workers=1, retries=0 and globalTimeout=240000. Required syntax/config syntax/discovery passed; discovery allocated no worker. No dependency changes occurred.

The existing auto worker uses actual createApp/new physical isolated root/data/DB/secrets, PRAGMA validation, scheduler=false, controlled synthetic RPC, denied provider transport, owned bind/preflight, revoked attestation and finally app.close. Playwright owns browser/context cleanup. New workers 3/3 closed; all historical plus new records 16/16 closed. No persistent app/process/PID management, production 18997, real Codex history, kernel/Riff/Feishu/model calls or user data was used.

## Runtime and evidence integrity

Before（本机留存：`artifacts/v5-runtime-before.json`）, after（本机留存：`artifacts/v5-runtime-after.json`） and comparison（本机留存：`artifacts/v5-runtime-comparison.json`） prove all 25 server MJS and all 3 current served frontend/dist files unchanged. The backend also equals previous canonical hashes; frontend V4-to-V5 differences are expected. Application/frontend and harness source hashes stayed stable during the run; resultStale=false. Provenance uses Node fs SHA256 and Windows namespaced paths.

Preservation before（本机留存：`artifacts/v5-preservation-before.json`） and after（本机留存：`artifacts/v5-preservation-after.json`） show 456 prior artifact files unchanged, including 71 canonical V4 files. Existing overlapping groups remain: 188 baseline, 248 historical, 98 earlier full and 14 targeted/completion. Only the three authorized live specs changed from intake; package/lock/config/fixture/guards and other cases stayed unchanged. All new outputs use V5 names.

The earlier 14/1 result（本机留存：`artifacts/final-summary.json`）, corrected 1/1 verification（本机留存：`artifacts/final-profile-verification-summary.json`）, V4 canonical15/15（本机留存：`artifacts/canonical-summary.json`）, preliminary 13/2（本机留存：`artifacts/preliminary-baseline-20261027053555583/results.json`） and older 3/3 targeted（本机留存：`artifacts/targeted-summary.json`） remain historical observations. No old post-run script or artifact overwrite occurred.

## Existing screenshot positions

Images are actual full-page PNGs from this V5 invocation. The requested desktop/mobile Today and accepted Knowledge screenshots were opened for visual inspection. Today shows one goal CTA; the accepted question-scoped article visibly shows both 已接受 and 未核验.

| Position | Viewport | PNG dimensions | V5 artifact |
| --- | --- | --- | --- |
| Desktop Today: fresh empty-goals CTA | 1440x1000 | 1440x1000 | PNG（本机留存：`artifacts/v5-test-results/empty-EMPTY-01-NAV-01-fres-19e49-ace-and-keyboard-navigation-empty-desktop/empty-today-desktop.png`） |
| Mobile Today: empty-goals CTA | 390x844 | 390x1303 | PNG（本机留存：`artifacts/v5-test-results/layout.mobile-VIEW-02-NAV--c3149--and-forms-have-no-overflow-mobile/synthetic-mobile-today.png`） |
| Accepted knowledge: 已接受 + 未核验 | 1440x1000 | 1440x1000 | PNG（本机留存：`artifacts/v5-test-results/knowledge-KNOWLEDGE-01-man-75d2b--edit-acceptance-and-reload-desktop/synthetic-accepted-knowledge-sources.png`） |
| Mobile knowledge: long literal text | 390x844 | 390x1075 | PNG（本机留存：`artifacts/v5-test-results/layout.mobile-VIEW-02-NAV--c3149--and-forms-have-no-overflow-mobile/synthetic-mobile-knowledge-long-text.png`） |
| Desktop knowledge: inert HTML-like text | 1440x1000 | 1440x1981 | PNG（本机留存：`artifacts/v5-test-results/security-TEXT-01-VIEW-01-H-bc169-put-stay-inert-at-1440×1000-desktop/synthetic-inert-html-knowledge-desktop.png`） |

## Evidence limits and finish

This suite proves real UI/HTTP/SQLite + fixture upstream and local SiYuan configuration only. Genuine SiYuan API/kernel/Riff, Feishu authorization/import, real model calls/quality, real Codex app-server/history/sync and filesystem/SQLite permission/fault cases remain unverified. Disabled collector scope returns before catalog RPC; successful thread/read and agentMessage paths remain unverified.

The immediate summary/counts/new requirements/profile phases/PNGs/version hashes/integrity/worker closure were saved and printed before documentation. All authorized execution is complete. No further application request or test run follows; remaining verification reads only local evidence and files.
