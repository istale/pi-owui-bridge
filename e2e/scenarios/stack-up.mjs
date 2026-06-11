/**
 * Verify every service is reachable and reporting sane health.
 *
 * The cheapest scenario. If this fails, the rest will fail too — use
 * its evidence (e.g. `bridge.tool_count === 0`) as the first diagnostic.
 */
export async function run({ owui, hub, bridge }) {
  const owuiHealth = await owui.healthz();
  const hubHealth = await hub.healthz();
  const bridgeHealth = await bridge.healthz();

  const checks = {
    owui_reachable: owuiHealth.status === 200,
    hub_reachable: hubHealth.status === 200,
    bridge_reachable: bridgeHealth.status === 200,
    bridge_tool_count_ge_1: (bridgeHealth.body?.tool_count ?? 0) >= 1,
  };
  const passed = Object.values(checks).every(Boolean);

  return {
    passed,
    evidence: {
      checks,
      owui_health: owuiHealth.body,
      hub_health: hubHealth.body,
      bridge_health: bridgeHealth.body,
    },
  };
}
