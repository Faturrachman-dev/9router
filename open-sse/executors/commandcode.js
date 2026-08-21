import { randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { commandCodeToOpenAIResponse } from "../translator/response/commandcode-to-openai.js";
import { SSE_DONE } from "../utils/sseConstants.js";

/**
 * CommandCodeExecutor — talks to https://api.commandcode.ai/alpha/generate
 *
 * Auth: Bearer <user_xxx> API key (stored as the connection's apiKey).
 * Adds the per-request `x-session-id` header expected by CommandCode upstream.
 *
 * Upstream returns AI SDK v5 NDJSON (one JSON event per line, no `data:` prefix).
 * We translate each event to an OpenAI chat.completion.chunk and emit it as SSE so
 * both the streaming and non-streaming (forced SSE → JSON) downstream handlers in
 * 9router can consume it without further format translation.
 */
export class CommandCodeExecutor extends BaseExecutor {
  constructor() {
    super("commandcode", PROVIDERS.commandcode);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    return body;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      "x-session-id": randomUUID(),
    };

    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  async execute(opts) {
    const result = await super.execute(opts);
    if (!result?.response?.ok || !result.response.body) return result;

    // CommandCode upstream returns HTTP 200 even when generation never starts,
    // emitting an in-band {"type":"error"} NDJSON event instead of a real 5xx.
    // Downstream that surfaced as fake assistant content ("[CommandCode error: ...]")
    // with a normal stop reason, so clients treated a failed turn as a successful
    // reply and never retried/failed over (0 tokens, silent failure). Peek the
    // stream prefix: if an error arrives before any content, convert it to a real
    // non-ok Response so chatCore's !ok path fires (→ failover, and the client sees
    // a 5xx it can retry). If content already started, pass through untouched.
    const scan = await scanNdjsonPrefix(result.response);
    if (scan.earlyError) {
      result.response = new Response(
        JSON.stringify({ error: { message: scan.earlyError.message, type: "server_error" } }),
        {
          status: scan.earlyError.statusCode,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "application/json" },
        }
      );
      return result;
    }

    result.response = wrapNdjsonAsOpenAISse(scan.response, opts.model);
    return result;
  }
}

// NDJSON event types that mean real generation has begun. Once one is seen we
// must not convert the stream to an error — tokens are already legitimate.
const CONTENT_EVENT_TYPES = new Set([
  "text-delta", "reasoning-delta",
  "tool-input-start", "tool-input-delta", "tool-input-end",
  "tool-call",
]);

// Cap the peek so a well-behaved stream isn't buffered before first content
// (content normally arrives in the first line or two; this is only defensive).
const PEEK_MAX_BYTES = 64 * 1024;

function peekEventType(line) {
  const json = line.startsWith("data:") ? line.slice(5).trim() : line;
  if (!json || json === "[DONE]") return null;
  try { return JSON.parse(json)?.type || null; } catch { return null; }
}

function extractNdjsonError(line) {
  const json = line.startsWith("data:") ? line.slice(5).trim() : line;
  let message = "";
  try {
    const evt = JSON.parse(json);
    const errVal = evt.error ?? evt.message ?? "unknown";
    if (typeof errVal === "string") {
      message = errVal;
    } else if (errVal && typeof errVal === "object") {
      // CommandCode nests {type, message}; message may already be mangled
      // ("[object Object]") by their backend, so prefer type when so.
      message = (errVal.message && errVal.message !== "[object Object]")
        ? errVal.message
        : (errVal.type || JSON.stringify(errVal));
    }
  } catch {
    message = "unparseable error event";
  }
  return { statusCode: 502, message: `CommandCode upstream error: ${message || "unknown"}` };
}

/**
 * Tee the upstream NDJSON body and scan its prefix. Returns either
 * { earlyError: {statusCode, message} } when an error event precedes any content,
 * or { response } — a Response wrapping the untouched (tee'd) stream for passthrough.
 */
async function scanNdjsonPrefix(response) {
  const [scanBranch, passBranch] = response.body.tee();
  const reader = scanBranch.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesRead = 0;
  let earlyError = null;
  let contentStarted = false;

  try {
    while (bytesRead < PEEK_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value?.byteLength || 0;
      buffer += decoder.decode(value, { stream: true });

      let decided = false;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!rawLine) continue;
        const type = peekEventType(rawLine);
        if (!type) continue;
        if (type === "error") { earlyError = extractNdjsonError(rawLine); decided = true; break; }
        if (CONTENT_EVENT_TYPES.has(type)) { contentStarted = true; decided = true; break; }
        // start / start-step / *-start / metadata → keep scanning.
      }
      if (decided) break;
    }
  } catch {
    // Peek failed — don't block a possibly-good stream; fall through to passthrough.
  } finally {
    reader.cancel().catch(() => {});
  }

  if (earlyError && !contentStarted) {
    passBranch.cancel().catch(() => {});
    return { earlyError };
  }

  // Peeked bytes are still buffered in passBranch; hand it downstream unchanged.
  return {
    response: new Response(passBranch, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

function wrapNdjsonAsOpenAISse(originalResponse, model) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    }
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Translate AI SDK v5 NDJSON line to one or more OpenAI chunks
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) {
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
      controller.enqueue(encoder.encode(SSE_DONE));
    },
  });

  const newBody = originalResponse.body.pipeThrough(transform);
  return new Response(newBody, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: originalResponse.headers,
  });
}

export default CommandCodeExecutor;
