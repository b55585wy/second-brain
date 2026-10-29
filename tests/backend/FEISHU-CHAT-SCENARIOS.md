# Feishu learning-chat requirement scenarios

Write these cases before implementation. Run only in a source-only disposable copy with the guarded backend helper; never read production history, credentials or runtime data.

| Requirement | Normal path | Boundaries and failures |
| --- | --- | --- |
| Explicit local setup | Separate disabled-by-default config; redacted status; validated reminder time | Empty credentials, disabled app, invalid input, disabled channel |
| Web conversation entry | Current app's official private-chat link and a local QR; GET is inert | Missing/disabled app, unsafe identity or origin, unsupported region, stale app identity; no message/model call |
| Pairing | Local one-time expiring code binds one direct-message sender and chat to one app identity | Strangers, groups, bots, wrong/expired/consumed codes, attempt bound, credential change, deliberate re-pair |
| One current practice | Pairing or an explicit command queues the same current web practice | Empty today, completed practice, duplicate send-today, zero extra model calls |
| Durable delivery | Persisted UUID and outbox survive restart; confirmed delivery establishes answer context even if reminder time changes during send | Duplicate drain, known retryable error, unknown/timeout uncertainty, restart during send; late confirmation after disable/rebind/app/source change cannot authorize old answers |
| Answer association | Direct answer or explicit reply targets the delivered practice | Unknown reply target, changed profile/source/practice, missing delivery, completed practice, empty/oversized output |
| One saved output | A single SQLite transaction saves inbox and attempt; local feedback resumes after restart | Duplicate event, duplicate answer message, rollback failure, feedback failure/retry; unknown assistance is not labeled independent |
| Cross-entry records | Existing today/attempt records expose the same submission and template feedback | No fabricated correctness, no additional paid model call, history preserved |
| Reminders | One reminder per date/current practice in profile timezone | Before scheduled time, completed/no practice, pause, continue, 30-minute snooze, repeated tick, rebind/disable |

The core test file covers business behavior. Root-owned HTTP and SDK integration tests must separately cover actual route envelopes, revision/operation replay, adapter event normalization, lifecycle shutdown, dependency availability and credential redaction.
