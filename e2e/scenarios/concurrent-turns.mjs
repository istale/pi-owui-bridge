/**
 * Concurrency e2e for the P1 fix (commit 9a2e399 — Serialise turns per
 * Pi process to prevent trace-id race).
 *
 * Sequence:
 *   1. Same (user_id, chat_id), fire two /v1/chat/completions in
 *      parallel.
 *   2. Both must return 200 with DIFFERENT aoh_trace_id values.
 *   3. Hub must have ingested TWO before_provider_payload events, one
 *      per trace, each with the right user prompt.
 *
 * Without runTurn the two turns would race on the .aoh-current-trace-id
 * sidecar and at least one ``message_end`` would be tagged with the
 * other turn's trace id — payload-inspect would return mismatched
 * content per trace.
 */
import { finalText } from "../lib/script-fixtures.mjs";
import { pollForPayload } from "../lib/poll-hub.mjs";

export async function run({ hub, bridge, mode, scriptFake, randomChatId, randomUserId }) {
  const userId = randomUserId();
  const chatId = randomChatId();

  // Two distinct user prompts so we can verify which payload belongs
  // to which trace. If runTurn fails, prompts get cross-tagged.
  const promptA = `concurrent_marker_A_${Math.random().toString(36).slice(2, 8)}`;
  const promptB = `concurrent_marker_B_${Math.random().toString(36).slice(2, 8)}`;

  if (mode === "fake") {
    // Fake upstream replies in the order it receives requests. Either
    // turn's reply works for either prompt — we only assert on the
    // payload Pi forwarded to the model, not on the model's response.
    await scriptFake([finalText("reply 1"), finalText("reply 2")]);
  }

  // Fire both in parallel. Promise.all so any rejection surfaces.
  const [respA, respB] = await Promise.all([
    bridge.chat({
      userId,
      chatId,
      model: "MiniMax-M2",
      messages: [{ role: "user", content: promptA }],
    }),
    bridge.chat({
      userId,
      chatId,
      model: "MiniMax-M2",
      messages: [{ role: "user", content: promptB }],
    }),
  ]);

  const traceA = respA.body?.pi_adapter?.aoh_trace_id;
  const traceB = respB.body?.pi_adapter?.aoh_trace_id;

  // Wait for both payloads to land in the hub.
  if (traceA) await pollForPayload(hub, traceA);
  if (traceB) await pollForPayload(hub, traceB);

  let insA = null;
  let insB = null;
  if (traceA) insA = (await hub.payloadInspect(traceA)).body;
  if (traceB) insB = (await hub.payloadInspect(traceB)).body;

  const excerptA = insA?.first_system_msg_excerpt ?? "";
  const excerptB = insB?.first_system_msg_excerpt ?? "";

  // The system prompt itself won't contain the user prompt — find the
  // user-marker by extracting `messages` from the raw payload.
  // payload-inspect doesn't expose messages, so we infer correct
  // tagging via two indirect checks:
  //   - distinct trace ids
  //   - both payloads exist (not just one with both messages)
  // Stronger check: poll the agent-events endpoint and find the
  // before_provider_payload for each trace; verify the LAST user msg
  // contains the matching marker.
  const lastA = insA?.last_user_msg_excerpt ?? "";
  const lastB = insB?.last_user_msg_excerpt ?? "";
  const payloadAHasMarkerA = lastA.includes(promptA);
  const payloadBHasMarkerB = lastB.includes(promptB);
  const payloadACrossContaminated = lastA.includes(promptB);
  const payloadBCrossContaminated = lastB.includes(promptA);

  const checks = {
    both_returned_200: respA.status === 200 && respB.status === 200,
    both_have_trace_id: Boolean(traceA && traceB),
    traces_are_distinct: traceA !== traceB,
    both_payloads_ingested: Boolean(insA && insB),
    payload_a_has_prompt_a: payloadAHasMarkerA,
    payload_b_has_prompt_b: payloadBHasMarkerB,
    payload_a_does_not_have_prompt_b: !payloadACrossContaminated,
    payload_b_does_not_have_prompt_a: !payloadBCrossContaminated,
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    passed,
    evidence: {
      checks,
      user_id: userId,
      chat_id: chatId,
      trace_a: traceA,
      trace_b: traceB,
      prompt_a: promptA,
      prompt_b: promptB,
      first_system_msg_excerpt_a: excerptA.slice(0, 200),
      first_system_msg_excerpt_b: excerptB.slice(0, 200),
    },
  };
}
