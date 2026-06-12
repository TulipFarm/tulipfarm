import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { TimelinePart } from "~/lib/chat/types";
import { MessagePartView } from "./parts";

test("an a2ui part renders the sandboxed A2uiFrame iframe", () => {
  const part: TimelinePart = { kind: "a2ui", html: "<tf-card>x</tf-card>" };
  const { container } = render(
    <MessagePartView part={part} onApprove={() => {}} onA2uiAgent={vi.fn()} />
  );
  const iframe = container.querySelector('iframe[title="A2UI content"]');
  expect(iframe).not.toBeNull();
  expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
});
