/**
 * OpenAI → CommandCode request translator
 *
 * Upstream `/alpha/generate` schema (verified live with curl 2026-05-07):
 *  - params.system: STRING at top level (Anthropic-style; system messages NOT allowed in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array of content blocks (NEVER a string)
 *  - Historical tool calls/results are serialized as labeled text because the
 *    current CommandCode/Muse bridge rejects structured history with a missing
 *    `arguments` error. Active tools remain structured in params.tools.
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { randomUUID } from "crypto";
import { ROLE, OPENAI_BLOCK } from "../schema/index.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";
import { parseDataUri } from "../concerns/image.js";

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
  }
  return String(content);
}

function toContentBlocks(content) {
  if (content == null) return [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  if (typeof content === "string") return [{ type: OPENAI_BLOCK.TEXT, text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === "string") {
        blocks.push({ type: OPENAI_BLOCK.TEXT, text: part });
      } else if (part && typeof part === "object") {
        if (part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        } else if (part.type === OPENAI_BLOCK.IMAGE_URL || part.type === OPENAI_BLOCK.IMAGE) {
          // Map to CommandCode's AI SDK v5 image content block ({type:"image", image, mediaType}).
          // data: URIs are split into raw base64 + mediaType; remote URLs pass through as-is.
          const url = typeof part.image_url === "string"
            ? part.image_url
            : (part.image_url?.url || part.image || "");
          const parsed = typeof url === "string" && url.startsWith("data:") ? parseDataUri(url) : null;
          if (parsed) {
            blocks.push({ type: "image", image: parsed.base64, mediaType: parsed.mimeType });
          } else if (url) {
            blocks.push({ type: "image", image: url });
          }
        } else if (typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        }
      }
    }
    return blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  }
  return [{ type: OPENAI_BLOCK.TEXT, text: String(content) }];
}

function stringifyToolArguments(value) {
  if (value == null) return "{}";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return "{}"; }
}

function convertMessages(messages = []) {
  const out = [];
  const systemTexts = [];
  const toolNamesByCallId = new Map();
  let hasToolHistory = false;

  for (const m of messages) {
    if (!m) continue;
    const role = m.role;

    if (role === ROLE.SYSTEM) {
      const t = flattenText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (role === ROLE.TOOL) {
      hasToolHistory = true;
      const value = typeof m.content === "string" ? m.content : flattenText(m.content);
      const toolCallId = m.tool_call_id || "";
      const toolName = m.name || toolNamesByCallId.get(toolCallId) || "unknown";
      out.push({
        // CommandCode currently rejects structured historical tool calls/results
        // after flattening them to its Responses input (`missing arguments`). Keep
        // the full history as labeled text; current tools remain structured in
        // params.tools, so the model can still make new calls.
        role: ROLE.USER,
        content: [{
          type: OPENAI_BLOCK.TEXT,
          text: `[tool result ${toolName}${toolCallId ? ` ${toolCallId}` : ""}]\n${value}`,
        }],
      });
      continue;
    }

    if (role === ROLE.ASSISTANT) {
      const textParts = [];
      const text = flattenText(m.content);
      if (text) textParts.push(text);
      if (Array.isArray(m.tool_calls)) {
        if (m.tool_calls.length > 0) hasToolHistory = true;
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          const toolCallId = tc.id || "";
          const toolName = fn.name || "unknown";
          if (toolCallId && fn.name) toolNamesByCallId.set(toolCallId, fn.name);
          textParts.push(
            `[tool call ${toolName}${toolCallId ? ` ${toolCallId}` : ""}] ${stringifyToolArguments(fn.arguments)}`
          );
        }
      }
      out.push({
        role: ROLE.ASSISTANT,
        content: [{ type: OPENAI_BLOCK.TEXT, text: textParts.join("\n") }],
      });
      continue;
    }

    out.push({ role: ROLE.USER, content: toContentBlocks(m.content) });
  }

  if (hasToolHistory) {
    const transcript = [];
    const nonTextBlocks = [];
    for (const message of out) {
      const text = message.content
        .filter((block) => block?.type === OPENAI_BLOCK.TEXT)
        .map((block) => block.text || "")
        .filter(Boolean)
        .join("\n");
      if (text) transcript.push(`[${message.role}] ${text}`);
      nonTextBlocks.push(...message.content.filter((block) => block?.type !== OPENAI_BLOCK.TEXT));
    }
    return {
      messages: [{
        role: ROLE.USER,
        content: [
          { type: OPENAI_BLOCK.TEXT, text: transcript.join("\n") },
          ...nonTextBlocks,
        ],
      }],
      system: systemTexts.join("\n\n"),
    };
  }

  return { messages: out, system: systemTexts.join("\n\n") };
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const result = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
      result.push({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: "object" },
      });
    } else if (t.name && (t.input_schema || t.parameters)) {
      result.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema || t.parameters,
      });
    }
  }
  return result.length ? result : undefined;
}

export function openaiToCommandCodeRequest(model, body, stream /* , credentials */) {
  const { messages, system } = convertMessages(body.messages);
  const params = {
    model,
    messages,
    stream: stream !== false,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    temperature: body.temperature ?? 0.3,
  };

  if (system) params.system = system;

  const tools = convertTools(body.tools);
  if (tools) params.tools = tools;
  if (body.top_p != null) params.top_p = body.top_p;

  const today = new Date().toISOString().slice(0, 10);

  return {
    threadId: randomUUID(),
    memory: "",
    config: {
      workingDir: process.cwd(),
      date: today,
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE, openaiToCommandCodeRequest, null);
