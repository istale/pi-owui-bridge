import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildSkillsPreamble, loadSkills } from "../src/skills.js";

function makeTmp(): string {
  const dir = join(tmpdir(), `bridge-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(dir: string, user: string, name: string, body: string): void {
  mkdirSync(join(dir, user), { recursive: true });
  writeFileSync(join(dir, user, `${name}.md`), body);
}

describe("loadSkills", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns empty when dir missing", () => {
    expect(loadSkills(null, "alice")).toEqual([]);
    const d = makeTmp();
    dirs.push(d);
    expect(loadSkills(d, "no-such-user")).toEqual([]);
  });

  it("returns sorted .md files", () => {
    const d = makeTmp();
    dirs.push(d);
    writeSkill(d, "alice", "b_second", "BBB");
    writeSkill(d, "alice", "a_first", "AAA");
    expect(loadSkills(d, "alice").map((s) => s.name)).toEqual(["a_first", "b_second"]);
  });

  it("isolates per user", () => {
    const d = makeTmp();
    dirs.push(d);
    writeSkill(d, "alice", "s", "A");
    writeSkill(d, "bob", "s", "B");
    expect(loadSkills(d, "alice")[0].body).toBe("A");
    expect(loadSkills(d, "bob")[0].body).toBe("B");
  });

  it("respects the budget", () => {
    const d = makeTmp();
    dirs.push(d);
    const big = "x".repeat(20_000);
    writeSkill(d, "alice", "a", big);
    writeSkill(d, "alice", "b", big);
    writeSkill(d, "alice", "c", big);
    expect(loadSkills(d, "alice").length).toBeLessThanOrEqual(2);
  });
});

describe("buildSkillsPreamble", () => {
  it("emits names and bodies", () => {
    const text = buildSkillsPreamble([
      { name: "sql_style", body: "Prefer explicit JOIN." },
      { name: "chart_choice", body: "Use SPC for yields." },
    ]);
    expect(text).toContain("sql_style");
    expect(text).toContain("Prefer explicit JOIN");
    expect(text).toContain("chart_choice");
  });

  it("returns empty for no skills", () => {
    expect(buildSkillsPreamble([])).toBe("");
  });
});
