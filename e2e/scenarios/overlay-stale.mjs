/**
 * Mark a past turn as ``stale`` via the hub, then send the next turn
 * and confirm the model's system prompt has the STALE annotation.
 *
 * This is the load-bearing assertion for the project's Why — that we
 * can change what the model sees by editing memory, not the conversation.
 */
import { finalText } from "../lib/script-fixtures.mjs";

export async function run({ hub, bridge, mode, scriptFake, randomChatId, randomUserId }) {
  const userId = randomUserId();
  const chatId = randomChatId();

  // 1. Mark message index 0 as stale before any turn.
  const markResp = await hub.setChatMark(userId, chatId, 0, "stale");

  if (mode === "fake") {
    await scriptFake([finalText("ok")]);
  }

  // 2. Send a turn. The bridge should read the snapshot and prepend
  //    the STALE annotation to the system prompt.
  const resp = await bridge.chat({
    userId,
    chatId,
    model: "MiniMax-M2",
    messages: [{ role: "user", content: "what did i mean before?" }],
  });

  const overlayMeta = resp.body?.pi_adapter?.overlay;
  const aohTraceId = resp.body?.pi_adapter?.aoh_trace_id;

  // 3. payload-inspect against the hub confirms the annotation reached
  //    the wire — the most defensible assertion we have.
  // The hub only sees the trace if the bridge writes observation events.
  // If observation isn't configured, fall back to inspecting the bridge
  // response shape directly.
  let payloadInspectBody = null;
  if (aohTraceId) {
    const ins = await hub.payloadInspect(aohTraceId);
    payloadInspectBody = ins.body;
  }

  const checks = {
    mark_returned_200: markResp.status === 200,
    bridge_returned_200: resp.status === 200,
    bridge_reports_overlay_applied: (overlayMeta?.applied ?? 0) >= 1,
    bridge_reports_annotation_chars_gt_0: (overlayMeta?.annotation_chars ?? 0) > 0,
  };
  if (payloadInspectBody && payloadInspectBody.annotation_in_system_prompt !== undefined) {
    checks.hub_payload_has_stale_annotation =
      payloadInspectBody.annotation_in_system_prompt === true &&
      (payloadInspectBody.annotation_mentions ?? []).includes("STALE");
  }
  const passed = Object.values(checks).every(Boolean);

  return {
    passed,
    evidence: {
      checks,
      user_id: userId,
      chat_id: chatId,
      mark_response: markResp.body,
      pi_adapter_overlay: overlayMeta,
      aoh_trace_id: aohTraceId,
      payload_inspect: payloadInspectBody,
    },
  };
}
