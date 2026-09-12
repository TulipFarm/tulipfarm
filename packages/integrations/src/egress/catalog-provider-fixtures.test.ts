import { readFile } from "node:fs/promises";
import {
  parseOimFixtureSuite,
  parseOimManifest,
  type ToolContractDefinition,
} from "@tulipfarm/schema";
import { ToolBroker, ToolCatalog } from "@tulipfarm/tool-broker";
import { beforeAll, describe, expect, it } from "vitest";
import { compileOimHttpOperations, type OimFixtureRunOptions, runOimFixtures } from "../index";

const providers = [
  "asana",
  "clickup",
  "confluence-data-center",
  "discord",
  "facebook",
  "google-workspace",
  "hubspot",
  "instagram",
  "jira",
  "linkedin",
  "mailchimp",
  "notion",
  "openweather",
  "reddit",
  "trello",
  "x",
  "zendesk",
] as const;

type Provider = (typeof providers)[number];

const communicationOperations: Partial<Record<Provider, string>> = {
  asana: "add-comment",
  clickup: "add-comment",
  facebook: "create-page-post",
  instagram: "publish-media",
  linkedin: "create-post",
  x: "create-post",
};

const continuations: Partial<Record<Provider, NonNullable<OimFixtureRunOptions["continuations"]>>> =
  {
    asana: {
      "lists-project-page": { cursor: "old-cursor" },
    },
    clickup: {
      "lists-task-page": { cursor: "1" },
    },
    zendesk: {
      "lists-ticket-page": { cursor: "2" },
    },
  };

interface FixtureFailure {
  readonly provider: string;
  readonly fixture: string;
  readonly name: string;
  readonly error: string | undefined;
}

let caseCount = 0;
let operationCount = 0;
let coveredOperationCount = 0;
const failures: FixtureFailure[] = [];
const communicationRisks = new Map<string, string>();
const openweatherContracts = new Map<string, ToolContractDefinition>();

beforeAll(async () => {
  for (const provider of providers) {
    const packageRoot = new URL(`../../../../integrations/${provider}/`, import.meta.url);
    const manifest = parseOimManifest(await readFile(new URL("oim.yml", packageRoot), "utf8"));
    const companions = new Map<string, string>();
    const coveredOperationIds = new Set<string>();

    for (const file of manifest.files ?? []) {
      const content = await readFile(new URL(file.path, packageRoot), "utf8");
      companions.set(file.path, content);
      if (file.role === "fixture") {
        const suite = parseOimFixtureSuite(content);
        caseCount += suite.cases.length;
        for (const fixture of suite.cases) coveredOperationIds.add(fixture.operationId);
      }
    }

    operationCount += manifest.operations.length;
    coveredOperationCount += coveredOperationIds.size;
    const communicationOperationId = communicationOperations[provider];
    if (communicationOperationId !== undefined || provider === "openweather") {
      for (const tool of compileOimHttpOperations(manifest)) {
        if (tool.operation.id === communicationOperationId) {
          communicationRisks.set(`${provider}/${tool.operation.id}`, tool.contract.spec.riskClass);
        }
        if (provider === "openweather") {
          openweatherContracts.set(tool.operation.id, tool.contract);
        }
      }
    }
    const providerContinuations = continuations[provider];
    const results = await runOimFixtures(
      manifest,
      companions,
      providerContinuations === undefined ? {} : { continuations: providerContinuations }
    );
    failures.push(
      ...results
        .filter((result) => !result.passed)
        .map((result) => ({
          provider,
          fixture: result.fixture,
          name: result.name,
          error: result.error,
        }))
    );
  }
}, 30_000);

describe("P11 catalog provider fixtures", () => {
  it("executes every declared operation fixture through the production adapters", () => {
    expect(providers).toHaveLength(17);
    expect(caseCount).toBe(136);
    expect(operationCount).toBe(115);
    expect(coveredOperationCount).toBe(115);

    expect(failures).toEqual([]);
  });

  it("compiles external communications as high risk", () => {
    expect(communicationRisks).toEqual(
      new Map([
        ["asana/add-comment", "high"],
        ["clickup/add-comment", "high"],
        ["facebook/create-page-post", "high"],
        ["instagram/publish-media", "high"],
        ["linkedin/create-post", "high"],
        ["x/create-post", "high"],
      ])
    );
  });

  it("rejects incomplete and invalid weather locations before dispatch", () => {
    const invalidRequests = new Map<string, readonly Record<string, unknown>[]>([
      ["current-weather", [{}, { q: "" }, { q: "   " }]],
      ["forecast", [{}, { q: "" }, { q: "   " }]],
      [
        "current-weather-coordinates",
        [{}, { lat: 51.5072 }, { lon: -0.1276 }, { lat: 91, lon: 0 }, { lat: 0, lon: 181 }],
      ],
      [
        "forecast-coordinates",
        [{}, { lat: 51.5072 }, { lon: -0.1276 }, { lat: -91, lon: 0 }, { lat: 0, lon: -181 }],
      ],
    ]);

    for (const [operationId, requests] of invalidRequests) {
      const contract = openweatherContracts.get(operationId);
      if (contract === undefined) expect.unreachable(`${operationId} contract missing`);
      const broker = new ToolBroker(ToolCatalog.load([contract]));
      for (const arguments_ of requests) {
        expect(
          broker.authorize(
            {
              intentId: `invalid-${operationId}`,
              businessId: "oim-fixture",
              runId: "oim-fixture",
              stateId: "oim-fixture",
              toolId: contract.spec.toolId,
              toolVersion: contract.spec.toolVersion,
              action: contract.spec.action,
              targetRefs: [],
              arguments: arguments_,
              idempotencyKey: `invalid-${operationId}`,
            },
            {
              authorityLayers: [],
              guardrailRules: [],
              dlpRules: [],
              guardrailRevision: "oim-fixture",
              taint: "trusted",
            }
          )
        ).toMatchObject({ outcome: "denied", reason: "invalid_arguments" });
      }
    }
  });
});
