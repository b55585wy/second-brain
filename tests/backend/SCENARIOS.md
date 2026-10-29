# Backend requirement scenarios

0.3.1 quota-reset verification: **402/402 passed**, no skips, in a source-only copy with concurrency 1; packaging **35/35 passed**. Developer resets preserve the original ledger, cooldown and reserved-job protection while charging new requests against a fresh date-specific budget. Frontend code is unchanged.

0.3.0 complete verification: **399/399 passed**, no skips, in a source-only copy with concurrency 1. Feishu requirements additionally cover [chat, delivery and answer scenarios](FEISHU-CHAT-SCENARIOS.md), registration preparation/expiry/cancellation, HTTP and SDK contracts, connection generations and explicit-off intent. Root frontend174, Kimi frontend173, packaging35 and synthetic browser10 passed; see [verification](../../docs/FEISHU-VERIFICATION-20261029.md).

All tests use isolated databases and fake upstreams. They must never write real SiYuan notes or collect real conversation history.

The shared helper resolves every database and credential path before constructing an application. All paths must be strictly inside the physical `tests/backend/.scratch` directory; empty, relative, production and symlink/junction paths are rejected. Cleanup applies the same boundary checks. Validate changes to this boundary in a source-only disposable copy before running database tests.

| Requirement | Scenarios | Test files |
| --- | --- | --- |
| Local HTTP safety | Loopback listener; success/error envelopes; wrong origin; bad Host; traversal; JSON content type, malformed/oversized bodies; bounded pagination; missing routes | http.test.mjs |
| Profile and project context | Defaults without invented career; timezone/budget bounds; create, list, search, edit, archive, soft delete; archived writes blocked; checkpoints persist | core.test.mjs |
| Knowledge acceptance | All extraction drafts; source references and redaction; accept/reject transitions; operation replay/conflict; accepted content edits require recheck; upstream source changes require recheck; no original mutation | core.test.mjs, connectors.test.mjs |
| Durable local state | SQLite restart; revisions; immutable attempts; user outputs; no-key manual workflow; export/import stable identity and revision conflicts | persistence.test.mjs |
| Daily planning | Empty profile; accepted knowledge; goal template; budgets 0/1/15/max; total within budget; timezone dates; repeat generation; completed evidence survives goal edits | learning.test.mjs |
| Competence feedback | Output and assistance evidence; missing/empty/invalid data; manual rubric with unknown correctness; optional model schema validation and prompt injection treated as source data | learning.test.mjs |
| DeepSeek cost control | Official root and `/v1` disable thinking and cap output at 2048 tokens; OpenAI/local requests unchanged; two lookalike hosts receive no override; malformed upstream JSON and model JSON each stop after one request | learning.test.mjs |
| SiYuan connector | Unconfigured; token redaction; real POST/Token contract; HTTP-200 errors; version mismatch; timeout; notebook import; app-owned notebook/card sync; flush before generated SQL; source originals unchanged | connectors.test.mjs |
| Riff scheduling | Pinned 3.8.8 rating mapping; real due-card fields; prompt hides answer until reveal; empty queue; wrong/out-of-order card; no rating before reveal; repeated operation; repeated card under new ID; timeout-after-commit uncertain and reconciled without regrading | review.test.mjs |
| Codex read-only collection | No default all-history collection; explicit scopes/exclusions; initialized handshake; state-db-only listing; paginated modern turns/items; legacy includeTurns fallback; no mutating RPC; visible user/assistant only; keys/tool/reasoning excluded; independent-thread identity; incremental digest; page failure/restart cursor; bounded limits | collector.test.mjs |
| Explicit recent conversation discovery | Disabled/empty positive scope may browse metadata only after an explicit request; negative exclusions/archive/revision checks; days/limit bounds and shared five-page budget; redacted metadata; no body RPC, saved sources, cursors or permission changes; unselected synchronization remains forbidden | collector-discovery.test.mjs |
| CLI listing capability verification | Exact schema-verified 0.164.0/0.165.0 server versions; real user-agent format; unknown, suffix and client-only lookalikes rejected; explicit capability declaration preserved; initialization does not read history | collector-capability.test.mjs |
| Bounded long-conversation continuation | Histories beyond twenty pages; visible quotas within a chunk; hidden-only pages; question context across chunks and full rescans; stable ID-less identities when pagination changes; SQLite restart/replay; partial prefix edits; protocol binding; transient failures; revoked scope; invalid/repeating/cyclic cursors; frozen thread queue; metadata-only checkpoints | collector-continuation.test.mjs |
| Test filesystem isolation | Undefined overrides resolved before construction; empty/relative/outside/production paths rejected before constructor calls; valid custom paths; junction escapes; checked cleanup; intentional isolated database restart | test-isolation.test.mjs |
| Manual transcript fallback | Exact schema; honest origin marker; source links; draft candidates; duplicate and changed message identity; malicious text stays inert; invalid/oversized inputs | collector.test.mjs |
| Feishu opt-in | Disabled and missing-token states; official URL allowlist; authorized raw-content import; 401/403 permission; 429 retryable; no arbitrary URL scraping/chat ingestion | connectors.test.mjs |
| Credentials and exports | Secrets absent in public settings/connections/errors/source excerpts/export; token kept in separate local secret file; unsafe provider URLs/redirects rejected; imported secrets ignored/rejected | persistence.test.mjs, http.test.mjs |
| Windows credential permissions | Actual default Windows ACLs; explicit Everyone/SYSTEM/non-owner logon ACEs removed on update and reopen; protected current-user-only DACL; literal Unicode/shell-sensitive paths; trusted native tools despite Git/poisoned PATH; owner/ACL/verification failures preserve previous disk and memory state and remove temporary files | credentials-acl.test.mjs, credentials.test.mjs, fixtures/credential-child.mjs |
| Persistent jobs/scheduler | Sync persistent job success/failure; single lease; crash recovery; bounded catchup while running; no OS autostart registration | jobs.test.mjs |

