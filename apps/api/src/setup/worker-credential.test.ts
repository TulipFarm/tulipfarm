import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApiClientDoc,
  type ApiClientRepo,
  type ApiClientStatus,
  authenticateApiClient,
  createApiClient,
  formatApiClientCredential,
} from "../identity/api-clients";
import {
  INTEGRATION_WORKER_CLIENT_NAME,
  provisionIntegrationWorkerCredential,
  provisionWorkerCredential,
  WORKER_CLIENT_NAME,
  WorkerCredentialError,
} from "./worker-credential";

class FakeApiClientRepo implements ApiClientRepo {
  readonly clients: ApiClientDoc[] = [];

  async create(client: ApiClientDoc): Promise<void> {
    this.clients.push(client);
  }
  async findByClientId(clientId: string): Promise<ApiClientDoc | null> {
    return this.clients.find((c) => c.clientId === clientId) ?? null;
  }
  async findById(id: string): Promise<ApiClientDoc | null> {
    return this.clients.find((c) => c._id === id) ?? null;
  }
  async findAll(): Promise<ApiClientDoc[]> {
    return [...this.clients];
  }
  async updateSecret(id: string, secretHash: string, rotatedAt: Date): Promise<void> {
    const client = await this.findById(id);
    if (client) Object.assign(client, { secretHash, rotatedAt });
  }
  async updateStatus(id: string, status: ApiClientStatus): Promise<void> {
    const client = await this.findById(id);
    if (client) Object.assign(client, { status });
  }
}

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-worker-cred-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

const silent = { warn: vi.fn() };

/** The credential the file lane hands the Worker, as it appears in `worker.env`. */
function credentialIn(dir: string): string {
  const contents = readFileSync(join(dir, "worker.env"), "utf8");
  const line = contents.split("\n").find((l) => l.startsWith("WORKER_API_CREDENTIAL="));
  return (line as string).slice("WORKER_API_CREDENTIAL=".length);
}

describe("provisionWorkerCredential", () => {
  it("does nothing when the environment already supplies a credential", async () => {
    const repo = new FakeApiClientRepo();
    const dir = tempDataDir();

    const result = await provisionWorkerCredential(
      repo,
      { TF_DATA_DIR: dir, WORKER_API_CREDENTIAL: "tfc_managed.secret" },
      silent
    );

    expect(result.outcome).toBe("env");
    expect(repo.clients).toEqual([]);
    expect(() => statSync(join(dir, "worker.env"))).toThrow();
  });

  it("skips the file lane entirely when there is no data dir", async () => {
    const repo = new FakeApiClientRepo();

    const result = await provisionWorkerCredential(repo, {}, silent);

    // A development checkout configures the worker by hand; nothing is minted behind its back.
    expect(result.outcome === "skipped" || result.outcome === "minted").toBe(true);
    if (result.outcome === "skipped") expect(repo.clients).toEqual([]);
  });

  it("mints a deployment-owned client and persists it 0600", async () => {
    const repo = new FakeApiClientRepo();
    const dir = tempDataDir();

    const result = await provisionWorkerCredential(repo, { TF_DATA_DIR: dir }, silent);

    expect(result.outcome).toBe("minted");
    expect(result.file).toBe(join(dir, "worker.env"));
    expect(repo.clients).toHaveLength(1);
    expect(repo.clients[0].name).toBe(WORKER_CLIENT_NAME);
    // Nobody owns it: minted before the setup wizard has made a single user.
    expect(repo.clients[0].ownerUserId).toBeNull();
    expect(statSync(join(dir, "worker.env")).mode & 0o777).toBe(0o600);
    await expect(authenticateApiClient(repo, credentialIn(dir))).resolves.toMatchObject({
      name: WORKER_CLIENT_NAME,
    });
  });

  it("reuses the persisted credential on the next boot", async () => {
    const repo = new FakeApiClientRepo();
    const dir = tempDataDir();

    await provisionWorkerCredential(repo, { TF_DATA_DIR: dir }, silent);
    const first = credentialIn(dir);
    const result = await provisionWorkerCredential(repo, { TF_DATA_DIR: dir }, silent);

    expect(result.outcome).toBe("reused");
    expect(repo.clients).toHaveLength(1);
    expect(credentialIn(dir)).toBe(first);
  });

  it("mints again when the file names a client this database does not have", async () => {
    // `/data` restored next to a fresh database. Discovering this at the Worker's first claim
    // costs a participant a turn; discovering it here costs nothing.
    const dir = tempDataDir();
    writeFileSync(join(dir, "worker.env"), "WORKER_API_CREDENTIAL=tfc_gone.secret\n");
    const repo = new FakeApiClientRepo();

    const result = await provisionWorkerCredential(repo, { TF_DATA_DIR: dir }, silent);

    expect(result.outcome).toBe("minted");
    expect(credentialIn(dir)).not.toBe("tfc_gone.secret");
  });

  it("mints again when the persisted client was disabled", async () => {
    const repo = new FakeApiClientRepo();
    const dir = tempDataDir();
    const { doc, secret } = await createApiClient(repo, {
      name: WORKER_CLIENT_NAME,
      ownerUserId: null,
    });
    await repo.updateStatus(doc._id, "disabled");
    writeFileSync(
      join(dir, "worker.env"),
      `WORKER_API_CREDENTIAL=${formatApiClientCredential(doc.clientId, secret)}\n`
    );

    const result = await provisionWorkerCredential(repo, { TF_DATA_DIR: dir }, silent);

    expect(result.outcome).toBe("minted");
    expect(repo.clients).toHaveLength(2);
  });

  it("refuses to boot when the minted credential cannot be persisted", async () => {
    const repo = new FakeApiClientRepo();
    // A regular file where a directory has to be — unwritable for root too, so this asserts the
    // same thing wherever the suite runs.
    const blocked = join(tempDataDir(), "not-a-dir");
    writeFileSync(blocked, "");

    // A credential no worker can read is a deployment that accepts Runs and never answers one.
    await expect(
      provisionWorkerCredential(repo, { TF_DATA_DIR: join(blocked, "data") }, silent)
    ).rejects.toBeInstanceOf(WorkerCredentialError);
  });
});

