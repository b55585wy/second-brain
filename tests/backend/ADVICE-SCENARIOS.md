# Answer advice requirement scenarios

Use synthetic records and fake upstreams only. All backend runs use the guarded source-only disposable copy, serially; do not run backend tests from the production project root.

| Requirement | Happy path | Boundaries and failures | Tests |
| --- | --- | --- | --- |
| Save before advice | New answer and optional queued task commit together; original answer remains unchanged | Disabled, no model, zero quota and queue failure retain the answer and local self-check | advice.test.mjs, advice-integration.test.mjs |
| Independent budget | Profile-timezone daily limit is separate from automatic digest | Zero/max/invalid limits, queued races, failed/uncertain requests, new date, existing ledger and restart | advice.test.mjs |
| Request identity | Cache successful feedback and deduplicate repeated messages/operations | No automatic paid retry; explicit retry creates one new bounded request, known failed recovery retains original error | advice.test.mjs, advice-integration.test.mjs |
| Bounded review | Input includes original prompt, goal, rubric, answer and authorized source excerpts | Unicode/serialized bounds, long answer, omitted criteria, all refs checked even if only four enter input | advice.test.mjs |
| Model contract | Brief observations quote the learner's actual answer, with one next step | Missing/extra fields, invented IDs/quotes, source text substituted for learner evidence, limits and safe errors | model-advice.test.mjs |
| Current permissions | Recheck practice/answer/source digests, scope, model and enabled configuration | Exclusions, project-scope receipts, manual-import opt-out, in-flight changes and revoked source reject publication | advice.test.mjs |
| Feishu delivery | Save acknowledgement precedes advice; web and bot share the same feedback | Duplicate events, unavailable/failed states, context/binding changes and stale queued content | advice-integration.test.mjs, feishu-chat.test.mjs |
| Read-only status | GET reports status, usage counts and capability without creating tasks | Invalid retry input, stale revisions, unknown attempt and operation replay | advice-integration.test.mjs |
| Feedback preservation | Template requests reuse an existing model suggestion; original output and prior feedback rows remain | Old answer remains attached to its original practice/profile | advice-integration.test.mjs, learning.test.mjs |
| Backup | Standard advice feedback and job history export/import | Imports never restore automatic-processing permission, pending queue or paid ledger | advice-integration.test.mjs |

Actual provider validation is separate from these tests and must be counted against the configured advice budget. UI and browser checks use the same published DTOs without exposing credentials or real conversation content.
