/** Provider-neutral sentence synthesis through OC's own speech capability API.
 * Native incremental-text providers can be added as a host-adapter strategy.
 * This adapter supports progressive audio per sentence, then buffered sentence
 * fallback. It never replays a partially delivered segment or an agent turn.
 */
import { annotateFailure, failureSummary, resultFailure } from "./observability.mjs";
import { SpeechRetry } from "./speech-retry.mjs";

export class SpeechStreamError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function checkAbort(signal) { signal?.throwIfAborted(); }
function sentenceBoundary(text) {
  for (const match of text.matchAll(/[.!?。！？](?:["'”’)]*)(?:\s+|$)|\n/g)) {
    if (match[0].startsWith(".")) {
      const prefix = text.slice(0, match.index + 1);
      // Avoid splitting a decimal at an arbitrary provider text-chunk edge,
      // common titles/abbreviations, or an initial. This is a bounded speech
      // heuristic, not a universal linguistic sentence parser.
      if (/\d\.$/.test(prefix) && match.index + 1 === text.length) continue;
      if (/(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i.test(prefix)) continue;
      if (/(?:^|\s)[A-Za-z]\.$/.test(prefix)) continue;
    }
    return match.index + match[0].length;
  }
  return 0;
}
function* boundedBytes(bytes, limit) {
  for (let offset = 0; offset < bytes.length; offset += limit)
    yield bytes.subarray(offset, Math.min(offset + limit, bytes.length));
}

export async function* sentenceSegments(textStream, { maxText = 65536, maxSegment = 600,
  signal } = {}) {
  if (!Number.isInteger(maxSegment) || maxSegment < 16 || !Number.isInteger(maxText) || maxText < maxSegment)
    throw new TypeError("invalid_text_limits");
  let pending = "", total = 0;
  for await (const text of textStream) {
    checkAbort(signal);
    if (typeof text !== "string") throw new SpeechStreamError("invalid_text_chunk");
    total += Buffer.byteLength(text, "utf8");
    if (total > maxText) throw new SpeechStreamError("text_limit");
    pending += text;
    while (pending) {
      let end = sentenceBoundary(pending);
      if (!end || end > maxSegment) {
        if (pending.length < maxSegment) break;
        const space = pending.lastIndexOf(" ", maxSegment);
        end = space >= Math.floor(maxSegment / 2) ? space + 1 : maxSegment;
        // Do not split a UTF-16 surrogate pair at a forced length boundary.
        if (/^[\uDC00-\uDFFF]/.test(pending.slice(end))) end--;
      }
      const segment = pending.slice(0, end);
      pending = pending.slice(end);
      if (segment.trim()) yield segment;
    }
  }
  checkAbort(signal);
  if (pending.trim()) yield pending;
}

function unsupported(result) {
  return result?.success === false && result.attempts?.length > 0 &&
    result.attempts.every((attempt) => attempt.outcome === "skipped" &&
      attempt.reasonCode === "unsupported_for_streaming");
}

export async function* speechEvents(textStream, { host, signal, maxAudioBytes = 32 * 1024 * 1024,
  maxChunkBytes = 32768, textLimits = {}, allowFormatChange = false, timing, diagnostics = timing?.span?.owner }) {
  if (!Number.isInteger(maxAudioBytes) || maxAudioBytes < 1 ||
      !Number.isInteger(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > 32768)
    throw new TypeError("invalid_audio_limits");
  let sequence = 0, segment = 0, totalAudio = 0, format;
  let streamingUnsupported = false, failure;
  const retry = new SpeechRetry({ kind: "tts", signal, diagnostics, timing });
  const releaseLate = async (value) => {
    try { await value?.audioStream?.cancel(); } finally { await value?.release?.(); }
  };
  try {
    for await (const text of sentenceSegments(textStream, { ...textLimits, signal })) {
      checkAbort(signal);
      timing?.mark("first_synthesis_request");
      timing?.segment("request", segment);
      let completed = false;
      while (!completed) {
        let result, reader, primaryFailure, retryError, cancel;
        let nativeAttempts = 1;
        diagnostics?.event("tts", "segment", "started", { segments: segment, attempt: retry.used ? 2 : 1 });
        const segmentStartBytes = totalAudio;
        try {
          if (!streamingUnsupported) {
            result = await retry.invoke(() => host.stream(text, { retry: retry.used }), releaseLate);
            checkAbort(signal);
            nativeAttempts = result?.attempts?.filter((v) => v.outcome !== "skipped").length ?? 1;
            if (unsupported(result)) {
              await result.release?.(); result = undefined;
              streamingUnsupported = true;
              diagnostics?.event("tts", "selection", "fallback", { reason: "unsupported_for_streaming", mode: "buffered" }, "info");
            } else if (!result?.success) throw annotateFailure(new SpeechStreamError("synthesis_failed"),
              resultFailure(result, { stage: "synthesis_request" }));
          }
          const mode = streamingUnsupported ? "sentence_buffered" : "sentence_progressive";
          if (streamingUnsupported) {
            nativeAttempts = 1;
            result = await retry.invoke(() => host.buffer(text, { retry: retry.used }), releaseLate);
            nativeAttempts = result?.attempts?.filter((v) => v.outcome !== "skipped").length ?? 1;
          }
          checkAbort(signal);
          if (!result?.success) throw annotateFailure(new SpeechStreamError("synthesis_failed"),
            resultFailure(result, { stage: "synthesis_request" }));
          if (!result.outputFormat || !result.fileExtension) throw new SpeechStreamError("missing_audio_format");
          const nextFormat = JSON.stringify([result.outputFormat, result.fileExtension]);
          if (format && format !== nextFormat && !allowFormatChange) throw new SpeechStreamError("audio_format_changed");
          let first;
          if (streamingUnsupported) first = { value: result.audioBuffer, done: !result.audioBuffer?.length };
          else {
            if (!result.audioStream) throw new SpeechStreamError("missing_audio_stream");
            reader = result.audioStream.getReader();
            // No audio_start is exposed until the first bytes exist. A stream
            // failing on its first read can still be safely retried once.
            cancel = () => { void reader.cancel(retry.signal?.reason).catch((error) => {
              diagnostics?.event("tts", "provider_cancel", "cleanup_failed", failureSummary(error, { stage: "cleanup", confirmed: false }), "warn");
            }); };
            retry.signal?.addEventListener("abort", cancel, { once: true });
            first = await retry.invoke(() => reader.read());
          }
          if (first.done) throw new SpeechStreamError("empty_audio");
          if (!(first.value instanceof Uint8Array)) throw new SpeechStreamError("invalid_audio_chunk");
          // A zero-length source read is not recoverable output. Keep reading
          // without exposing headers, while the retry's first-output deadline applies.
          while (!first.value.length) {
            if (!reader) throw new SpeechStreamError("empty_audio");
            first = await retry.invoke(() => reader.read());
            if (first.done) throw new SpeechStreamError("empty_audio");
            if (!(first.value instanceof Uint8Array)) throw new SpeechStreamError("invalid_audio_chunk");
          }
          format = nextFormat;
          // Conservative fence: even a downstream segment header cannot be
          // rewound safely by the normalizer, so no retry after this yield.
          retry.expose();
          yield { type: "audio_start", sequence: ++sequence, segment, mode,
            output_format: result.outputFormat, extension: result.fileExtension.replace(/^\./, ""),
            provider: result.provider, model: result.providerModel };
          const emitBytes = function* (bytes) {
            if (!(bytes instanceof Uint8Array)) throw new SpeechStreamError("invalid_audio_chunk");
            if (bytes.length) { timing?.mark("first_source_audio"); timing?.segment("source_audio", segment); }
            totalAudio += bytes.length;
            if (totalAudio > maxAudioBytes) throw new SpeechStreamError("audio_limit");
            for (const part of boundedBytes(bytes, maxChunkBytes)) {
              checkAbort(signal);
              yield { type: "audio_chunk", sequence: ++sequence, segment, bytes: part };
            }
          };
          yield* emitBytes(first.value);
          if (reader) while (true) {
            checkAbort(signal);
            const part = await reader.read(); checkAbort(signal);
            if (part.done) break;
            yield* emitBytes(part.value);
          }
          if (totalAudio === segmentStartBytes) throw new SpeechStreamError("empty_audio");
          yield { type: "audio_end", sequence: ++sequence, segment };
          timing?.segment("completed", segment);
          diagnostics?.event("tts", "segment", "completed", { segments: segment, bytes: totalAudio-segmentStartBytes,
            mode: streamingUnsupported ? "buffered" : "progressive" });
          completed = true; segment++;
        } catch (error) {
          primaryFailure = error;
          if (!retry.eligible(error, nativeAttempts)) throw annotateFailure(error, { stage: "synthesis_request" });
          retryError = error;
        } finally {
          if (cancel) retry.signal?.removeEventListener("abort", cancel);
          // Always settle/release the first provider before a second invocation.
          let cleanupFailure;
          const cleanup = async (fn, fatal = true) => {
            try { await fn(); }
            catch (error) {
              if (fatal) cleanupFailure ??= error;
              diagnostics?.event("tts", "provider_release", "cleanup_failed", failureSummary(error, { stage: "cleanup" }), "warn");
            }
          };
          if (reader) {
            await cleanup(() => reader.cancel(), false);
            await cleanup(() => reader.releaseLock());
          } else await cleanup(() => result?.audioStream?.cancel(), false);
          await cleanup(() => result?.release?.());
          if (cleanupFailure && retryError) throw primaryFailure;
          if (cleanupFailure && !primaryFailure) throw annotateFailure(cleanupFailure, { stage: "cleanup" });
        }
        if (retryError && !await retry.retry(retryError, { nativeAttempts })) throw retryError;
      }
    }
    checkAbort(signal);
    yield { type: "done", sequence: ++sequence, segments: segment, audio_bytes: totalAudio };
  } catch (error) { failure = error; throw error; }
  finally { retry.finish(failure); }
}