/** The credential the file lane hands the Integration Worker, as it appears in the file. */
function integrationCredentialIn(dir: string): string {
  const contents = readFileSync(join(dir, "integration-worker.env"), "utf8");
  const line = contents.split("\n").find((l) => l.startsWith("INTEGRATION_WORKER_API_CREDENTIAL="));
  return (line as string).slice("INTEGRATION_WORKER_API_CREDENTIAL=".length);
}

describe("provisionIntegrationWorkerCredential", () => {
  it("does nothing when the environment already supplies a credential", async () => {
    const repo = new FakeApiClientRepo();
    const dir = tempDataDir();

    const result = await provisionIntegrationWorkerCredential(
      repo,
      { TF_DATA_DIR: dir, INTEGRATION_WORKER_API_CREDENTIAL: "tfc_managed.secret" },
      silent
    );

    expect(result.outcome).toBe("env");
    expect(repo.clients).toEqual([]);
  });

  it("mints a deployment-owned client, distinct from the Worker's, and persists it 0600", async () => {
    const repo = new FakeApiClientRepo();
    const dir = tempDataDir();

    const result = await provisionIntegrationWorkerCredential(repo, { TF_DATA_DIR: dir }, silent);

    expect(result.outcome).toBe("minted");
    expect(result.file).toBe(join(dir, "integration-worker.env"));
    expect(repo.clients).toHaveLength(1);
    expect(repo.clients[0].name).toBe(INTEGRATION_WORKER_CLIENT_NAME);
    expect(statSync(join(dir, "integration-worker.env")).mode & 0o777).toBe(0o600);
    await expect(authenticateApiClient(repo, integrationCredentialIn(dir))).resolves.toMatchObject({
      name: INTEGRATION_WORKER_CLIENT_NAME,
    });
  });

  it("reuses the persisted credential on the next boot", async () => {
    const repo = new FakeApiClientRepo();
    const dir = tempDataDir();

    await provisionIntegrationWorkerCredential(repo, { TF_DATA_DIR: dir }, silent);
    const first = integrationCredentialIn(dir);
    const result = await provisionIntegrationWorkerCredential(repo, { TF_DATA_DIR: dir }, silent);

    expect(result.outcome).toBe("reused");
    expect(repo.clients).toHaveLength(1);
    expect(integrationCredentialIn(dir)).toBe(first);
  });

  it("does not share a file or client with the Worker's own credential", async () => {
    const repo = new FakeApiClientRepo();
    const dir = tempDataDir();

    await provisionWorkerCredential(repo, { TF_DATA_DIR: dir }, silent);
    await provisionIntegrationWorkerCredential(repo, { TF_DATA_DIR: dir }, silent);

    expect(repo.clients).toHaveLength(2);
    expect(credentialIn(dir)).not.toBe(integrationCredentialIn(dir));
  });
});
