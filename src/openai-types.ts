/** OpenAI chat completion type aliases — narrowed to what the bridge actually touches. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content?: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool" | "assistant" | "system" | "user";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
}

export type Message = ToolMessage;
