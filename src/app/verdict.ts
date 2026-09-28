import type { Judgment } from "../model.js";

export type Verdict = "pass" | "fail" | "incomplete";

/** `null` means the judge did not run. A fail outranks an unclear opinion. */
export function rollupVerdict(judgments: readonly Judgment[] | null): Verdict {
  if (judgments === null) return "incomplete";
  let unclear = false;
  for (const judgment of judgments) {
    switch (judgment.kind) {
      case "invalid":
        return "fail";
      case "answer":
        switch (judgment.answer.opinion) {
          case "does_not_match":
            return "fail";
          case "unclear":
            unclear = true;
            break;
          case "matches":
            break;
          default: {
            const _exhaustive: never = judgment.answer.opinion;
            return _exhaustive;
          }
        }
        break;
      default: {
        const _exhaustive: never = judgment;
        return _exhaustive;
      }
    }
  }
  return unclear ? "incomplete" : "pass";
}
