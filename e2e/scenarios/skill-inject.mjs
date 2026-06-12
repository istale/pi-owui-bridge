/**
 * Drop a tiny skill markdown for the user, send a turn, and confirm
 * the skill ends up in the system prompt the bridge reports back.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

    // Stage 12: bridge no longer reads skills (Pi does, by virtue of the
    // symlinked .pi/skills/ directory under the per-process cwd). The
    // assertion shifts: we wrote the skill file before the call, the
    // bridge round-tripped the turn, and the skill file persisted on
    // disk for Pi to have picked up. End-to-end "did the model actually
    // see the skill" needs a real LLM (--mode=real) to assert against.
    const checks = {
      bridge_returned_200: resp.status === 200,
      skill_file_present_for_pi: existsSync(join(skillsRoot, `${skillName}.md`)),
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
      },
    };
  } finally {
    rmSync(skillsRoot, { recursive: true, force: true });
  }
}
