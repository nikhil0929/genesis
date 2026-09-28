import { join } from "node:path";

export function rawPath(runDir: string, ...parts: readonly string[]): string {
  return join(runDir, "raw", ...parts);
}
