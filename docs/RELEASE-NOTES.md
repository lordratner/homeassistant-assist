# Release notes

## 0.0.2 — 2026-11-16

Plugin-only reliability update; compatible with HA integration 0.0.1 and protocol
1.2. No core patch, HA upgrade, re-pairing, configuration migration, or new
permissions are required. Preserve client state, job receipts and native history.

- Serialize job admission/ownership publication with recovery-capable operations,
  including across same-process reload generations. A concurrent lookup no longer
  falsely recovers a newly accepted job as interrupted.
- Keep healthy quiet streams connected with sequenced, replayable phase keepalives
  after twenty idle seconds. Execution deadlines and genuine slow-consumer limits
  remain bounded.
- Bound blocked HTTP writes, honor cancellation, and clean up transport listeners.
- Request cancellation of one-shot STT/TTS uploads on stream failure. Conversation
  failures retain same-job recovery without redispatch. Cancellation requests are
  not confirmation that remote provider work stopped.

Use the supported plugin installer and approved targeted reload/activation path.
Keep the previous artifact for rollback; never reset histories or receipts.
See [installation and rollback](INSTALL.md). Physical audio and cold-start latency
improvements are not claimed by this release.
