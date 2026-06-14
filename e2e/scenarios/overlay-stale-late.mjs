/**
 * Same Why as ``overlay-stale``, but the user marks the turn AFTER the
 * Pi process is already running. This catches the bug where the overlay
 * symlink is only built at spawn time: if a user marks turns mid-chat,
 * the next prompt must pick up the change.
 *
 * Sequence:
 *   1. Send one prompt (warms up the Pi process).
 *   2. Mark message 0 as stale.
 *   3. Send a second prompt.
 *   4. Assert STALE annotation reached the model on the second turn.
 */
import { finalText } from "../lib/script-fixtures.mjs";
import { pollForPayload } from "../lib/poll-hub.mjs";

export async function run({ hub, bridge, mode, scriptFake, randomChatId, randomUserId }) {
  const userId = randomUserId();
  const chatId = randomChatId();

  // Turn 1: cold call, no overlay.
  if (mode === "fake") {
    await scriptFake([finalText("first reply"), finalText("second reply")]);
  }
  const first = await bridge.chat({
    userId,
    chatId,
    model: "MiniMax-M2",
    messages: [{ role: "user", content: "hi, what can you tell me?" }],
  });

  // Now user marks the first turn stale.
  const markResp = await hub.setChatMark(userId, chatId, 0, "stale");

  // Turn 2: reuses the same Pi process; bridge must refresh the
  // overlay symlink for Pi to actually see the new mark.
  const second = await bridge.chat({
    userId,
    chatId,
    model: "MiniMax-M2",
    messages: [{ role: "user", content: "what did i mean before?" }],
  });

  const aohTraceId = second.body?.pi_adapter?.aoh_trace_id;
  await pollForPayload(hub, aohTraceId);
  let payloadInspectBody = null;
  if (aohTraceId) {
    const ins = await hub.payloadInspect(aohTraceId);
    payloadInspectBody = ins.body;
  }

  const checks = {
    first_turn_returned_200: first.status === 200,
    mark_returned_200: markResp.status === 200,
    second_turn_returned_200: second.status === 200,
    hub_received_payload_for_second_turn: payloadInspectBody?.payload_message_count > 0,
    second_turn_payload_has_stale_annotation:
      payloadInspectBody?.annotation_in_system_prompt === true &&
      (payloadInspectBody?.annotation_mentions ?? []).includes("STALE"),
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    passed,
    evidence: {
      checks,
      user_id: userId,
      chat_id: chatId,
      second_turn_trace_id: aohTraceId,
      payload_inspect: payloadInspectBody,
    },
  };
}
