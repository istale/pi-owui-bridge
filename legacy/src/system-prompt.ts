/**
 * Compose the final system prompt seen by the model: skills preamble,
 * then the incoming OWUI system message, then the overlay annotation.
 *
 * The order matters: skills are general rules of thumb that frame
 * everything; OWUI's existing system prompt is the contract; overlay
 * annotation is most recent user intent and overrides both.
 */
import type { Message } from "./openai-types.js";
import { buildAnnotation, type OverlayRecord } from "./overlay.js";
import { buildSkillsPreamble, type LoadedSkill } from "./skills.js";

export interface ComposeOptions {
  messages: Message[];
  skills: LoadedSkill[];
  overlays: OverlayRecord[];
}

export interface ComposeResult {
  messages: Message[];
  skillCharCount: number;
  overlayCharCount: number;
}

export function composeMessages(opts: ComposeOptions): ComposeResult {
  const skillBlock = buildSkillsPreamble(opts.skills);
  const overlayBlock = buildAnnotation(opts.overlays);
  if (skillBlock.length === 0 && overlayBlock.length === 0) {
    return { messages: opts.messages, skillCharCount: 0, overlayCharCount: 0 };
  }
  const messages = [...opts.messages];
  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    const existing = (messages[sysIdx].content as string | undefined) ?? "";
    const parts: string[] = [];
    if (skillBlock) parts.push(skillBlock);
    if (existing) parts.push(existing);
    if (overlayBlock) parts.push("---", overlayBlock);
    messages[sysIdx] = { ...messages[sysIdx], content: parts.filter((p) => p).join("\n\n").trim() };
  } else {
    const composed = [skillBlock, overlayBlock].filter((p) => p).join("\n\n");
    messages.unshift({ role: "system", content: composed });
  }
  return {
    messages,
    skillCharCount: skillBlock.length,
    overlayCharCount: overlayBlock.length,
  };
}
