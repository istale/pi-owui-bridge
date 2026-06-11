/**
 * Drop a tiny skill markdown for the user, send a turn, and confirm
 * the skill ends up in the system prompt the bridge reports back.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalText } from "../lib/script-fixtures.mjs";

export async function run({ bridge, mode, scriptFake, randomChatId, randomUserId, skillsDir }) {
  const userId = randomUserId();
  const chatId = randomChatId();

  if (!skillsDir) {
    return {
      passed: false,
      evidence: { error: "AOH_SKILLS_DIR is not set on the running bridge process; skill injection cannot be tested." },
    };
  }

  const skillsRoot = join(skillsDir, userId);
  mkdirSync(skillsRoot, { recursive: true });
  const skillName = `e2e_marker_${Date.now()}`;
  const sentinel = `E2E_SKILL_SENTINEL_${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(join(skillsRoot, `${skillName}.md`), `Always include the literal string ${sentinel} in your reply.`);

  try {
    if (mode === "fake") {
      await scriptFake([finalText("ok")]);
    }
    const resp = await bridge.chat({
      userId,
      chatId,
      model: "MiniMax-M2",
      messages: [{ role: "user", content: "hi" }],
    });

    const meta = resp.body?.pi_adapter?.skills;
    const checks = {
      bridge_returned_200: resp.status === 200,
      bridge_reports_skill_applied: (meta?.applied ?? 0) >= 1,
      bridge_skill_name_matches: (meta?.names ?? []).includes(skillName),
    };
    const passed = Object.values(checks).every(Boolean);

    return {
      passed,
      evidence: {
        checks,
        user_id: userId,
        chat_id: chatId,
        skill_name: skillName,
        skill_sentinel: sentinel,
        pi_adapter_skills: meta,
      },
    };
  } finally {
    rmSync(skillsRoot, { recursive: true, force: true });
  }
}
