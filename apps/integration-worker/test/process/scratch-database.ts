import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { freePort } from "./free-port";

/**
 * The process under test is a real child process talking to a real socket, so the harness cannot
 * hand it an in-process PGlite the way the unit suites do. `PGLiteSocketServer` puts the same WASM
 * Postgres behind the wire protocol on an ephemeral port — a scratch database that never touches
 * the developer's, and needs no Docker in CI.
 */
export interface ScratchDatabase {
  /** `DATABASE_URL` for the integration worker process. */
  readonly url: string;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  stop(): Promise<void>;
}

/**
 * Boots a scratch Postgres carrying only `schema_version`, at the given version — this skeleton
 * reads nothing else. The API owns migrations, so the harness writes `schema_version` itself
 * rather than importing another app's migration runner.
 */
export async function startScratchDatabase(schemaVersion: number): Promise<ScratchDatabase> {
  const database = await PGlite.create();

  await database.exec(`CREATE TABLE schema_version (
    id      boolean PRIMARY KEY DEFAULT true,
    version integer NOT NULL,
    CONSTRAINT schema_version_single_row CHECK (id)
  )`);
  await database.query("INSERT INTO schema_version (id, version) VALUES (true, $1)", [
    schemaVersion,
  ]);

  // `PGLiteSocketServer` keeps its bound port private, so pick one up front rather than
  // asking the server which one it got.
  const port = await freePort();
  const server = new PGLiteSocketServer({
    db: database,
    host: "127.0.0.1",
    port,
  });
  await server.start();

  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    query: (text, params) => database.query<Record<string, unknown>>(text, params),
    stop: async () => {
      await server.stop();
      await database.close();
    },
  };
}
