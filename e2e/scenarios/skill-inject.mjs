/**
 * Drop a tiny skill markdown for the user, send a turn, and confirm
 * the skill ends up in the system prompt the bridge reports back.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalText } from "../lib/script-fixtures.mjs";
import { pollForPayload } from "../lib/poll-hub.mjs";

export async function run({ bridge, hub, mode, scriptFake, randomChatId, randomUserId, skillsDir }) {
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
  // Pi skills require YAML frontmatter with description; without it the
  // skill is loaded but treated as invalid and never surfaced to the
  // model. Write a minimal-but-conforming SKILL.md so Pi recognises it
  // and includes the body in the system prompt.
  const skillDir = join(skillsRoot, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: e2e marker skill — must always echo a sentinel string.\n---\n\nAlways include the literal string ${sentinel} in your reply.`,
  );

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

    // Stage 12.5: bridge mirrors Pi's ``before_provider_payload`` into
    // the hub-readable observation tree, so we can grep the actual
    // messages Pi forwarded to the model. Pi's skill system surfaces
    // skill *names* in the system prompt on load and only injects the
    // body when the model invokes the skill, so a fake-upstream run
    // can prove "skill registered" but not "skill body reached the
    // model" — that needs --mode=real.
    const aohTraceId = resp.body?.pi_adapter?.aoh_trace_id;
    await pollForPayload(hub, aohTraceId);
    let payloadInspectBody = null;
    let nameMentionedInPayload = false;
    if (aohTraceId) {
      const ins = await hub.payloadInspect(aohTraceId);
      payloadInspectBody = ins.body;
      // The hub now exposes first_system_msg_excerpt so we can grep
      // for the skill name in the actual system prompt Pi sent.
      nameMentionedInPayload = (payloadInspectBody?.first_system_msg_excerpt ?? "").includes(skillName);
    }
    // Stage 12.6: Pi launches with ``--tools read`` so the
    // ``<available_skills>`` block actually appears in the system
    // prompt. We can now assert at the wire level that the skill name
    // reaches the model — proof that the user's per-user skill markdown
    // is in front of the model on every turn, not just sitting on disk.
    const checks = {
      bridge_returned_200: resp.status === 200,
      skill_file_present_for_pi: existsSync(join(skillsRoot, skillName, "SKILL.md")),
      hub_received_payload_for_trace: payloadInspectBody?.payload_message_count > 0,
      hub_payload_mentions_skill_name: nameMentionedInPayload,
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
