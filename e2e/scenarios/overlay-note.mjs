/**
 * functional_overlay.md Scenario 6 — Note attached to a mark surfaces
 * in the annotation. Catches the "note saved to DB but stripped from
 * snapshot" class of bug.
 */
import { finalText } from "../lib/script-fixtures.mjs";
import { pollForPayload } from "../lib/poll-hub.mjs";
import { piSessionId } from "../lib/pi-session-id.mjs";

export async function run({ hub, bridge, mode, scriptFake, randomChatId, randomUserId }) {
  const userId = randomUserId();
  const chatId = randomChatId();
  const sid = piSessionId(userId, chatId);
  const noteSentinel = `FUNCTEST_NOTE_${Math.random().toString(36).slice(2, 10)}`;

  if (mode === "fake") {
    await scriptFake([finalText("r1"), finalText("r2")]);
  }
  await bridge.chat({
    userId, chatId, model: "MiniMax-M2",
    messages: [{ role: "user", content: "warm" }],
  });

  await hub.setChatMark(userId, chatId, 0, "stale");
  await hub.setChatNote(userId, chatId, 0, noteSentinel);

  const chatOverlay = await hub.getChatOverlay(userId, chatId);
  const dbRow = (chatOverlay.body?.overlays ?? []).find((o) => o.index === 0);

  const since = new Date().toISOString();
  const second = await bridge.chat({
    userId, chatId, model: "MiniMax-M2",
    messages: [{ role: "user", content: "after_note" }],
  });
  const tid = second.body?.pi_adapter?.aoh_trace_id;
  if (tid) await pollForPayload(hub, tid);
  const ins = tid ? await hub.payloadInspect(tid) : null;
  const annotationContainsNote =
    (ins?.body?.first_system_msg_excerpt ?? "").includes(noteSentinel);

  const checks = {
    db_row_has_note: dbRow?.note === noteSentinel,
    second_turn_200: second.status === 200,
    annotation_in_system_prompt:
      ins?.body?.annotation_in_system_prompt === true,
    annotation_contains_note: annotationContainsNote,
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    passed,
    evidence: {
      checks,
      user_id: userId, chat_id: chatId, session_id: sid,
      note_sentinel: noteSentinel,
      db_overlay_row: dbRow,
    },
  };
}
