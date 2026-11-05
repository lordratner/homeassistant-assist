# Home Assistant Assist — OpenClaw plugin

Use an existing **OpenClaw agent as your Home Assistant assistant**, including
its normal knowledge, memory, skills, tools and history—not a second, unrelated
chatbot. This is the **OpenClaw-side plugin**. Install the companion
[OpenClaw Assist Bridge](https://github.com/lordratner/openclaw-assist-bridge)
in Home Assistant as well.

## Who it is for, and why use it?

For people who already run Home Assistant and OpenClaw and want to talk to the
same agent from HA's Assist chat, voice satellites or automations. Use it when
you want agent conversations and optional native HA device control, while keeping
HA's pipeline/device choices and OC's agent/provider policy in their own systems.
It is not a standalone voice assistant or a replacement for either platform.

Choose the parts you need:

- **Conversation only:** HA STT → OpenClaw conversation → HA TTS. Keep existing
  local speech engines; no OC speech provider or FFmpeg is needed.
- **All OpenClaw:** OC-backed STT → OpenClaw conversation → OC-backed TTS.
- **Mixed, or text only:** select each speech engine independently, or call
  the HA query action without a speaker.

## What runs where?

| Location | Install / responsibility |
| --- | --- |
| OpenClaw Gateway host | **This plugin** selects one existing agent and uses OC's native model, session, tools, policy and optional speech providers |
| Home Assistant host | The [companion integration](https://github.com/lordratner/openclaw-assist-bridge) registers conversation/STT/TTS entities and query/start-conversation actions; HA owns Assist pipelines, exposed entities and playback |
| Satellite or speaker | Uses its normal HA setup; an interactive satellite needs HA's native start-conversation support. A plain media player is not a microphone |

HA must be able to reach the Gateway URL; the hosts can be separate machines.
The plugin uses a route on the existing Gateway, not a new listener/port. Provider
credentials stay on the platform that owns the provider. Pairing gives HA a scoped
client credential, **not** an OC admin token or a human-speaker identity. HA's
exposed-entity policy governs native Assist calls, not other tools already granted
to your OC agent.

## Minimum versions and stock compatibility

**Yes: both components work with unmodified, stock Home Assistant and OpenClaw
cores.** Install this project's HA custom integration and OpenClaw plugin through
their normal extension mechanisms; no core fork, patch, custom Assist pipeline
engine, MCP server or SSH bridge is required.

| Component | Minimum supported version / requirement |
| --- | --- |
| Home Assistant Core | **2026.10.4**; older HA releases are not supported |
| OpenClaw | **2026.10.3**; older OC releases are not supported |
| This project's pair | OpenClaw plugin **0.0.1** + HA integration **0.0.1**, protocol **1.2** |
| Node.js on the OC host | For the tested Node 24 line, **24.16.0 or newer within 24.x**; follow OC's own engine requirements, not just the plugin's looser metadata |
| Python on the HA host | **3.14.2+**, normally managed by HA OS/Container; not a separate install step on those systems |
| FFmpeg on the OC host | Required **only for OC-backed TTS**; not needed for conversation, OC STT or HA-native TTS. Version 7.1.5 was exercised; no older FFmpeg minimum has been established |
| HACS | Optional installation convenience for the HA component; manual installation is also supported |

These are the **supported version floors**, not a claim that every later release
has been tested. Plugin CI passes against stock OC **2026.10.3 and 2026.10.10**.
The complete archive-loaded native-pair proof passes on stock **OC 2026.10.10 +
HA 2026.10.4**; use that combination to match the end-to-end evidence. Other
versions above the floors still need compatibility checks. The plugin's current
peer-dependency declaration deliberately lists the two tested OC versions.

The proof uses synthetic providers and devices with real host APIs. It verifies
pairing, conversation/tools, batch STT, TTS and follow-up decisions—not every
provider account, physical speaker or satellite. See [compatibility](docs/COMPATIBILITY.md)
and [acceptance evidence](docs/ACCEPTANCE.md).

## Install and connect

Current public release: **0.0.1** (plugin dev.11 implementation; companion HA
dev.7 implementation). Both releases are non-prereleases:

- [OpenClaw plugin archive and checksums](https://github.com/lordratner/homeassistant-assist/releases/tag/0.0.1)
- [HA integration release](https://github.com/lordratner/openclaw-assist-bridge/releases/tag/0.0.1)

The plugin is distributed through GitHub Releases, **not npm**. Download and
verify the versioned archive, then install it on the **OC host**:

```sh
curl -fLO https://github.com/lordratner/homeassistant-assist/releases/download/0.0.1/lordratner-openclaw-home-assistant-0.0.1.tgz
curl -fLO https://github.com/lordratner/homeassistant-assist/releases/download/0.0.1/SHA256SUMS
sha256sum -c SHA256SUMS
openclaw plugins install --no-enable ./lordratner-openclaw-home-assistant-0.0.1.tgz
```

Follow normal installation-policy review. Merge these settings into your OC
configuration (do not replace the whole file). Select an existing agent explicitly;
there is no silent main-agent fallback:

```json
{
  "plugins": {
    "entries": {
      "openclaw-home-assistant": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "agentId": "your-existing-agent",
          "conversation": {
            "model": "inherit",
            "thinking": "inherit",
            "fast": "inherit"
          }
        }
      }
    }
  }
}
```

The conversation hook grant is required for conversation/run-scoped controls.
Omitted STT/TTS selections inherit OC's native configuration; see
[product setup](docs/PRODUCT.md) for explicit provider/model/voice settings.
Do not put provider keys or Gateway tokens in the plugin configuration.

1. Validate and activate through OC's normal plugin lifecycle. If a Gateway
   restart is needed, use its supported safe-restart path; no core patch is needed.
2. Install the companion HA integration through HACS or manually, then restart
   HA to load its Python code. [Full install/upgrade/rollback guide](docs/INSTALL.md).
3. Issue a private, one-use code on the OC host:

   ```sh
   openclaw gateway call openclaw_home_assistant.pairing.issue --params '{"label":"Home Assistant"}' --json
   ```

4. In HA, open **Settings → Devices & services → Add integration → OpenClaw
   Home Assistant**. Enter the Gateway base URL and code (expires in five minutes),
   not the owner token. Use HTTPS across untrusted networks.
5. In **Settings → Voice assistants**, choose the OpenClaw conversation entity
   and whichever STT/TTS engines you want. Assign that assistant to your test device.
   Installation never changes preferred/default pipelines.

Choose persistent agent history or a fresh session per HA conversation; a fresh
session still retains the agent's normal knowledge, memory, skills and tools.
For native device control, enable **Device control** in HA Options and allow
`home_assistant` under the selected OC agent's normal policy. Follow-up intent
uses `voice_conversation`; model/tool and satellite support still apply.

## Speech-to-text and the upstream PRs

**You do not need any unmerged PR to use this pair.** On the tested stock OC
versions, OC-backed STT transcribes the completed utterance through OC's native
**batch** API. Alternatively, keep HA's existing STT engine. Conversation and
TTS are independent of the optional realtime-STT work.

Upstream status checked **2026-11-04**:

| OpenClaw PR | Purpose | Required to use the pair? |
| --- | --- | --- |
| [#187371](https://github.com/openclaw/openclaw/pull/187371) — **open** | Adds an optional finite-input streaming-transcription runtime so a plugin can send audio during capture and await a finalized transcript | **No.** Needed only for this plugin's optional realtime STT path, with a supporting provider/model |
| [#187369](https://github.com/openclaw/openclaw/pull/187369) — **merged Nov. 2** | Makes realtime transcription honor configured environment proxies | **No.** Relevant to that realtime transport when using such proxies; a merge alone does not prove inclusion in your installed OC release |
| [#189044](https://github.com/openclaw/openclaw/pull/189044) — **open** | Preserves realtime STT provider/connection failure codes for better diagnostics and retry decisions | **No.** Unknown/flattened failures stay conservative rather than being blindly retried |
| [#189043](https://github.com/openclaw/openclaw/pull/189043) — **open** | Related TTS failure-metadata improvement | **No.** Improves diagnosis/retry classification, not basic conversation or speech availability |

Installing our plugin does **not** install these core changes. Use ordinary stock
batch STT or HA-native STT unless your host supplies the optional runtime; do not
patch core merely to get started. A realtime-only OC model needs an explicit
batch-capable alternative (`stt.batch`), or choose HA STT. The plugin does not
invent provider/model aliases. Unsupported streaming can fall back before audio
is consumed; admitted failures never silently switch to batch or another provider.
No partial transcript is dispatched to the conversation agent. See
[SDK notes](docs/SDK-GAPS.md) and [speech recovery](docs/SPEECH-RELIABILITY.md).

## Operations and troubleshooting

```sh
openclaw gateway call openclaw_home_assistant.status --params '{}' --json
openclaw gateway call openclaw_home_assistant.diagnostics --params '{"limit":10}' --json
openclaw gateway call openclaw_home_assistant.inference.get --params '{}' --json
```

These are owner/admin methods; the HA token cannot administer models or clients.
Status reports each stage independently. Missing OC TTS does not disable text
conversation. Successful operations verify stages; configured credentials alone
are not proof of account access. Diagnostics exclude prompts, transcripts, audio
and credentials. [Inference updates](docs/PROTOCOL.md) change the next turn's
model/thinking/fast preferences without reloading or rewriting saved session
preferences; admitted work keeps its original settings.

Speech recovery is bounded, never replays a conversation/device action and never
retries TTS after partial output. Native batch STT retains OC's own retry policy.
Generated audio, delivery to HA and audible playback are separate outcomes.

- [Product setup and mixed pipelines](docs/PRODUCT.md)
- [Native HA Assist tools](docs/NATIVE-ASSIST.md)
- [Protocol, limits and recovery](docs/PROTOCOL.md)
- [Logging](docs/LOGGING.md) and [timing semantics](docs/TIMING.md)

## Development

CI validates stock OC 2026.10.3 and 2026.10.10. Local native-pair evidence uses
Node 24.22.2, HA 2026.10.4 / Python 3.14.10 and FFmpeg 7.1.5 on Linux.

```sh
npm install --no-save --package-lock=false --ignore-scripts openclaw@2026.10.10
npm run check
npm test
npm run test:native-pair
```

The native proof requires the sibling `../home-assistant-openclaw-voice` checkout
with its `.venv`, plus `openclaw` and `ffmpeg` on PATH. It creates disposable
loopback config/state and synthetic providers/devices, strips ambient provider
credentials and terminates its own Gateway. `OPENCLAW_PROOF_CLI` selects the CLI.
It does not contact real provider accounts or operate household devices.

Package with `npm pack --ignore-scripts --pack-destination /review/path`.
The allowlist excludes tests, dependencies and fixture state. See
[engineering history](implementation/STATUS.md) for earlier candidate evidence.

### Repository rename and license

Renamed from `openclaw-home-assistant` to `homeassistant-assist`. The package name,
plugin ID `openclaw-home-assistant`, config keys, API paths and state layout are
unchanged; the rename alone needs no reinstall or re-pairing.

Original code is MIT: [LICENSE](LICENSE), [provenance](THIRD_PARTY_NOTICES.md).
Runtime dependencies retain their own licenses.
