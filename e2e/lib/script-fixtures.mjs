/** Canned LLM scripts shared by fake-mode scenarios. */

export function toolUse(toolName, args = {}, callId = "c1") {
  return {
    id: "u",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          tool_calls: [{ id: callId, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

export function finalText(text) {
  return {
    id: "u",
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
  };
}
