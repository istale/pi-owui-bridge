/**
 * functional_overlay.md Scenario 1 — Baseline.
 * A fresh chat with no marks must produce no overlay snapshot and no
 * overlay_applied event. Catches accidentally always-on overlay code.
 */
import { finalText } from "../lib/script-fixtures.mjs";
import { pollForPayload } from "../lib/poll-hub.mjs";
import { piSessionId } from "../lib/pi-session-id.mjs";

export async function run({ hub, bridge, mode, scriptFake, randomChatId, randomUserId }) {
  const userId = randomUserId();
  const chatId = randomChatId();
  const sid = piSessionId(userId, chatId);

  if (mode === "fake") {
    await scriptFake([finalText("baseline reply")]);
  }
  const resp = await bridge.chat({
    userId, chatId, model: "MiniMax-M2",
    messages: [{ role: "user", content: "baseline_one" }],
  });
  const traceId = resp.body?.pi_adapter?.aoh_trace_id;
  if (traceId) await pollForPayload(hub, traceId);

  // Chat-keyed DB + snapshot view (DB row count, file present).
  const chatOverlay = await hub.getChatOverlay(userId, chatId);
  // Pi-side session id is what overlay_applied events are keyed by.
  const summary = await hub.sessionSummary(sid);
  const modelCalls = summary.body?.model_calls ?? [];
  const anyFired = modelCalls.some((c) => c.overlay_applied?.fired);
  // Also: payload must not contain an annotation.
  const ins = traceId ? await hub.payloadInspect(traceId) : null;

  const checks = {
    turn_returned_200: resp.status === 200,
    chat_overlay_db_empty: (chatOverlay.body?.overlays ?? []).length === 0,
    chat_snapshot_absent: chatOverlay.body?.snapshot_present === false,
    no_overlay_applied_fired: !anyFired,
    no_annotation_in_system_prompt:
      ins?.body?.annotation_in_system_prompt !== true,
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    passed,
    evidence: { checks, user_id: userId, chat_id: chatId, session_id: sid, trace_id: traceId },
  };
}
