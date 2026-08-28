import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LOADER_LABELS } from "~/components/ui/loading-state";
import type { TimelinePart } from "~/lib/chat/types";
import { PlanTrace } from "./plan-trace";
import type { PlannedRound } from "./timeline-groups";

type ToolPart = Extract<TimelinePart, { kind: "tool" }>;

function part(overrides: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: "tool",
    toolCallId: "call_1",
    toolName: "skill",
    args: {},
    status: "done",
    outcome: "ok",
    ...overrides,
  };
}

const label = (text: string) => new RegExp(`^(${LOADER_LABELS.join("|")})$`).test(text);

/** The one row that is not a step: the sign the Turn is working between calls. */
function liveEdge() {
  return screen.queryAllByText((text) => label(text));
}

describe("PlanTrace", () => {
  const waiting: PlannedRound[] = [
    {
      declared: true,
      calls: [{ tool: "skill", label: "Load the Skill procedure", status: "pending" }],
    },
    {
      declared: true,
      calls: [{ tool: "skill_create", label: "Audit the Skill", status: "pending" }],
    },
  ];

  it("says the Turn is working when it has declared a plan but started none of it", () => {
    // An Agent that declares its plan in a message of its own spends a whole model round-trip
    // before the first call. Empty circles for that whole time read as a stalled Turn.
    render(<PlanTrace rounds={waiting} pending />);

    expect(liveEdge()).toHaveLength(1);
  });

  it("stays quiet while a call of its own is in flight, which already says the same thing", () => {
    const running: PlannedRound[] = [
      {
        declared: true,
        calls: [
          {
            tool: "skill",
            label: "Load the Skill procedure",
            status: "running",
            part: part({ status: "running" }),
          },
        ],
      },
    ];
    render(<PlanTrace rounds={running} pending />);

    expect(liveEdge()).toHaveLength(0);
  });

  it("says nothing once the Turn has stopped, so a finished plan is not left looking busy", () => {
    render(<PlanTrace rounds={waiting} pending={false} />);

    expect(liveEdge()).toHaveLength(0);
  });
});
