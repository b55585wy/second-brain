# Automatic learning requirement scenarios

These scenarios are defined before implementation. Tests must use the guarded scratch helper and fake upstreams. Run only from a source-only disposable copy, serially; never open a production database, credentials, runtime or Codex history.

| Requirement | Happy path | Boundaries and failures | Test file |
| --- | --- | --- | --- |
| Read-only home | GET automation/today reports saved state | No discovery, collection, jobs or model requests from GET; empty profile/scope/model reports setup | automation.test.mjs |
| One-time enable | PUT enables and immediately enqueues one bounded cycle | Revision conflict, duplicate operation, disable; old settings schema unchanged | automation.test.mjs |
| Local automatic continuation | Existing authorized threads advance across batches without user clicks | max100 visible sources/cycle; hidden pages; restart; old manual checkpoint and candidate behavior preserved | automation.test.mjs |
| Candidate noise | Automatic capture persists sources without assistant-per-record drafts | Previously saved knowledge remains unchanged; manual capture still produces drafts | automation.test.mjs |
| Authorization | Only successful current-scope collection receipts supply digest inputs | No unreceipted historical sources; exclude/revoke during collection/model; project-path receipts remain scoped | automation.test.mjs |
| Bounded input | Goal-aware ranking and thread diversity select source fragments | Total source text <=12000 Unicode characters; long source offsets retain every unprocessed tail | automation.test.mjs |
| Model contract | Up to three cited goal-linked highlights and one feasible unanswered exercise | Zero relevant highlights; zero budget; invalid JSON/keys/counts/goal/source/quote/rubric/time/answer field rejected | model-digest.test.mjs |
| Cost | Three attempts/day in profile timezone; one-hour cooldown | Failed/uncertain attempts counted; midnight resets; restart of a reserved job never resends | automation.test.mjs |
| Deduplication | Same source digest/profile produces no extra request | Source, profile or model context changes makes new work eligible; repeated highlight content is suppressed | automation.test.mjs |
| Publication guard | Valid focus, references and practice commit together | In-flight disable, profile/scope/model/source change publishes nothing; original outputs preserved | automation.test.mjs |
| Daily practice | Same-day open/completed practice remains stable across new batches | Following day can reuse current focus for a cited template exercise without model cost; zero budget yields none | automation.test.mjs |
| Cross-day focus coverage | A new day prioritizes valid unique highlights not yet scheduled, then least recently scheduled items | Historical scheduling uses each day's actual first three choices, not every raw artifact; same-day choices stay stable; extra content remains eligible; no mastery claim, new model request or history overwrite; invalid context/source and zero budget remain guarded | automation.test.mjs |
| Error recovery | Local transient read retries retain checkpoints; next cycle is bounded | Upstream timeout, invalid model schema and queue overlap do not create a tight loop or fabricated success | automation.test.mjs |
| One bounded connection recovery | First connection failure waits 60 seconds, then reserves one new paid attempt | Two connection failures revert to one-hour cooldown; restart/day change never rearms the chain; old uncertain records remain unchanged; auth/rate/timeout/schema errors do not qualify; daily3 and context/disable guards remain enforced | automation.test.mjs |
| Legacy scheduling | Existing explicit manual APIs remain usable | Old scheduled raw-candidate collection yields while automatic learning is enabled, without editing old settings | automation.test.mjs |
| Backup compatibility | New focus and new job history export/import with dependencies | Old v1 without focus collection imports; imports never enable automation, scope or external model processing | automation-backup.test.mjs |
