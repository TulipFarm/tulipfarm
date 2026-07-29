import { createSurfaceArtifact } from "@tulipfarm/surface";
import { SurfaceArtifact } from "~/components/surface-artifact";

const examples = [
  createSurfaceArtifact({
    id: "status",
    component: { name: "Status", version: "1.0" },
    props: { label: "Healthy", tone: "positive" },
    target: { channel: "web", surface: "chat" },
    audience: ["developer"],
    classification: "internal",
  }),
  createSurfaceArtifact({
    id: "records",
    component: { name: "RecordTable", version: "1.0" },
    props: {
      columns: ["name", "status"],
      records: [
        { name: "Acme", status: "Open" },
        { name: "Globex", status: "Won" },
      ],
    },
    target: { channel: "web", surface: "chat" },
    audience: ["developer"],
    classification: "internal",
  }),
] as const;

export default function DevelopmentSurfacesRoute() {
  return (
    <main>
      <h1>Tulip Surface Protocol</h1>
      {examples.map((artifact) => (
        <SurfaceArtifact
          key={artifact.id}
          artifact={artifact}
          artifactId={artifact.id}
          revision={artifact.revision}
        />
      ))}
    </main>
  );
}
