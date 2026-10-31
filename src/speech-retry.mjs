/** One additional provider attempt per speech job; never a pipeline replay. */
import { failureSummary, annotateFailure } from "./observability.mjs";

const transientSystems = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);
const transientProviders = new Set(["server_error", "internal_server_error", "service_unavailable",
  "overloaded_error", "rate_limited", "rate_limit_exceeded", "too_many_requests", "commit_throttled", "system_busy", "internal_error"]);

export function retryableSpeechFailure(error) {
  const value = failureSummary(error);
  const nested = [];
  const visit = (item) => { nested.push(item); for (const child of item.causes ?? []) visit(child); };
  visit(value);
  if (nested.some((item) => item.truncated)) return false;
  const timeoutOwnsCancellation = value.exception_type === "TimeoutError" || value.reason === "provider_timeout";
  if (nested.some((item) => ["authentication", "quota", "cancelled", "no_speech", "storage", "policy", "validation", "protocol", "internal"].includes(item.category) &&
      !(item !== value && timeoutOwnsCancellation && item.category === "cancelled"))) return false;
  if (["upload", "normalization", "cleanup", "validation", "storage"].includes(value.stage)) return false;
  if (nested.some((item) => ["quota_exceeded", "insufficient_quota", "payment_required", "subscription_required", "resource_exhausted"].includes(item.provider_code))) return false;
  // An arbitrary message containing "timeout" is not enough to authorize replay.
  return transientSystems.has(value.system_code) || [408, 425, 429, 500, 502, 503, 504].includes(value.http_status) ||
    [1006, 1011, 1012, 1013].includes(value.transport_code) || value.exception_type === "TimeoutError" ||
    value.classification_source === "structured" && (transientProviders.has(value.provider_code) || value.reason === "provider_timeout");
}

function retryTimeout() {
  return annotateFailure(Object.assign(new Error("speech_retry_timeout"), { name: "TimeoutError", code: "speech_retry_timeout" }),
    { reason: "speech_retry_timeout", category: "timeout" });
}

