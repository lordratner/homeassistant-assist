# Installation, upgrade and rollback

Source: [Home Assistant Assist plugin](https://github.com/lordratner/homeassistant-assist).
The repository rename does not change the `openclaw_voice` domain, existing
pairings, or the companion plugin ID. No identifier migration is needed.

The public pair is plugin **0.0.1** (dev.11 implementation) and HA integration
**0.0.1** (dev.7 implementation), protocol **1.2**. Download versioned artifacts
from the repositories' Releases pages. The plugin is distributed as a GitHub
release archive, not an npm package. No core patch is bundled or required for
conversation, batch STT or buffered TTS. Existing HA STT/TTS engines also work.

The scoped baseline is stock OpenClaw 2026.10.3 / 2026.10.10 (Node 24),
HA 2026.10.4 (Python 3.14.2+), with FFmpeg for OpenClaw TTS only.
Synthetic framework checks are not physical speaker or all-provider certification;
see [compatibility](COMPATIBILITY.md). Installation does not change Assist pipelines.

## Before installation

1. Verify artifact hashes and record both source revisions. Keep the previous
   plugin/integration package and configuration available for rollback.
2. Confirm the target OC/HA versions, FFmpeg availability if OpenClaw TTS is used on the OC host and
   supported public runtime/SDK capabilities. Do not edit installed core bundles
   to compensate.
3. Choose an existing agent; decide whether it may use household-control tools
   and approval-requiring tools through its **normal OC policy**. Pairing does not
   grant the voice user operator/admin authority or identify a human speaker.
4. Select one test satellite/speaker and record its current Assist pipeline.
   Preserve preferred/default pipelines and unrelated devices.
5. Back up relevant OC configuration/plugin metadata and HA integration/config
   entries using the platform's normal protected backup facilities. Backups may
   contain scoped credentials and conversation data; do not attach them to issues.
6. Obtain explicit approval for the exact installation/configuration/restart and
   bounded provider/audio canary. This document does not itself authorize them.

## OC installation

Download the plugin archive and checksum file from
[release 0.0.1](https://github.com/lordratner/homeassistant-assist/releases/tag/0.0.1),
verify the checksum, then install without silently enabling it:

```sh
curl -fLO https://github.com/lordratner/homeassistant-assist/releases/download/0.0.1/lordratner-openclaw-home-assistant-0.0.1.tgz
curl -fLO https://github.com/lordratner/homeassistant-assist/releases/download/0.0.1/SHA256SUMS
sha256sum -c SHA256SUMS
openclaw plugins install --no-enable ./lordratner-openclaw-home-assistant-0.0.1.tgz
```

Use the normal installation-policy review; do not bypass a rejection. Preserve
existing plugin allow/deny entries. Merge the selected-agent settings from the
README, enable this plugin, and, if using OC conversation, explicitly grant
`plugins.entries.openclaw-home-assistant.hooks.allowConversationAccess=true`.
Provider credentials stay in the already configured native OC auth system.
Only the TTS stage reports `audio_normalizer_unavailable` if FFmpeg cannot start; pairing, conversation and STT remain available.

Validate the configuration using the target version's supported validation
surface before activation. If a Gateway restart is required, explain impact and
verification and obtain approval for exactly:

```sh
openclaw gateway restart --safe
```

An acknowledgment only schedules the restart. After continuation, verify Gateway
health, existing channel reconnection and `openclaw_home_assistant.status`.
There is no second plugin listener and no reason to open another port.

Provider-dependent realtime STT also requires an optional finite-input
core runtime; installing the plugin alone retains batch behavior on a stock host.
Unsupported selections fall back only before input consumption, never after an
admitted-stream failure. See [capability notes](SDK-GAPS.md). Existing HA dev.3
already supports the unchanged upload/final-transcript contract and continuation
boolean: no HA redeployment or restart is needed solely for these backend changes.
Allow its normal 30-second capabilities/profile refresh after backend activation,
then verify the actual mode and physical follow-up listening separately.

An administrator can issue a code with:

```sh
openclaw gateway call openclaw_home_assistant.pairing.issue --params '{"label":"Home Assistant canary"}' --json
```

The returned code is short-lived private credential material. Transfer it only
to the intended HA administrator. Do not put it in repository files, logs or
public screenshots. The administrator token used for the RPC is never entered
in HA.

## HA installation

### HACS (recommended)

With HACS already installed, use [Open in HACS](https://my.home-assistant.io/redirect/hacs_repository/?owner=lordratner&repository=openclaw-assist-bridge&category=integration),
or open **HACS → ⋮ → Custom repositories**, add
`https://github.com/lordratner/openclaw-assist-bridge`, and choose
**Integration**. Find **OpenClaw Home Assistant** and download it. For a
historical development prerelease, enable **Show beta versions** in the download dialog.
The current 0.0.1 release does not need that toggle.
Read the selected release's requirements and notes before downloading.

HACS manages only `custom_components/openclaw_voice/`. It does not install the
companion OpenClaw plugin, provision providers, change pipelines, or restart HA
for you. Activate the downloaded Python code with a Home Assistant restart,
then add the integration in **Settings → Devices & services**. This download
path does not imply inclusion in the HACS default catalog.

Existing manual installation: back up the current component and HA configuration
first, then download through HACS into the same component directory and restart
HA. Keep the existing config entry, entities and pairing; do not remove the
integration or add a duplicate. Verify the loaded version and connection after
restart. HACS does not take ownership of your OpenClaw installation.

### Manual alternative

Download `openclaw_voice-0.0.1.zip` and `SHA256SUMS` from
[release 0.0.1](https://github.com/lordratner/openclaw-assist-bridge/releases/tag/0.0.1),
verify with `sha256sum -c SHA256SUMS`, and extract the archive's
`custom_components/openclaw_voice/` directory under HA's
configuration directory. Use a supported file-deployment mechanism; do not
replace another integration or edit HA internal storage directly. Restart HA
under the approved maintenance step, then add the integration in
**Settings → Devices & services**. Do not mix manual replacements with HACS
updates without recording which version is installed.

Enter the Gateway URL, one-use code and default history mode. Verify three native
entities and the `query` / `start_conversation` actions. Create/select a test Assist
pipeline explicitly; setup must not change preferred/default pipelines.

Run bounded synthetic checks in order: standalone STT, standalone TTS, text-only
query, spoken query, interactive satellite start, follow-up, second conversation,
mode override, cancellation, revocation and reauthentication. Confirm actual sound
and follow-up listening with a human observer. Record provider/model, timing,
playback target and outcome without raw audio/credentials. OpenAI first, then
ElevenLabs where the native provider supports that stage. Chargeable calls and
speaker output require the canary approval.

## Upgrade

Upgrade paired protocol-major versions together. Preserve plugin metadata and
HA config entries; never reset state to resolve an unknown receipt or stale
handle. Read release/migration notes first. HA config-entry version 2 migrates
the history preference from v1 data into options while preserving existing
entry/entity IDs and credentials; future versions fail closed. Quiesce
active work, install reviewed versions, perform approved activation/restarts,
verify status/entities/pairing and repeat the bounded canary. An interrupted
accepted turn may have executed tools: recover its status, do not resubmit it.

## Rollback

1. Stop issuing new voice requests. Record accepted job statuses; cancel only
   owned jobs. Cancellation is not proof that remote tools/providers stopped.
2. Restore the previous integration/plugin source and reviewed configuration
   through supported mechanisms. Preserve normal OC histories and plugin receipts.
3. Use the approved restart path if needed; never substitute forced service kills.
4. Restore the test satellite's prior pipeline selection, not unrelated defaults.
5. Verify original Gateway/channels/HA behavior. Revoke a canary client through
   the admin RPC if it should no longer have access; deleting the integration
   attempts self-revocation but a disconnected backend still requires admin review.
6. Do not delete provider credentials, OC sessions or metadata as "cleanup".

## Evidence still required

Archive-content checks and source-loaded native proofs are not equivalent to a
successful package-install/upgrade/rollback on the real targets. Capture those
results separately. No live installation, provider charge, restart or audible
playback is authorized or claimed by this development checkpoint.

## Structured logging upgrade (bridge dev.9 + HA dev.5)

These candidates add the [logging contract](LOGGING.md), with no configuration
migration, new credentials or new privileges. Install only through the separately
approved file/package path, preserving pairing, native history and prior archives.
OC code needs its normal supported plugin reload after the active turn settles;
HA Python code replacement needs a Core restart, not merely a config-entry reload.
A Gateway/server reboot is not required by the logging design. Keep activation
authority separate, verify the actual loaded versions and safe diagnostic output,
then retest a normal voice request, clarification/stop/timeout and long answer.
Synthetic/native tests are not physical-audio or deployed-logging acceptance.
