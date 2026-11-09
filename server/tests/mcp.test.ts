import test from "node:test";
import assert from "node:assert/strict";
import { sessionMessages } from "../packages/server-core/src/mcp/sessions.js";

await test("readable sessions omit analysis, tools and setup while retaining real repeated turns", () => {
  const message = (role: string, text: string) => ({
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
  const records = [
    { type: "session_meta", payload: {} },
    message(
      "user",
      "# AGENTS.md instructions\n<INSTRUCTIONS>Private setup</INSTRUCTIONS>",
    ),
    message(
      "user",
      "<environment_context>setup</environment_context>\n## My request:\nFix login",
    ),
    {
      type: "response_item",
      payload: {
        role: "assistant",
        channel: "analysis",
        content: "Hidden reasoning",
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", output: "PRIVATE_TOOL_DATA" },
    },
    message("assistant", "Use PKCE"),
    {
      type: "event_msg",
      payload: { type: "agent_message", message: "Use PKCE" },
    },
    { type: "event_msg", payload: { type: "task_started" } },
    message("user", "Fix login"),
    message("assistant", "Use PKCE"),
  ];
  assert.deepEqual(sessionMessages(records), [
    { role: "user", text: "Fix login" },
    { role: "assistant", text: "Use PKCE" },
    { role: "user", text: "Fix login" },
    { role: "assistant", text: "Use PKCE" },
  ]);
});

await test("Claude messages infer roles and ignore tool results, metadata and thinking blocks", () => {
  assert.deepEqual(
    sessionMessages([
      { type: "user", message: { content: "Help with onboarding" } },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "not a user message" }],
        },
      },
      { type: "user", isMeta: true, message: { content: "Injected setup" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Start with email" },
          ],
        },
      },
    ]),
    [
      { role: "user", text: "Help with onboarding" },
      { role: "assistant", text: "Start with email" },
    ],
  );
});
