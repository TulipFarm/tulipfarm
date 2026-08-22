import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../ports";
import { PgCuratorTurnReader } from "./turns";

describe("PgCuratorTurnReader (PostgreSQL)", () => {
  let database: PGlite;
  let reader: PgCuratorTurnReader;

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        turn_id uuid NOT NULL,
        role text NOT NULL,
        content jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE turn_completions (
        turn_id uuid NOT NULL,
        message_id uuid NOT NULL,
        PRIMARY KEY (turn_id, message_id)
      );
    `);
    reader = new PgCuratorTurnReader(database as unknown as Queryable);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("TRUNCATE messages, turn_completions;");
  });

  it("returns empty array for empty turnIds", async () => {
    const turns = await reader.read("business-1", []);
    expect(turns).toEqual([]);
  });

  it("reads pinned turns with user and completed assistant messages", async () => {
    const turn1 = "11111111-1111-1111-1111-111111111111";
    const turn2 = "22222222-2222-2222-2222-222222222222";
    const assistantMsg1 = "33333333-3333-3333-3333-333333333333";
    const uncompletedMsg = "44444444-4444-4444-4444-444444444444";

    // Turn 1: user + completed assistant
    await database.query(
      `INSERT INTO messages (id, turn_id, role, content)
       VALUES ($1, $2, 'user', $3::jsonb)`,
      [
        "55555555-5555-5555-5555-555555555555",
        turn1,
        JSON.stringify([{ type: "text", text: "Hello assistant" }]),
      ]
    );
    await database.query(
      `INSERT INTO messages (id, turn_id, role, content)
       VALUES ($1, $2, 'assistant', $3::jsonb)`,
      [assistantMsg1, turn1, JSON.stringify([{ type: "text", text: "Hello person" }])]
    );
    await database.query(`INSERT INTO turn_completions (turn_id, message_id) VALUES ($1, $2)`, [
      turn1,
      assistantMsg1,
    ]);

    // Turn 2: user + uncompleted assistant (e.g. streaming or interrupted)
    await database.query(
      `INSERT INTO messages (id, turn_id, role, content)
       VALUES ($1, $2, 'user', $3::jsonb)`,
      [
        "66666666-6666-6666-6666-666666666666",
        turn2,
        JSON.stringify([{ type: "text", text: "Question 2" }]),
      ]
    );
    await database.query(
      `INSERT INTO messages (id, turn_id, role, content)
       VALUES ($1, $2, 'assistant', $3::jsonb)`,
      [uncompletedMsg, turn2, JSON.stringify([{ type: "text", text: "Uncompleted draft" }])]
    );

    const turns = await reader.read("business-1", [turn1, turn2]);
    expect(turns).toEqual([
      {
        turnId: turn1,
        userText: "Hello assistant",
        assistantText: "Hello person",
      },
      {
        turnId: turn2,
        userText: "Question 2",
      },
    ]);
  });
});
