import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeContextCard } from "./code-context-card";
import { FollowupPills } from "./followup-pills";
import { SearchProgressBlock } from "./search-progress-block";
import { SourceCarousel } from "./source-carousel";
import { UserMessageBubble } from "./user-message-bubble";

describe("Chat UI Primitives", () => {
  it("renders CodeContextCard with flagged relevant lines", () => {
    render(
      <CodeContextCard
        filePath="src/auth/middleware.ts"
        lines={[
          {
            lineNumber: 1,
            content: "const secret = 'test';",
            isRelevant: true,
            annotation: "Relevant",
          },
        ]}
      />
    );
    expect(screen.getByText("src/auth/middleware.ts")).toBeInTheDocument();
    expect(screen.getByText("1 relevant lines flagged")).toBeInTheDocument();
    expect(screen.getByText("Relevant")).toBeInTheDocument();
  });

  it("renders SearchProgressBlock with query and steps", () => {
    render(
      <SearchProgressBlock
        query="JWT Auth"
        items={[{ id: "1", title: "JWT Spec", domain: "jwt.io", status: "done" }]}
      />
    );
    expect(screen.getByText(/JWT Auth/)).toBeInTheDocument();
    expect(screen.getByText("JWT Spec")).toBeInTheDocument();
    expect(screen.getByText("jwt.io")).toBeInTheDocument();
  });

  it("renders SourceCarousel with source cards", () => {
    render(
      <SourceCarousel
        sources={[{ id: "1", title: "Design Systems", domain: "Google", snippet: "Overview..." }]}
      />
    );
    expect(screen.getByText("Design Systems")).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument();
  });

  it("renders FollowupPills and triggers onPick on click", () => {
    let picked = "";
    render(
      <FollowupPills
        items={[{ id: "1", label: "Component Specs", prompt: "Tell me about component specs" }]}
        onPick={(p) => {
          picked = p;
        }}
      />
    );
    const pill = screen.getByText("Component Specs");
    expect(pill).toBeInTheDocument();
    pill.click();
    expect(picked).toBe("Tell me about component specs");
  });

  it("renders UserMessageBubble", () => {
    render(<UserMessageBubble messageText="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });
});
