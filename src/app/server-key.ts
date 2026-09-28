import type { TargetSource } from "../model.js";

/** A local path must already be relative to the process working directory. The version is not part of the key. */
export function serverKey(source: TargetSource): string {
  switch (source.kind) {
    case "registry":
      return `${source.ecosystem}:${source.package}`;
    case "local":
      return `${source.ecosystem}:local:${source.path}`;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}
