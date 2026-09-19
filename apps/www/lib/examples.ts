import { createSurfaceArtifact, type SurfaceArtifact } from "@tulipfarm/surface";

export interface ExampleStep {
  label: string;
  heading: string;
  description: string;
  artifact: SurfaceArtifact;
}

export interface BusinessExample {
  id: string;
  label: string;
  title: string;
  sceneTitle: string;
  capture: string;
  request: string;
  resultNote: string;
  docsPath: string;
  steps: [ExampleStep, ExampleStep, ExampleStep];
}

function artifact(id: string, name: string, props: Record<string, unknown>): SurfaceArtifact {
  return createSurfaceArtifact({
    id,
    component: { name, version: "1.0" },
    props,
    target: { channel: "web", surface: "chat" },
    audience: ["public"],
    classification: "public",
  });
}

export const customerExample: BusinessExample = {
  id: "customers",
  label: "Track customers",
  title: "Customer tracker",
  sceneTitle: "A customer tracker, built from a chat.",
  capture: "/images/examples/customers.webp",
  request:
    "Build a customer tracker with company, contact, status, and next action. Add a sample customer so I can see how it works.",
  resultNote: "Your fields. Your records. On your infrastructure.",
  docsPath: "/using-tulipfarm/resources",
  steps: [
    {
      label: "Describe",
      heading: "Start with what you need.",
      description: "A plain-language request defines the fields your business needs.",
      artifact: artifact("customers-request", "RecordDetail", {
        title: "Customer tracker",
        record: {
          company: "Company name",
          contact: "Primary contact",
          status: "New, active, or paused",
          next_action: "What needs to happen next",
        },
      }),
    },
    {
      label: "Build",
      heading: "Your request becomes a working system.",
      description: "The Customer resource type gives each record a consistent shape.",
      artifact: artifact("customers-build", "Card", {
        title: "Customer resource type",
        status: "Example configuration",
        body: "Company, contact, status, and next action. The same fields are available in chat and the generated record forms.",
      }),
    },
    {
      label: "Use",
      heading: "Put the first customer in place.",
      description: "Add and update records from chat. These are illustrative sample records.",
      artifact: artifact("customers-result", "RecordTable", {
        columns: ["company", "contact", "status", "next_action"],
        records: [
          {
            company: "Maple Studio",
            contact: "Muskan Vijayvargiya",
            status: "New",
            next_action: "Send onboarding guide",
          },
          {
            company: "Cedar Workshop",
            contact: "Operations team",
            status: "Active",
            next_action: "Review open questions",
          },
        ],
      }),
    },
  ],
};

export const supportExample: BusinessExample = {
  id: "support",
  label: "Set up support",
  title: "Support agent",
  sceneTitle: "A support agent, with clear boundaries.",
  capture: "/images/examples/support.webp",
  request:
    "Create a ticket tracker, then a support agent that can read and update tickets. It should leave refunds for a person to review.",
  resultNote: "Refund decisions stay with your team.",
  docsPath: "/using-tulipfarm/agents",
  steps: [
    {
      label: "Describe",
      heading: "Give your agent a useful job.",
      description: "Define the work it should do and the decisions it should leave to you.",
      artifact: artifact("support-request", "RecordDetail", {
        title: "Support agent brief",
        record: {
          job: "Triage and update support tickets",
          needs: "Ticket resource type",
          boundary: "Leave refunds for human review",
        },
      }),
    },
    {
      label: "Build",
      heading: "Build the tracker before the agent.",
      description: "The agent gets instructions and access to the records it needs.",
      artifact: artifact("support-build", "RecordDetail", {
        title: "Support agent",
        record: {
          instructions: "Triage tickets; do not issue refunds",
          records: "Ticket",
          access: "Read and update tickets",
          tools: "No refund tool granted",
        },
      }),
    },
    {
      label: "Use",
      heading: "Hand over the routine work.",
      description: "An example ticket stays visible while the agent records the next action.",
      artifact: artifact("support-result", "RecordDetail", {
        title: "Sample ticket: refund question",
        record: {
          customer: "Muskan Vijayvargiya",
          status: "Needs human review",
          summary: "Customer requested a refund",
          next_action: "Ask a team member to review the request",
        },
      }),
    },
  ],
};

const routineExample: BusinessExample = {
  id: "routines",
  label: "Make work repeat",
  title: "Daily ticket review",
  sceneTitle: "A daily review, without another reminder.",
  capture: "/images/examples/routines.webp",
  request:
    "Create a daily routine that asks our support agent to review open tickets and summarize what needs attention.",
  resultNote: "Review the summary. Inspect the run.",
  docsPath: "/using-tulipfarm/routines",
  steps: [
    {
      label: "Describe",
      heading: "Describe the work that keeps coming back.",
      description: "Start with an existing support agent and ticket tracker.",
      artifact: artifact("routines-request", "RecordDetail", {
        title: "Daily ticket review",
        record: {
          schedule: "Every day",
          agent: "Support agent",
          task: "Review open tickets and summarize next actions",
        },
      }),
    },
    {
      label: "Build",
      heading: "Give that work a routine.",
      description: "A scheduled routine calls the agent with the same bounded task.",
      artifact: artifact("routines-build", "Card", {
        title: "Daily ticket review",
        status: "Example configuration",
        body: "The schedule starts a run. The support agent reviews open tickets and returns a summary. You can inspect the run and its events.",
      }),
    },
    {
      label: "Use",
      heading: "See what needs your attention.",
      description: "A sample summary, rendered with the same components used in TulipFarm chat.",
      artifact: artifact("routines-result", "List", {
        items: [
          "Maple Studio: a refund question needs human review.",
          "Cedar Workshop: send the updated onboarding guide.",
          "No external message was sent in this prepared example.",
        ],
      }),
    },
  ],
};

export const businessExamples: readonly BusinessExample[] = [
  customerExample,
  supportExample,
  routineExample,
];
