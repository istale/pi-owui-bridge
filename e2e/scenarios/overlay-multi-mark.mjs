/**
 * functional_overlay.md Scenario 5 — Multi-mark (stale + background).
 * Different mark kinds must coexist in the DB AND surface together in
 * the system-prompt annotation.
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

  // Two warm-up turns so Pi's session has 4 entries:
  //   index 0 = user "first turn"
  //   index 1 = assistant "r1"
  //   index 2 = user "second turn"
  //   index 3 = assistant "r2"
  // Pi's overlay system only annotates user / assistant content turns
  // (not tool messages); empirically it ignores marks on assistant
  // messages too, so we mark the TWO USER messages, one stale and one
  // background, to exercise the multi-mark code path.
  await bridge.chat({
    userId, chatId, model: "MiniMax-M2",
    messages: [{ role: "user", content: "first turn" }],
  });
  await bridge.chat({
    userId, chatId, model: "MiniMax-M2",
    messages: [{ role: "user", content: "second turn" }],
  });

  await hub.setChatMark(userId, chatId, 0, "stale");
  await hub.setChatMark(userId, chatId, 2, "background");

  const chatOverlay = await hub.getChatOverlay(userId, chatId);
  const marks = new Set((chatOverlay.body?.overlays ?? []).map((o) => o.mark));

  // Drive one more prompt so overlay_applied fires. We don't pass a
  // since filter — agent_events ts comes from Pi which may use its own
  // clock; the full session view is small and the LAST model call is
  // unambiguously this one.
  const next = await bridge.chat({
    userId, chatId, model: "MiniMax-M2",
    messages: [{ role: "user", content: "after marks" }],
  });
  const tid = next.body?.pi_adapter?.aoh_trace_id;
  if (tid) await pollForPayload(hub, tid);
  const summary = await hub.sessionSummary(sid);
  const lastCall = summary.body?.model_calls?.at(-1);
  const mentions = new Set(lastCall?.payload_inspection?.annotation_mentions ?? []);

  const checks = {
    db_has_stale_mark: marks.has("stale"),
    db_has_background_mark: marks.has("background"),
    overlay_applied_fired: lastCall?.overlay_applied?.fired === true,
    overlay_stale_count_positive: (lastCall?.overlay_applied?.stale_count ?? 0) >= 1,
    overlay_background_count_positive: (lastCall?.overlay_applied?.background_count ?? 0) >= 1,
    annotation_mentions_stale: mentions.has("STALE"),
    annotation_mentions_background: mentions.has("BACKGROUND"),
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    passed,
    evidence: {
      checks,
      user_id: userId, chat_id: chatId, session_id: sid,
      trace_id: tid,
      db_marks: [...marks],
      annotation_mentions: [...mentions],
    },
  };
}
