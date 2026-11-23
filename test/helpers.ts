import type { Standard } from "../core/types.ts";

export function std(id: string, over: Partial<Standard> = {}): Standard {
  return {
    id,
    title: id,
    severity: "major",
    detector: "rule",
    rule: "rule text",
    contentHash: `hash-${id}`,
    enabled: true,
    ...over,
  };
}

export const SEC = std("SEC-001", { severity: "blocker", detector: "rule+llm" });
export const MNT = std("MNT-001", { severity: "minor" });
export const TST = std("TST-001", { severity: "minor" });
export const ALL_RULES = [SEC, MNT, TST];

export const diff = (...lines: string[]) => lines.join("\n") + "\n";
