import test from "node:test";
import assert from "node:assert/strict";
import { SpeechRetry, ReplayPcm, retryableSpeechFailure } from "../src/speech-retry.mjs";
import { Diagnostics } from "../src/observability.mjs";
import { speechEvents } from "../src/speech-stream.mjs";

const error = (status = 503) => Object.assign(new Error("PRIVATE_PROVIDER_DETAIL"), { status });
const audio = (bytes = [1, 2]) => ({ success: true, outputFormat: "mp3", fileExtension: ".mp3",
  audioStream: new ReadableStream({ start(c) { c.enqueue(Uint8Array.from(bytes)); c.close(); } }) });
async function* text(value = "A sentence.") { yield value; }
async function collect(host, value) { return Array.fromAsync(speechEvents(text(value), { host })); }

test("only positively classified transient speech failures permit replay", () => {
  for (const value of [error(503), error(429), Object.assign(new Error("PRIVATE"), { code: "EAI_AGAIN" }),
    Object.assign(new Error("PRIVATE"), { closeCode: 1013 }), new DOMException("PRIVATE", "TimeoutError")])
    assert.equal(retryableSpeechFailure(value), true);
  for (const value of [error(401), error(403), error(402), error(400),
    Object.assign(error(429), { errorCode: "quota_exceeded" }),
    Object.assign(error(429), { errorCode: "resource_exhausted" }), new Error("timeout PRIVATE"),
    new DOMException("PRIVATE", "AbortError"), Object.assign(new Error("PRIVATE"), { code: "ENOSPC" }),
    Object.assign(new Error("internal_error PRIVATE"), { code: "provider_error" })])
    assert.equal(retryableSpeechFailure(value), false);
});

test("one shared budget, explicit delay cap, cancellation and exposure fences", async () => {
  const signal = new AbortController();
  const retry = new SpeechRetry({ signal: signal.signal });
  assert.equal(await retry.retry(Object.assign(error(), { retryAfterMs: 6000 })), false);
  assert.equal(await retry.retry(error()), true);
  assert.equal(await retry.invoke(() => 42), 42);
  retry.recovered();
  assert.equal(await retry.retry(error()), false);
  retry.finish();
  const exposed = new SpeechRetry(); exposed.expose();
  assert.equal(await exposed.retry(error()), false);
  signal.abort();
  assert.equal(await new SpeechRetry({ signal: signal.signal }).retry(error()), false);
});

test("parsed wrapper text cannot borrow a typed cause's provenance or override quota", () => {
  const mixed = new Error("service_unavailable", { cause: Object.assign(new Error("PRIVATE"), { errorCode: "transcriber_error" }) });
  assert.equal(retryableSpeechFailure(mixed), false);
  const quota = new Error("rate_limited", { cause: Object.assign(new Error("PRIVATE"), { status: 429, errorCode: "quota_exceeded" }) });
  assert.equal(retryableSpeechFailure(quota), false);
  const exhausted = new Error("rate_limited", { cause: Object.assign(new Error("PRIVATE"), { status: 429, errorCode: "resource_exhausted" }) });
  assert.equal(retryableSpeechFailure(exhausted), false);
  const unknownDeep = new Error("PRIVATE", { cause: new Error("PRIVATE", { cause: new Error("PRIVATE", {
    cause: Object.assign(new Error("PRIVATE"), { status: 401 }) }) }) });
  unknownDeep.status = 503;
  assert.equal(retryableSpeechFailure(unknownDeep), false, "truncated cause evidence cannot authorize replay");
});

test("retry respects a short provider delay and a bounded deadline; late resources release once", async () => {
  const retry = new SpeechRetry({ budgetMs: 80, maxDelayMs: 20 });
  const at = performance.now();
  assert.equal(await retry.retry(Object.assign(error(), { retryAfterMs: 10 })), true);
  assert.ok(performance.now()-at >= 8);
  let resolve, released = 0;
  const pending = new Promise((r) => { resolve = r; });
  await assert.rejects(retry.invoke(() => pending, async () => { released++; }), /speech_retry_timeout/);
  resolve("PRIVATE_RESOURCE");
  await new Promise((r) => setImmediate(r));
  assert.equal(released, 1); retry.finish();
});

test("PCM replay captures incrementally, owns the source and fences stale consumers", async () => {
  let reads = 0, closed = 0;
  async function* source() {
    try { reads++; yield Buffer.from([1, 2]); reads++; yield Buffer.from([3, 4]); }
    finally { closed++; }
  }
  const replay = new ReplayPcm(source());
  const first = replay.stream();
  const chunk = await first.next(); chunk.value.fill(99);
  assert.equal(reads, 1, "successful streaming must not pre-buffer input");
  await first.return(); assert.equal(closed, 0, "attempt does not own the original upload");
  await replay.complete();
  const second = await Array.fromAsync(replay.stream());
  assert.deepEqual(Buffer.concat(second), Buffer.from([1, 2, 3, 4]));
  assert.equal(reads, 2); assert.equal(closed, 1);
  const held = replay.chunks[0]; await replay.close();
  assert.ok(held.every((v) => v === 0)); assert.equal(replay.chunks.length, 0);
});