Run: `node.exe --test tests/backend/*.test.mjs` from the repository root. Exact commands, outcomes, API additions, and integration limitations are recorded in `server/HANDOFF.md`.

## Initial implementation verification

Node 24.22.0 / Windows: **163 passed, 0 failed, 0 skipped**, across 14 test files. The final root npm.cmd test also passed packaging16 and Kimi frontend33; see aggregate evidence（本机留存：`../../.tmp/final-delivery-checks-20261027/report.json`）.

- `hardening.test.mjs` additionally verifies nested import rejection, source identity aliasing, restored feedback, imported profile revision mapping, model-response revision races, invalid model schemas, manual rubric validation and Unicode limits.
- `http.test.mjs` includes actual static/SPA delivery plus junction/symlink escape protection.
- `collector.test.mjs` covers modern item pagination, full turn pagination and legacy includeTurns through a spawned fake RPC process; unknown versions stop before listing. It also covers quotas/cursors across restart, explicit archived permission and queued-job cancellation after scope revocation.
- `review.test.mjs` covers fresh sessions after changed knowledge and native card-state advancement before grading, as well as confirmed replay and timeout-after-commit uncertainty.
- `connectors.test.mjs` includes uncertain notebook creation without a second create and persistence of an actual card ID when it is no longer due.
- `jobs.test.mjs` includes confirmed native receipt recovery without repeating a remote operation.
- `persistence.test.mjs` includes quoted credential/tokenFile/JWT redaction, real runtime manifest discovery and idempotent SQLite restart restoration.

This backend suite uses synthetic upstreams. The separate real local SiYuan3.8.8 acceptance now passed under its permitted empty-token policy; real Feishu remains unverified. See docs/NATIVE-VERIFICATION-20261028.md. A separate real Codex0.164 collector check passed for ONE authorized bounded snapshot (12sources/7draft-unverifiedcandidates, full replay0new/0updated); see bounded verification（本机留存：`../../.tmp/projection-smoke-20261027-9b4e1f7c62/verification-report.json`）. It does not establish full-live history or continuous daily collection.

Additional requirement cases cover relevance and goal/skill coverage, pinned native Windows credential tools, review recovery, connection identity/epoch isolation, late or uncertain writes, and collector scope/cursor/redaction boundaries; exact checks are in the current 13 test files and server/HANDOFF.md.

## Windows credential ACL regression, 2026-10-28

The real Windows regression reproduced the prior defect: `/inheritance:r /grant:r` left explicit SYSTEM and non-owner logon read ACEs, and retained an explicitly granted Everyone read ACE. Credential paths now receive a replacement protected DACL with exactly the current user's FullControl rule, followed by a read-back check before credential bytes are written. Reopening a legacy file applies the same protection without changing its contents. Paths are passed to the fixed native PowerShell script through JSON stdin, never interpolated into command text.

Targeted verification: `node.exe --test tests/backend/credentials-acl.test.mjs tests/backend/credentials.test.mjs tests/backend/collector-secrets.test.mjs`; all 22 synthetic cases pass on Windows, including failure after temporary-file creation. The earlier aggregate counts above remain the recorded pre-regression baseline; the root task records the final aggregate after this change.

## Collector continuation verification, 2026-10-28

The complete current suite passed **257/257**, with no skips, in a source-only disposable copy using `node --test --test-concurrency=1 tests/backend/*.test.mjs`. This includes 26 continuation scenarios and 7 filesystem-isolation scenarios. Frontend63, packaging35, typecheck/build, and 9 synthetic browser integration scenarios also passed. Production database and credential hashes remained unchanged throughout these checks. See [the bounded real collection result and verification limits](../../docs/COLLECTOR-CONTINUATION-VERIFICATION-20261028.md).

## Automatic learning verification, 2026-10-29

The current complete backend passed **333/333**, no skips, in a source-only disposable copy with test concurrency 1. [Automatic-learning scenarios](AUTOMATION-SCENARIOS.md) cover permission receipts, bounded source fragments, goal-grounded model output, stable daily focus/practice, cross-day coverage without extra model requests, persistent cost reservations, one connection-only short recovery, revision guards, old scheduler transitions, and backward-compatible backups. Full frontend114, packaging35 and browser8 also passed; see [0.2 verification](../../docs/SIMPLE-VERIFICATION-20261029.md).
