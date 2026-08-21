/**
 * Translator: OpenAI Responses API → OpenAI Chat Completions
 * 
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { normalizeResponsesInput } from "../formats/responsesApi.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";

// Responses API enforces max 64 chars on call_id (#393)
const MAX_CALL_ID_LEN = 64;
const clampCallId = (id) => (typeof id === "string" && id.length > MAX_CALL_ID_LEN ? id.substring(0, MAX_CALL_ID_LEN) : id);

/**
 * Convert OpenAI Responses API request to OpenAI Chat Completions format
 */
export function openaiResponsesToOpenAIRequest(model, body, stream, credentials) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolResults = [];
  let pendingReasoning = "";

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  // Extract reasoning text from summary[].text or encrypted_content fallback
  const extractReasoningText = (item) => {
    if (Array.isArray(item.summary)) {
      const txt = item.summary.map(s => s?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    if (Array.isArray(item.content)) {
      const txt = item.content.map(c => c?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    return "";
  };

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            const url = c.image_url || c.file_id || "";
            return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: c.detail || "auto" } };
          }
          return c;
        })
        : item.content;
      const msg = { role: item.role, content };
      // Attach buffered reasoning to assistant turn (required by xiaomi-mimo thinking mode)
      if (item.role === ROLE.ASSISTANT && pendingReasoning) {
        msg.reasoning_content = pendingReasoning;
      }
      pendingReasoning = "";
      result.messages.push(msg);
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
        if (pendingReasoning) {
          currentAssistantMsg.reasoning_content = pendingReasoning;
          pendingReasoning = "";
        }
      }
      // Skip items with empty/missing name — Codex/OpenAI reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush any pending tool results first
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }
      // Add tool result immediately
      result.messages.push({
        role: ROLE.TOOL,
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
      });
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      // Buffer reasoning text; attached to next assistant message/function_call
      const txt = extractReasoningText(item);
      if (txt) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${txt}` : txt;
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Convert tools format.
  // Responses API supports "hosted" tools (e.g. { type: "request_user_input" }) that carry no
  // explicit `name` field and cannot be represented as Chat Completions function declarations.
  // Filter them out to avoid sending nameless functionDeclarations to downstream providers
  // such as Gemini, which strictly validates function names.
  // Track whether apply_patch was present — if so, inject fallback instruction
  let hasApplyPatch = false;

  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools
      .map(tool => {
        // Already in Chat Completions format: { type: "function", function: { name, ... } }
        if (tool.function) return tool;
        // apply_patch is a "custom" type tool with a Lark grammar format field.
        // Grammar-constrained generation only works on OpenAI's native Codex endpoint.
        // When routing through Chat Completions (e.g. AgentRouter), strip it and fall
        // back to shell_command — injected as a system instruction below.
        if (tool.type === "custom") {
          if (tool.name === "apply_patch") hasApplyPatch = true;
          return null; // Drop custom tools — not supported in Chat Completions
        }
        // Map built-in tool_search tool
        if (tool.type === "tool_search") {
          return {
            type: OPENAI_BLOCK.FUNCTION,
            function: {
              name: "tool_search",
              description: String(tool.description || ""),
              parameters: normalizeToolParameters(tool.parameters)
            }
          };
        }
        // Map built-in web_search tool
        if (tool.type === "web_search") {
          return {
            type: OPENAI_BLOCK.FUNCTION,
            function: {
              name: "web_search",
              description: "Search the web for information.",
              parameters: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "The search query to look up on the web."
                  }
                },
                required: ["query"]
              }
            }
          };
        }
        // Responses API function tool: { type: "function", name, description, parameters }
        // Only convert when a non-empty name is present; skip hosted tools without one.
        const name = tool.name;
        if (!name || typeof name !== "string" || name.trim() === "") return null;
        return {
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name,
            description: String(tool.description || ""),
            parameters: normalizeToolParameters(tool.parameters),
            strict: tool.strict
          }
        };
      })
      .filter(Boolean);
  }

  // apply_patch was stripped: inject fallback instruction into system message so the
  // model uses shell_command (PowerShell) for file writes instead.
  if (hasApplyPatch && Array.isArray(result.messages) && result.messages.length > 0) {
    const APPLY_PATCH_FALLBACK = "\n\nIMPORTANT: The apply_patch tool is not available in this environment. " +
      "To create or edit files, use the shell_command tool with PowerShell. Rules:\n" +
      "- Create directories: New-Item -ItemType Directory -Force -Path 'dir/path' (NEVER use -LiteralPath with New-Item)\n" +
      "- Write a file: Set-Content -Path 'file.txt' -Value 'content' -Encoding UTF8\n" +
      "- Append to a file: Add-Content -Path 'file.txt' -Value 'more content' -Encoding UTF8\n" +
      "- Write multi-line file: use a here-string assigned to a variable, then Set-Content -Path 'file.txt' -Value $content -Encoding UTF8\n" +
      "- Do NOT use -LiteralPath with New-Item; it is unsupported. Use -Path instead.";
    const sysMsg = result.messages.find(m => m.role === ROLE.SYSTEM);
    if (sysMsg) {
      if (typeof sysMsg.content === "string") sysMsg.content += APPLY_PATCH_FALLBACK;
      else if (Array.isArray(sysMsg.content)) sysMsg.content.push({ type: "text", text: APPLY_PATCH_FALLBACK });
    } else {
      result.messages.unshift({ role: ROLE.SYSTEM, content: APPLY_PATCH_FALLBACK.trim() });
    }
  }


  // Cleanup Responses API specific fields
  // Map Responses-only max_output_tokens to Chat max_tokens (avoid leaking unknown field upstream)
  if (result.max_output_tokens !== undefined) {
    if (result.max_tokens === undefined) result.max_tokens = result.max_output_tokens;
    delete result.max_output_tokens;
  }

  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;

  return result;
}

/**
 * Ensure object schema always has properties field (required by Codex Responses API)
 */
function normalizeToolParameters(params) {
  if (!params) return { type: "object", properties: {} };
  if (params.type === "object" && !params.properties) return { ...params, properties: {} };
  return params;
}

/**
 * Convert OpenAI Chat Completions to OpenAI Responses API format
 */
export function openaiToOpenAIResponsesRequest(model, body, stream, credentials) {
  // Body already in Responses API format (e.g. Cursor CLI calling /chat/completions with input[])
  if (body.input) return { ...body, model, stream: true };

  const result = {
    model,
    input: [],
    stream: true,
    store: false
  };

  // Extract system message as instructions
  let hasSystemMessage = false;
  const messages = body.messages || [];

  for (const msg of messages) {
    if (msg.role === ROLE.SYSTEM) {
      // Use first system message as instructions
      if (!hasSystemMessage) {
        result.instructions = typeof msg.content === "string" ? msg.content : "";
        hasSystemMessage = true;
      }
      continue; // Skip system messages in input
    }

    // Convert user/assistant messages to input items
    if (msg.role === ROLE.USER || msg.role === ROLE.ASSISTANT) {
      const contentType = msg.role === ROLE.USER ? RESPONSES_ITEM.INPUT_TEXT : RESPONSES_ITEM.OUTPUT_TEXT;
      const content = typeof msg.content === "string"
        ? [{ type: contentType, text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content.map(c => {
            if (c.type === OPENAI_BLOCK.TEXT) return { type: contentType, text: c.text };
            // Convert Chat Completions image_url → Responses API input_image
            // Responses API expects: { type: "input_image", image_url: "<url string>" }
            // Chat Completions sends: { type: "image_url", image_url: { url: "...", detail: "..." } }
            if (c.type === OPENAI_BLOCK.IMAGE_URL) {
              const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
              return { type: RESPONSES_ITEM.INPUT_IMAGE, image_url: url, detail: c.image_url?.detail || "auto" };
            }
            if (c.type === RESPONSES_ITEM.INPUT_IMAGE) return c;
            // Serialize any unknown type (tool_use, tool_result, thinking, etc.) as text
            const text = c.text || c.content || JSON.stringify(c);
            return { type: contentType, text: typeof text === "string" ? text : JSON.stringify(text) };
          })
          : [];

      // Only push a message block if content is non-empty.
      // Assistant messages with only tool_calls have content: null — skip the
      // message block in that case; the tool_calls are pushed separately below.
      if (content.length > 0) {
        result.input.push({
          type: RESPONSES_ITEM.MESSAGE,
          role: msg.role,
          content
        });
      }
    }

    // Convert tool calls
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        result.input.push({
          type: RESPONSES_ITEM.FUNCTION_CALL,
          call_id: clampCallId(tc.id),
          name: tc.function?.name || "_unknown",
          arguments: tc.function?.arguments || "{}"
        });
      }
    }

    // Convert tool results - output must be a string for Responses API
    if (msg.role === ROLE.TOOL) {
      const output = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(c => c.text || JSON.stringify(c)).join("")
          : JSON.stringify(msg.content);
      result.input.push({
        type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT,
        call_id: clampCallId(msg.tool_call_id),
        output
      });
    }
  }

  // If no system message, leave instructions empty (will be filled by executor)
  if (!hasSystemMessage) {
    result.instructions = "";
  }

  // Convert tools format
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => {
      if (tool.type === OPENAI_BLOCK.FUNCTION) {
        return {
          type: OPENAI_BLOCK.FUNCTION,
          name: tool.function.name,
          description: String(tool.function.description || ""),
          parameters: normalizeToolParameters(tool.function.parameters),
          strict: tool.function.strict
        };
      }
      // Preserve "custom" type tools (e.g. apply_patch) and other non-function types as-is.
      return tool;
    });
  }

  // Pass through other relevant fields
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  return result;
}

// Register both directions
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, openaiResponsesToOpenAIRequest, null);
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, openaiToOpenAIResponsesRequest, null);
