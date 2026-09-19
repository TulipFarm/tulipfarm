"use client";

import type { SurfaceArtifact } from "@tulipfarm/surface/client";
import { SurfaceView } from "@tulipfarm/surface-web/view";
import { Component, type ReactNode } from "react";
import { docsUrl } from "@/lib/site";
import { ArrowRight } from "./icons";

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div role="alert" className="demo-error">
          <h3>The example could not be displayed.</h3>
          <p>You can still read how TulipFarm works or start your own installation.</p>
          <a href={docsUrl()} className="text-link">
            Read the docs <ArrowRight size={16} />
          </a>
        </div>
      );
    }
    return this.props.children;
  }
}

export function ProductPreview({ artifact }: { artifact: SurfaceArtifact }) {
  return (
    <PreviewBoundary key={artifact.id}>
      <SurfaceView artifact={artifact} />
    </PreviewBoundary>
  );
}
