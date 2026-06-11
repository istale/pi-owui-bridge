/**
 * One turn that should trigger a tool call, dispatched to the OWUI tool
 * service. Verifies the cross-service join key — ``aoh_trace_id`` — is
 * present in both the bridge response and OWUI's ledger.
 */
import { toolUse, finalText } from "../lib/script-fixtures.mjs";

export async function run({ owui, bridge, mode, scriptFake, randomChatId, randomUserId }) {
  const userId = randomUserId();
  const chatId = randomChatId();

  if (mode === "fake") {
    await scriptFake([toolUse("list_datasets", {}), finalText("Here are your datasets.")]);
  }

  const resp = await bridge.chat({
    userId,
    chatId,
    model: "MiniMax-M2",
    messages: [{ role: "user", content: "list my datasets please" }],
  });

  const okStatus = resp.status === 200;
  const aohTraceId = resp.body?.pi_adapter?.aoh_trace_id;
  const sawIteration2 = resp.body?.pi_adapter?.iterations === 2;
  const sawToolCall = (resp.body?.pi_adapter?.tool_call_count ?? 0) >= 1;

  // The data_analysis_events row should carry the same aoh_trace_id.
  // Allow a brief flush for the async ledger worker.
  await new Promise((r) => setTimeout(r, 200));
  const ledger = aohTraceId ? await owui.eventsByTrace(aohTraceId) : { status: 0, body: null };

  const checks = {
    bridge_returned_200: okStatus,
    bridge_emitted_trace_id: Boolean(aohTraceId),
    bridge_ran_two_iterations: sawIteration2,
    bridge_dispatched_at_least_one_tool: sawToolCall,
    owui_ledger_has_event: (ledger.body?.count ?? 0) >= 1,
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    passed,
    evidence: {
      checks,
      user_id: userId,
      chat_id: chatId,
      aoh_trace_id: aohTraceId,
      pi_adapter_meta: resp.body?.pi_adapter,
      owui_ledger: ledger.body,
    },
  };
}
