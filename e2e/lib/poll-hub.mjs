/** Poll hub /payload-inspect until it sees the trace, up to ``timeoutMs``. */
export async function pollForPayload(hub, traceId, { timeoutMs = 5000 } = {}) {
  if (!traceId) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await hub.payloadInspect(traceId);
    if (r.status === 200 && r.body?.payload_message_count > 0) return;
    await new Promise((res) => setTimeout(res, 200));
  }
}
