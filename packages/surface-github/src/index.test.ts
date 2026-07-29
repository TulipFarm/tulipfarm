import { createSurfaceArtifact } from "@tulipfarm/surface";
import { describe, expect, it } from "vitest";
import { githubCommentRenderer } from "./index";

describe("githubCommentRenderer", () => {
  it("renders a Record table as Markdown", () => {
    const artifact = createSurfaceArtifact({
      id: "records",
      component: { name: "RecordTable", version: "1.0" },
      props: {
        columns: ["name", "status"],
        records: [
          { name: "Acme", status: "Open" },
          { name: "Globex", status: "Won" },
        ],
      },
      target: { channel: "github", surface: "comment" },
      audience: ["user:1"],
      classification: "internal",
    });
    expect(githubCommentRenderer.render(artifact, { destination: "issue:1" })).toEqual({
      kind: "comment",
      body: "| name | status |\n| --- | --- |\n| Acme | Open |\n| Globex | Won |",
    });
  });
});
