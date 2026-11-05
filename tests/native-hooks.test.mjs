import test from "node:test";
import assert from "node:assert/strict";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { VoiceRunControls } from "../src/run-controls.mjs";

test("native OC hook runner preserves exact run, agent and session controls", async () => {
  const controls = new VoiceRunControls();
  const context = { runId: "owned", agentId: "voice", sessionKey: "agent:voice:test" };
  const { lease, replyOptions } = controls.admit({
    ...context, model: { provider: "fixture", id: "fixture-model" }, thinking: "low", fast: false,
  });
  initializeGlobalHookRunner({
    plugins: [{ id: "openclaw-voice" }], hooks: [],
    typedHooks: [{ pluginId: "openclaw-voice", hookName: "before_model_resolve",
      handler: controls.beforeModelResolve.bind(controls), priority: 0 }],
  });
  try {
    const runner = getGlobalHookRunner();
    // Newer SDKs include an optional unset fallback field; it must stay unset.
    const { fallbacksOverride, ...overrides } = await runner.runBeforeModelResolve({ prompt: "test" }, context);
    assert.equal(fallbacksOverride, undefined);
    assert.deepEqual(overrides, {
      providerOverride: "fixture", modelOverride: "fixture-model",
    });
    assert.equal(await runner.runBeforeModelResolve({}, { ...context, agentId: "other" }), undefined);
    assert.equal(await runner.runBeforeModelResolve({}, { ...context, runId: "ordinary" }), undefined);
    assert.equal(replyOptions.fastModeOverride, false);
    controls.cancel(lease);
    assert.equal(await runner.runBeforeModelResolve({}, context), undefined);
  } finally {
    controls.close();
    resetGlobalHookRunner();
  }
});
