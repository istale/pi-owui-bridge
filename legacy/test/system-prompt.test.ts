import { describe, expect, it } from "vitest";

import { composeMessages } from "../src/system-prompt.js";

describe("composeMessages", () => {
  it("returns messages unchanged when no skills or overlays", () => {
    const r = composeMessages({
      messages: [{ role: "user", content: "hi" }],
      skills: [],
      overlays: [],
    });
    expect(r.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(r.skillCharCount).toBe(0);
  });

  it("prepends skills above existing system, overlay appended", () => {
    const r = composeMessages({
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "yield trend please" },
      ],
      skills: [{ name: "chart_choice", body: "Use SPC for yields." }],
      overlays: [{ index: 0, mark: "stale", note: "wrong" }],
    });
    const sys = r.messages[0].content as string;
    expect(sys.indexOf("Use SPC for yields.")).toBeLessThan(sys.indexOf("you are helpful"));
    expect(sys.indexOf("you are helpful")).toBeLessThan(sys.indexOf("STALE"));
    expect(r.skillCharCount).toBeGreaterThan(0);
    expect(r.overlayCharCount).toBeGreaterThan(0);
  });

  it("creates a new system message if none present", () => {
    const r = composeMessages({
      messages: [{ role: "user", content: "u" }],
      skills: [{ name: "s", body: "rule" }],
      overlays: [],
    });
    expect(r.messages[0].role).toBe("system");
    expect(r.messages[0].content as string).toContain("rule");
    expect(r.messages[1].role).toBe("user");
  });
});
