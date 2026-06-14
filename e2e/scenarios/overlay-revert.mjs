/**
 * functional_overlay.md Scenario 4 — Revert to active deletes snapshot.
 * Mark a turn stale, then revert it to active. The next prompt must
 * see no annotation in the system prompt and no overlay_applied event.
 * Catches the "snapshot left behind" bug class.
 */
import { finalText } from "../lib/script-fixtures.mjs";
import { pollForPayload } from "../lib/poll-hub.mjs";
import { piSessionId } from "../lib/pi-session-id.mjs";

export async function run({ hub, bridge, mode, scriptFake, randomChatId, randomUserId }) {
  const userId = randomUserId();
  const chatId = randomChatId();
  const sid = piSessionId(userId, chatId);

  if (mode === "fake") {
    await scriptFake([finalText("r1"), finalText("r2"), finalText("r3")]);
  }
  // Warm-up so message 0 exists in chat.
  const first = await bridge.chat({
    userId, chatId, model: "MiniMax-M2",
    messages: [{ role: "user", content: "warm" }],
  });

  // Mark stale, snapshot should be written to chats/<u>/<c>.json.
  await hub.setChatMark(userId, chatId, 0, "stale");
  const afterMark = await hub.getChatOverlay(userId, chatId);

  // Revert to active.
  await hub.setChatMark(userId, chatId, 0, "active");
  const afterRevert = await hub.getChatOverlay(userId, chatId);

  // Drive another turn — must see no overlay.
  const since = new Date().toISOString();
  const second = await bridge.chat({
    userId, chatId, model: "MiniMax-M2",
    messages: [{ role: "user", content: "after_revert" }],
  });
  const tid = second.body?.pi_adapter?.aoh_trace_id;
  if (tid) await pollForPayload(hub, tid);
  const summary = await hub.sessionSummary(sid, since);
  const modelCalls = summary.body?.model_calls ?? [];
  const anyFired = modelCalls.some((c) => c.overlay_applied?.fired);
  const ins = tid ? await hub.payloadInspect(tid) : null;

  const checks = {
    first_turn_200: first.status === 200,
    snapshot_present_after_mark: afterMark.body?.snapshot_present === true,
    snapshot_absent_after_revert: afterRevert.body?.snapshot_present === false,
    second_turn_200: second.status === 200,
    no_overlay_applied_after_revert: !anyFired,
    no_annotation_after_revert: ins?.body?.annotation_in_system_prompt !== true,
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    passed,
    evidence: {
      checks,
      user_id: userId, chat_id: chatId, session_id: sid,
      second_turn_trace_id: tid,
    },
  };
}