export class SpeechRetry {
  constructor({ kind, signal, diagnostics, timing, budgetMs = 3000, maxDelayMs = 1000 } = {}) {
    this.kind = kind; this.parent = signal; this.diagnostics = diagnostics; this.timing = timing;
    this.budgetMs = budgetMs; this.maxDelayMs = maxDelayMs;
    this.used = false; this.exposed = false; this.pending = false;
  }
  get signal() { return this.retrySignal ?? this.parent; }
  eligible(error, nativeAttempts = 1) {
    return !this.used && !this.exposed && !this.parent?.aborted && nativeAttempts === 1 && retryableSpeechFailure(error) &&
      (failureSummary(error).retry_after_ms ?? 0) <= Math.min(this.maxDelayMs, this.budgetMs / 3);
  }
  note(phase, facts = {}) {
    this.diagnostics?.event("speech_retry", this.kind, phase, { attempt: this.used ? 2 : 1, ...facts },
      phase === "failed" ? "warn" : "info");
  }
  async retry(error, { nativeAttempts = 1, beforeRetry } = {}) {
    if (!this.eligible(error, nativeAttempts)) {
      this.note("retry_skipped", { reason: "speech_retry_not_safe", partial_output: this.exposed }); return false;
    }
    // A live STT source is consumed once. If it failed mid-utterance, finish
    // collecting under the existing upload/job deadline before replaying it.
    await beforeRetry?.();
    this.parent?.throwIfAborted();
    this.used = true; this.pending = true;
    this.controller = new AbortController();
    this.retrySignal = AbortSignal.any([this.parent, this.controller.signal].filter(Boolean));
    this.timer = setTimeout(() => this.controller.abort(retryTimeout()), this.budgetMs);
    this.note("retry_started", { ...failureSummary(error), reason: "speech_retry_transient" });
    this.timing?.mark("retry_started");
    const delay = failureSummary(error).retry_after_ms ?? 0;
    if (delay) await this.invoke(() => new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, delay);
      this.signal.addEventListener("abort", finish, { once: true });
    }));
    this.signal?.throwIfAborted();
    return true;
  }
  async invoke(fn, disposeLate) {
    const signal = this.signal;
    signal?.throwIfAborted();
    if (!this.pending) return fn(signal);
    let abort, late = false, ready = false, resource, disposalStarted = false;
    const dispose = (value) => {
      if (!disposeLate || disposalStarted) return;
      disposalStarted = true;
      Promise.resolve().then(() => disposeLate(value)).catch((error) => {
        this.diagnostics?.event("speech_retry", this.kind, "cleanup_failed", failureSummary(error, { stage: "cleanup" }), "warn");
      });
    };
    const interrupted = new Promise((_, reject) => {
      abort = () => { late = true; reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const operation = Promise.resolve().then(() => { signal.throwIfAborted(); return fn(signal); });
    operation.then((value) => {
      resource = value; ready = true;
      if (late) dispose(value);
    }, () => {});
    try { const value = await Promise.race([operation, interrupted]); signal.throwIfAborted(); return value; }
    catch (error) { if (ready) dispose(resource); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }
  recovered() {
    if (!this.pending) return;
    clearTimeout(this.timer); this.pending = false;
    this.note("retry_completed"); this.timing?.mark("retry_completed");
  }
  expose() { this.exposed = true; this.recovered(); }
  finish(error) {
    clearTimeout(this.timer);
    if (this.pending && error) this.note("failed", { ...failureSummary(error), partial_output: this.exposed });
    this.pending = false;
  }
}

/** Retain at most one PCM utterance, without pre-buffering the successful path.
 * Attempt generators never own the source: an early provider return cannot
 * close it before a classified retry finishes collecting the same utterance.
 */
export class ReplayPcm {
  constructor(source, { signal, diagnostics, maxBytes = 2097152 } = {}) {
    this.source = source[Symbol.asyncIterator](); this.signal = signal; this.maxBytes = maxBytes;
    this.diagnostics = diagnostics;
    this.chunks = []; this.bytes = 0; this.generation = 0;
  }
  async pull() {
    this.signal?.throwIfAborted();
    if (this.closed || this.done) return;
    if (!this.pulling) this.pulling = (async () => {
      let next;
      try { next = await this.source.next(); }
      catch (error) { throw annotateFailure(error, { stage: "upload" }); }
      if (this.closed) return;
      this.signal?.throwIfAborted();
      if (next.done) { this.done = true; return; }
      const bytes = next.value;
      if (!(bytes instanceof Uint8Array) || bytes.length % 2) throw Object.assign(new Error("invalid_pcm_audio"), { code: "invalid_pcm_audio" });
      this.bytes += bytes.length;
      if (this.bytes > this.maxBytes) throw Object.assign(new Error("audio_limit"), { code: "audio_limit" });
      this.chunks.push(Buffer.from(bytes));
    })().finally(() => { this.pulling = null; });
    await this.pulling;
  }
  async *stream() {
    const generation = ++this.generation;
    for (let index = 0; !this.closed; index++) {
      this.signal?.throwIfAborted();
      if (generation !== this.generation) return;
      if (index === this.chunks.length && !this.done) await this.pull();
      if (this.closed || generation !== this.generation || index >= this.chunks.length) return;
      yield Buffer.from(this.chunks[index]);
    }
  }
  async complete() {
    ++this.generation;
    while (!this.done && !this.closed) await this.pull();
  }
  close() {
    this.closed = true; ++this.generation;
    for (const chunk of this.chunks) chunk.fill(0);
    this.chunks = [];
    // Async-generator return may be waiting for an HTTP read. It must not
    // hold cancellation open or resurrect the cleared replay buffer.
    return Promise.resolve().then(() => this.source.return?.()).catch((error) => {
      this.diagnostics?.event("stt", "replay_release", "cleanup_failed", failureSummary(error, { stage: "cleanup" }), "warn");
    });
  }
}
