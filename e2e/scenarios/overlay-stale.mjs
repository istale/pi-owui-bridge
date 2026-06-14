/**
 * Mark a past turn as ``stale`` via the hub, then send the next turn
 * and confirm the model's system prompt has the STALE annotation.
 *
 * This is the load-bearing assertion for the project's Why — that we
 * can change what the model sees by editing memory, not the conversation.
 */
import { finalText } from "../lib/script-fixtures.mjs";
import { pollForPayload } from "../lib/poll-hub.mjs";

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

  // 3. Wait briefly for the hub tailer to ingest the bridge's
  //    before_provider_payload emission, then payload-inspect.
  // Hub tailer is async; give it room to ingest the bridge's JSONL line.
  await pollForPayload(hub, aohTraceId);
  let payloadInspectBody = null;
  if (aohTraceId) {
    const ins = await hub.payloadInspect(aohTraceId);
    payloadInspectBody = ins.body;
  }

  // Stage 12.5: assertions tightened. The bridge now mirrors Pi's
  // ``before_provider_payload`` events into the hub-readable observation
  // tree keyed by our aoh_trace_id, so payload-inspect can give a
  // direct answer to "did STALE actually reach the model?". A passing
  // overlay-stale run REQUIRES the hub to report the annotation.
  const overlayState = await hub.getChatOverlay(userId, chatId);
  const checks = {
    mark_returned_200: markResp.status === 200,
    bridge_returned_200: resp.status === 200,
    hub_lists_the_mark: (overlayState.body?.overlays ?? []).some((o) => o.mark === "stale"),
    hub_snapshot_present: overlayState.body?.snapshot_present === true,
    hub_received_payload_for_trace: payloadInspectBody?.payload_message_count > 0,
    hub_payload_has_stale_annotation:
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
      mark_response: markResp.body,
      pi_adapter_overlay: overlayMeta,
      aoh_trace_id: aohTraceId,
      payload_inspect: payloadInspectBody,
    },
  };
}
