import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { ChatMessage } from "~/lib/chat/types";

const markdownRenders = new Map<string, number>();

vi.mock("~/components/markdown-view", () => ({
  MarkdownView: ({ children }: { children: string }) => {
    markdownRenders.set(children, (markdownRenders.get(children) ?? 0) + 1);
    return <div>{children}</div>;
  },
}));

import { Transcript } from "./transcript";

const historical: ChatMessage = {
  id: "old",
  role: "assistant",
  sealed: true,
  parts: [{ kind: "text", text: "Historical reply" }],
};

function messages(current: string): ChatMessage[] {
  return [
    historical,
    {
      id: "current",
      role: "assistant",
      sealed: false,
      parts: [{ kind: "text", text: current }],
    },
  ];
}

test("streaming the current Turn does not rerender an unchanged historical Message", () => {
  const onApprove = vi.fn();
  const onRegenerate = vi.fn();
  const onReviseDraft = vi.fn();
  const { rerender } = render(
    <Transcript
      messages={messages("a")}
      status="streaming"
      onApprove={onApprove}
      onRegenerate={onRegenerate}
      onReviseDraft={onReviseDraft}
    />
  );
  rerender(
    <Transcript
      messages={messages("ab")}
      status="streaming"
      onApprove={onApprove}
      onRegenerate={onRegenerate}
      onReviseDraft={onReviseDraft}
    />
  );
  rerender(
    <Transcript
      messages={messages("abc")}
      status="streaming"
      onApprove={onApprove}
      onRegenerate={onRegenerate}
      onReviseDraft={onReviseDraft}
    />
  );

  expect(markdownRenders.get("Historical reply")).toBe(1);
  expect(markdownRenders.get("abc")).toBe(1);
});