test("abort at the resolved-resource handoff still releases the TTS resource exactly once", async () => {
  for (const microtasks of [0, 1, 2, 3]) {
    const parent = new AbortController(); let disposed = 0;
    const retry = new SpeechRetry({ signal: parent.signal }); await retry.retry(error());
    const pending = retry.invoke(() => {
      const abort = (left) => left ? queueMicrotask(() => abort(left-1)) : parent.abort();
      abort(microtasks); return { private: "PRIVATE_RESOURCE" };
    }, () => { disposed++; });
    let returned = false;
    try { await pending; returned = true; } catch {}
    await new Promise((r) => setImmediate(r));
    // If invoke returned before cancellation, the caller owns the resource.
    // All early/handoff cancellation cases above must reject and dispose.
    assert.equal(disposed, returned ? 0 : 1, "abort microtask depth " + microtasks);
    if (microtasks <= 2) assert.equal(returned, false);
    retry.finish();
  }
});

test("PCM replay caps retained input and does not resurrect data after cancellation", async () => {
  async function* source() { yield Buffer.alloc(8); yield Buffer.alloc(8); }
  const replay = new ReplayPcm(source(), { maxBytes: 8 });
  await assert.rejects(replay.complete(), /audio_limit/); await replay.close();
  let release;
  const pending = new ReplayPcm({ [Symbol.asyncIterator]: () => ({ next: () => new Promise((r) => { release = r; }) }) });
  const read = pending.pull(); await pending.close();
  release({ value: Buffer.from([1, 2]), done: false }); await read;
  assert.deepEqual(pending.chunks, []);
});

test("TTS retries one API failure before output, keeps text identical and releases ownership", async () => {
  let calls = 0, released = 0; const seen = [];
  const events = await collect({ async stream(value, options) {
    calls++; seen.push(value);
    if (calls === 1) return { success: false, attempts: [{ provider: "other", outcome: "failed", status: 503, error: "PRIVATE" }], release: async () => { released++; } };
    assert.equal(options.retry, true); return { ...audio(), release: async () => { released++; } };
  } });
  assert.equal(calls, 2); assert.equal(released, 2); assert.deepEqual(seen, ["A sentence.", "A sentence."]);
  assert.deepEqual(events.map((e) => e.type), ["audio_start", "audio_chunk", "audio_end", "done"]);
});

test("TTS can retry a first-read stream error, but never audio already exposed", async () => {
  let calls = 0;
  const early = { async stream() {
    if (++calls === 1) return { ...audio(), audioStream: new ReadableStream({ start(c) { c.error(error()); } }) };
    return audio();
  } };
  await collect(early); assert.equal(calls, 2);
  calls = 0;
  const partial = { async stream() { calls++; let emitted = false;
    return { ...audio(), audioStream: new ReadableStream({ pull(c) {
      if (!emitted) { emitted = true; c.enqueue(Uint8Array.from([1, 2])); } else c.error(error());
    } }) };
  } };
  await assert.rejects(collect(partial), /PRIVATE_PROVIDER_DETAIL/);
  assert.equal(calls, 1);
});

test("no per-sentence budget and no extra retry after native provider fallback attempts", async () => {
  let calls = 0;
  await assert.rejects(collect({ async stream() {
    if (++calls === 1) return audio(); throw error();
  } }, "One sentence. Two sentences."), /PRIVATE_PROVIDER_DETAIL/);
  assert.equal(calls, 2, "later sentence failure is already partial response output");
  calls = 0;
  await assert.rejects(collect({ async stream() { calls++; return { success: false,
    attempts: ["one", "two"].map((provider) => ({ provider, outcome: "failed", status: 503, error: "PRIVATE" })) }; } }), /synthesis_failed/);
  assert.equal(calls, 1);
});

test("unsupported streaming fallback remains separate; buffered retry spends only one budget", async () => {
  let streams = 0, buffers = 0;
  const events = await collect({ async stream() { streams++; return { success: false,
    attempts: [{ outcome: "skipped", reasonCode: "unsupported_for_streaming" }] }; },
    async buffer(_, options) { if (++buffers === 1) throw error();
      assert.equal(options.retry, true); return { ...audio(), audioBuffer: Buffer.from([1, 2]) }; } });
  assert.equal(streams, 1); assert.equal(buffers, 2); assert.equal(events.at(-1).type, "done");
});

test("retry diagnostics correlate attempts without retaining provider messages or speech text", async () => {
  const diag = new Diagnostics(); let calls = 0;
  await diag.trace("tts", "job", async () => {
    await Array.fromAsync(speechEvents(text("PRIVATE_SPEECH"), { diagnostics: diag, host: {
      async stream() { if (++calls === 1) throw error(); return audio(); }
    } }));
  }, { job_id: "00000000-0000-4000-8000-000000000001" });
  const snapshot = diag.snapshot();
  const retry = snapshot.recent.filter((e) => e.component === "speech_retry");
  assert.ok(retry.some((e) => e.phase === "retry_started" && e.attempt === 2));
  assert.ok(retry.every((e) => e.job_id === "00000000-0000-4000-8000-000000000001"));
  assert.ok(!JSON.stringify(snapshot).includes("PRIVATE"));
});
