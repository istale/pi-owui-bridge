/**
 * Re-export of the bridge's own ``deterministicSessionId`` so e2e
 * scenarios can compute the same Pi-side session id the bridge uses
 * for its overlay symlink.
 *
 * History: an earlier mjs port replicated the hash by hand and silently
 * drifted from the TS implementation (the TS template literal
 * accidentally embedded a non-space byte between userId and chatId);
 * scenarios then computed the wrong session id and couldn't find the
 * agent_events emitted by Pi. Re-exporting eliminates the drift.
 */
import { deterministicSessionId } from "../../dist/pi-process.js";

export function piSessionId(userId, chatId) {
  return deterministicSessionId(userId, chatId);
}
