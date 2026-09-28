import type { TargetSource } from "../model.js";

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
