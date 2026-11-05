# Speech reliability and diagnostics

Public pair 0.0.1 / 0.0.1, from plugin dev.11 / HA dev.7. No new credentials, provider SDK, logging service, or configuration flag is required.

## One retry owner

OpenClaw owns provider execution. HA reconnects/retrieves the **same** admitted job; it does not independently restart transcription/synthesis. Neither speech recovery path reruns the conversation model or Home Assistant actions.

Finite streaming STT and TTS permit at most **one additional bridge attempt per job**, not per sentence or per software endpoint. Eligible failures require positive structured evidence: selected transient HTTP statuses, known network/system or WebSocket close codes, a native timeout classification, or known transient provider codes. Authentication, configuration, quota exhaustion, no-speech, user cancellation, unknown failures and local validation/storage/decoder errors are not retried. Parsed error-message tokens help diagnosis but alone never authorize retry.

Retry begins immediately unless the provider supplies Retry-After. A delay over one second skips the extra attempt; the added first-result/first-audio wait is limited to three seconds. The original job/upload deadline still applies. Cancellation fences late results; returned late audio resources are released without playing them.

### STT

The successful path remains streaming. At most one 2 MiB PCM utterance is temporarily retained in memory. On an eligible mid-input failure, capture finishes under the existing upload deadline, then the same complete audio is retried without another wake word. The retained buffer is cleared/zeroed at completion or cancellation. A retry of an admitted realtime request **cannot switch to batch or another provider/model** when capability rechecking says unsupported.

Native **batch/CLI STT already owns key rotation, retries and model fallback**. The current public batch SDK does not expose a per-call attempt budget; the bridge therefore adds **no further batch invocation/replay**. Existing native policy is preserved rather than multiplied. A strict global attempt count inside older native SDKs is not claimed.

### TTS

Only the bounded current sentence is retained, not the whole generated response. A failed native synthesis call or first stream read can be retried before any segment output escapes. Once any segment header/audio has been exposed to the downstream normalizer, the bridge never rewinds the utterance or retries a later sentence. This conservative fence avoids repeated words after partial playback.

Unsupported progressive synthesis still falls back to native sentence-buffered synthesis **before output**, independently of execution retry. Existing native buffered-provider fallback is not multiplied: a result containing multiple native attempts cannot trigger an additional bridge attempt; an actual retry disables another native fallback chain and keeps the selected provider. Native model/voice overrides and credentials remain owned by OpenClaw.

## Diagnostic causes and host capability

Safe diagnostics retain known provider codes, HTTP status, WebSocket close code, allowed OS/network code, retry delay, exception category and bounded causes. No prompts, transcript/audio data, error bodies, headers, URLs, credentials or raw stacks are added to logs. Quota exhaustion is distinct from a temporary rate limit; network reachability and aiohttp connection failures are transport, and an owned TimeoutError does not become an intentional cancellation merely because its inner task was cancelled.

Some hosts flatten provider errors before the plugin receives them. Those remain explicitly unknown and are not blindly retried. Additive native speech-error metadata improves classification without changing core retry policy. Finite-input streaming and richer error metadata are optional host capabilities; this module does not install core patches. Conversation, batch STT and buffered TTS do not require those changes.

## Polling and native logs

Successful capability polls and their internal storage/authentication spans are DEBUG and do not displace meaningful voice operations in the diagnostic rings. OC authorization/backend failures remain WARN and retained. HA records availability transitions, one initial unavailable warning, recovery, consecutive/total failed checks and the latest sanitized cause. Routine failed HA poll spans stay DEBUG instead of duplicating the outage warning every 30 seconds. Current counters and latest cause are available in integration diagnostics while an outage is ongoing.

All logs still use the native OC/HA logging surfaces and their normal level/rotation policies. No longer-retention journal/exporter or recurring review is installed. Audio generation, delivery to HA and physical speaker playback remain distinct evidence boundaries.
