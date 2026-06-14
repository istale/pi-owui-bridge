/**
 * functional_overlay.md Scenario 7 — Kill switch.
 * ``AOH_OVERLAY_DISABLE=1`` on the Pi process must short-circuit
 * overlay application even when marks exist. Catches "kill switch
 * forgotten in a code path" regression.
 *
 * The bridge spawns Pi with ``...process.env``, so this scenario
 * needs the killswitch set on the *runner* process so it propagates
 * down to the ephemeral bridge and then to Pi. To enable, run:
 *
 *   AOH_OVERLAY_DISABLE=1 node e2e/run.mjs --scenario=overlay-killswitch
 *
 * If the flag is absent we report a SKIP-style pass with a clear
 * evidence note rather than fail or silently no-op.
 */
import { finalText } from "../lib/script-fixtures.mjs";
import { pollForPayload } from "../lib/poll-hub.mjs";
import { piSessionId } from "../lib/pi-session-id.mjs";

export async function run({ hub, bridge, mode, scriptFake, randomChatId, randomUserId }) {
  if (process.env.AOH_OVERLAY_DISABLE !== "1") {
    return {
      passed: true,
      evidence: {
        skipped: true,
        reason:
          "kill switch scenario only runs when AOH_OVERLAY_DISABLE=1 is set on the runner — start runner with that env to exercise it",
      },
    };
  }

  const userId = randomUserId();
  const chatId = randomChatId();
  const sid = piSessionId(userId, chatId);

  if (mode === "fake") {
    await scriptFake([finalText("r1"), finalText("r2")]);
  }
  await bridge.chat({
    userId, chatId, model: "MiniMax-M2",
    messages: [{ role: "user", content: "warm" }],
  });
  await hub.setChatMark(userId, chatId, 0, "stale");

  const since = new Date().toISOString();
  const second = await bridge.chat({
    userId, chatId, model: "MiniMax-M2",
    messages: [{ role: "user", content: "with kill switch" }],
  });
  const tid = second.body?.pi_adapter?.aoh_trace_id;
  if (tid) await pollForPayload(hub, tid);

  const chatOverlay = await hub.getChatOverlay(userId, chatId);
  const summary = await hub.sessionSummary(sid, since);
  const modelCalls = summary.body?.model_calls ?? [];
  const anyFired = modelCalls.some((c) => c.overlay_applied?.fired);
  const annotated = modelCalls.some(
    (c) => c.payload_inspection?.annotation_in_system_prompt === true,
  );

  const checks = {
    second_turn_200: second.status === 200,
    chat_snapshot_still_present: chatOverlay.body?.snapshot_present === true,
    no_overlay_applied_fired: !anyFired,
    no_annotation_in_system_prompt: !annotated,
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    passed,
    evidence: { checks, user_id: userId, chat_id: chatId, session_id: sid, trace_id: tid },
  };
}
