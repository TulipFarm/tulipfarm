import {
  canonicalHash,
  type OimConnectionVerificationEvidence,
  type OimVerificationBinding,
} from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { Queryable, QueryResult, TransactionPort } from "../ports";
import { ConnectionVerificationEvidenceStore } from "./connection-verification-evidence-store";

const SECRET_REFERENCE = "secret://00000000-0000-4000-8000-000000000001";
const BINDING: OimVerificationBinding = {
  businessId: "business-1",
  connectionId: "connection-1",
  integrationId: "calendar",
  integrationMajorVersion: 2,
  packageDigest: "a".repeat(64),
  configurationDigest: canonicalHash({ region: "us" }),
  authSteps: [
    {
      stepId: "credentials",
      revision: 1,
      credentials: [
        {
          slot: "access",
          referenceDigest: canonicalHash(SECRET_REFERENCE),
        },
      ],
    },
  ],
};
const EVIDENCE: OimConnectionVerificationEvidence = {
  assurance: "validity_only",
  issuer: "https://calendar.example",
  subject: null,
  tenant: null,
  binding: BINDING,
  proofDigest: "d".repeat(64),
  verifiedAt: "2026-09-12T12:00:00.000Z",
  verifiedBy: "oim-auth-1.1",
};

function transactionPort(query: Queryable["query"]): TransactionPort {
  return {
    async withTransaction<T>(operation: (transaction: Queryable) => Promise<T>): Promise<T> {
      return operation({ query });
    },
  };
}

describe("ConnectionVerificationEvidenceStore locking", () => {
  it("reads evidence after the Connection lock in a modeled invalidation interleaving", async () => {
    let evidenceIsActive = true;
    const query = async <Row>(text: string): Promise<QueryResult<Row>> => {
      if (text.includes("FROM connections")) {
        // Models an invalidation that committed while this read waited for the Connection lock.
        evidenceIsActive = false;
        return {
          rows: [
            {
              integration_id: "calendar",
              integration_major_version: 2,
              configuration: { region: "us" },
              secret_bindings: { access: SECRET_REFERENCE },
              status: "active",
              health_status: "healthy",
            } as Row,
          ],
        };
      }
      if (text.includes("FROM connection_verification_evidence")) {
        return { rows: evidenceIsActive ? ([{ evidence: EVIDENCE }] as Row[]) : [] };
      }
      if (text.includes("FROM connection_auth_steps")) {
        return {
          rows: [{ step_id: "credentials", revision: 1, status: "active" } as Row],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    };
    const store = new ConnectionVerificationEvidenceStore(transactionPort(query));

    await expect(
      store.findCurrentForConnection(
        BINDING.businessId,
        BINDING.connectionId,
        BINDING.packageDigest
      )
    ).resolves.toBeNull();
  });

  it("locks the Connection before invalidating its evidence", async () => {
    const queries: string[] = [];
    const query = async <Row>(text: string): Promise<QueryResult<Row>> => {
      queries.push(text);
      return { rows: [] };
    };
    const store = new ConnectionVerificationEvidenceStore(transactionPort(query));

    await store.invalidate(BINDING, "credentials_rotated");

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("FROM connections");
    expect(queries[0]).toContain("FOR UPDATE");
    expect(queries[1]).toContain("UPDATE connection_verification_evidence");
  });
});
