/**
 * Per-user skill markdown loader. Reads every ``.md`` file under
 * ``$AOH_SKILLS_DIR/<user_id>/`` and concatenates them into a single
 * preamble. Skills are read each turn so a hot edit takes effect
 * immediately without restarting the bridge.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LoadedSkill {
  name: string;
  body: string;
}

const MAX_TOTAL_CHARS = 32_000;

export function loadSkills(skillsRoot: string | null, userId: string): LoadedSkill[] {
  if (!skillsRoot) return [];
  let entries: string[];
  try {
    entries = readdirSync(join(skillsRoot, userId)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: LoadedSkill[] = [];
  let total = 0;
  for (const name of entries) {
    let body: string;
    try {
      body = readFileSync(join(skillsRoot, userId, name), "utf8");
    } catch {
      continue;
    }
    total += body.length;
    if (total > MAX_TOTAL_CHARS) break;
    out.push({ name: name.replace(/\.md$/, ""), body });
  }
  return out;
}

export function buildSkillsPreamble(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "The following user-specific skills inform how to approach this conversation.",
    "Treat them as rules of thumb; the user's current request still leads.",
  ];
  for (const s of skills) lines.push(`\n## Skill: ${s.name}\n${s.body.trim()}`);
  return lines.join("\n");
}
