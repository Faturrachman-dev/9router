/**
 * Unit tests for open-sse/translator/request/openai-to-commandcode.js
 *
 * Verified live against upstream `/alpha/generate` (curl, 2026-05-07):
 *  - params.system: STRING at top level (Anthropic-style; "system" role NOT in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array<content_block> (NEVER string)
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 */

import { describe, it, expect } from "vitest";
import { openaiToCommandCodeRequest } from "../../open-sse/translator/request/openai-to-commandcode.js";

const MODEL = "moonshotai/Kimi-K2.6";

describe("openaiToCommandCodeRequest — basic envelope", () => {
  it("returns the expected top-level envelope shape", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
    }, true);

    expect(out).toHaveProperty("threadId");
    expect(out).toHaveProperty("memory");
    expect(out).toHaveProperty("config");
    expect(out).toHaveProperty("params");
    expect(out.params.model).toBe(MODEL);
    expect(out.params.stream).toBe(true);
  });
});

describe("openaiToCommandCodeRequest — system handling", () => {
  it("hoists system messages to params.system (string), not messages[]", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "hi" },
      ],
    }, true);

    expect(typeof out.params.system).toBe("string");
    expect(out.params.system).toBe("You are concise.");
    const roles = out.params.messages.map((m) => m.role);
    expect(roles).not.toContain("system");
  });

  it("joins multiple system messages with blank line", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "system", content: "A" },
        { role: "system", content: "B" },
        { role: "user", content: "hi" },
      ],
    }, true);

    expect(out.params.system).toBe("A\n\nB");
  });

  it("omits params.system when no system messages", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
    }, true);
    expect(out.params.system).toBeUndefined();
  });
});

describe("openaiToCommandCodeRequest — content shape", () => {
  it("MUST always emit content as Array (never string) for user", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hello" }],
    }, true);

    const u = out.params.messages[0];
    expect(Array.isArray(u.content)).toBe(true);
    expect(u.content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("MUST always emit content as Array for assistant", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    }, true);
    const a = out.params.messages[1];
    expect(Array.isArray(a.content)).toBe(true);
    expect(a.content[0]).toEqual({ type: "text", text: "b" });
  });
});

describe("openaiToCommandCodeRequest — historical tool compatibility", () => {
  it("flattens historical tool results to labeled user text for CommandCode compatibility", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: "run X" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "do_x", arguments: "{\"a\":1}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", name: "do_x", content: "RESULT_OK" },
      ],
    }, true);

    expect(out.params.messages).toHaveLength(1);
    const transcript = out.params.messages[0];
    expect(transcript.role).toBe("user");
    expect(transcript.content[0].text).toContain("[tool result do_x call_1]\nRESULT_OK");
  });

  it("recovers an omitted tool-result name from the matching assistant call id", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        {
          role: "assistant",
          content: "I will search.",
          tool_calls: [
            { id: "call_2", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_2", content: "FOUND" },
      ],
    }, true);

    expect(out.params.messages[0].content[0].text).toContain("lookup");
  });
});

describe("openaiToCommandCodeRequest — historical assistant tool calls", () => {
  it("flattens historical assistant tool calls to labeled text with arguments", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "I will search.",
          tool_calls: [
            { id: "call_42", type: "function", function: { name: "search", arguments: "{\"q\":\"hi\"}" } },
          ],
        },
      ],
    }, true);

    expect(out.params.messages).toHaveLength(1);
    const transcript = out.params.messages[0];
    expect(transcript.role).toBe("user");
    const text = transcript.content.map((b) => b.text || "").join("\n");
    expect(text).toContain("I will search.");
    expect(text).toContain('[tool call search call_42] {"q":"hi"}');
  });

  it("preserves image blocks when collapsing tool history", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [
        { role: "user", content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ] },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_img", type: "function", function: { name: "inspect", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_img", content: "done" },
      ],
    }, true);

    expect(out.params.messages).toHaveLength(1);
    expect(out.params.messages[0].content).toContainEqual({
      type: "image",
      image: "AAAA",
      mediaType: "image/png",
    });
  });
});

describe("openaiToCommandCodeRequest — tools schema conversion", () => {
  it("converts OpenAI {type:\"function\", function:{...}} to Anthropic plain {name, input_schema}", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        },
      ],
    }, true);

    const t = out.params.tools[0];
    expect(t.name).toBe("weather");
    expect(t.input_schema).toBeDefined();
    expect(t.input_schema.type).toBe("object");
    expect(t.function).toBeUndefined();
    expect(t.parameters).toBeUndefined();
  });

  it("preserves description on converted tool", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "ping", description: "Ping the server", parameters: { type: "object" } } },
      ],
    }, true);
    expect(out.params.tools[0].description).toBe("Ping the server");
  });

  it("does not include tools field when input has none", () => {
    const out = openaiToCommandCodeRequest(MODEL, {
      messages: [{ role: "user", content: "hi" }],
    }, true);
    expect(out.params.tools).toBeUndefined();
  });
});
