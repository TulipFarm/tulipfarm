import { createHash } from "node:crypto";
import suite from "../conformance/suite.json" with { type: "json" };

const source = JSON.stringify(suite);

export const conformanceSuite = suite;
export const conformanceSuiteDigest = `sha256:${createHash("sha256").update(source).digest("hex")}`;

export function requiredConformanceVectors(profiles) {
  return conformanceSuite.cases.flatMap((definition) => {
    const selected = profiles[definition.profile];
    if (selected === undefined) return [];
    return definition.vectors
      .filter((vector) => vector.since === undefined || Number(selected) >= Number(vector.since))
      .map((vector) => ({
        caseId: definition.id,
        profile: definition.profile,
        profileVersion: selected,
        ...vector,
      }));
  });
}
