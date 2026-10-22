import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client, escapeIdentifier } from 'pg';
import {
  createPostgresMemoryRepository,
  createPostgresMemoryReconciliationRepository,
  createPostgresTranscriptSource,
} from '../dist/index.js';
import {
  baseMemorySeed,
  memoryFixtureIds,
  memoryRepositoryConformance,
  memoryReconciliationConformance,
  transcriptSourceConformance,
} from '@tulipfarm/memory-core/testing/memory-conformance';

async function fixture(t) {
  assert.ok(process.env.TEST_ADMIN_DATABASE_URL, 'TEST_ADMIN_DATABASE_URL is required; no database tests are skipped');
  const client = new Client({
    connectionString: process.env.TEST_ADMIN_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  await client.connect();
  const schema = `memcore_conformance_${randomUUID().replaceAll('-', '')}`;
  const names = { schema, tablePrefix: 'reference_' };
  const table = name => `${escapeIdentifier(schema)}.${escapeIdentifier(`${names.tablePrefix}${name}`)}`;
  t.after(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
    } finally {
      await client.end();
    }
  });
  await client.query(`
    CREATE SCHEMA ${escapeIdentifier(schema)};
    CREATE TABLE ${table('personal_memory')} (
      membership_id uuid PRIMARY KEY, content text NOT NULL, revision integer NOT NULL,
      manual_updated_at timestamptz, reconciled_through timestamptz);
    CREATE TABLE ${table('conversations')} (id uuid PRIMARY KEY, owner_membership_id uuid, project_id uuid);
    CREATE TABLE ${table('conversation_maintenance')} (
      id uuid PRIMARY KEY, conversation_id uuid NOT NULL, requester_membership_id uuid NOT NULL,
      generation integer NOT NULL, covered_through bigint,
      memory_complete boolean NOT NULL DEFAULT false, memory_chunk integer NOT NULL DEFAULT 0,
      memory_step integer NOT NULL DEFAULT 0, memory_base_revision integer,
      memory_manual_at timestamptz, memory_reconciled_through timestamptz);
    CREATE TABLE ${table('conversation_maintenance_steps')} (job_id uuid, purpose text);
    CREATE TABLE ${table('conversation_messages')} (
      id uuid PRIMARY KEY, conversation_id uuid, membership_id uuid, author_kind text,
      sequence bigint, created_at timestamptz);
    CREATE TABLE ${table('conversation_parts')} (message_id uuid, ordinal integer, kind text, text text);
    CREATE TABLE ${table('conversation_turns')} (source_message_id uuid, accepted_sequence integer);
    CREATE TABLE ${table('internal_publications')} (message_id uuid);
  `);
  const ids = memoryFixtureIds();
  const memory = () => createPostgresMemoryRepository(client, names);
  const reconciliation = () => createPostgresMemoryReconciliationRepository(client, names);
  const transcript = () => createPostgresTranscriptSource(client, names);
  async function run(operation) {
    await client.query('BEGIN');
    try {
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  async function upsert(name, columns, values, conflict) {
    const updates = columns
      .filter(column => column !== conflict)
      .map(column => `${escapeIdentifier(column)}=EXCLUDED.${escapeIdentifier(column)}`)
      .join(',');
    await client.query(
      `INSERT INTO ${table(name)} (${columns.map(escapeIdentifier).join(',')})
       VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})
       ON CONFLICT (${escapeIdentifier(conflict)}) DO UPDATE SET ${updates}`,
      values,
    );
  }
  async function seed(input) {
    await run(async () => {
      for (const row of input.memories ?? [])
        await upsert(
          'personal_memory',
          ['membership_id', 'content', 'revision', 'manual_updated_at', 'reconciled_through'],
          [
            row.membershipId,
            row.content ?? '',
            row.revision ?? 1,
            row.manual_updated_at ?? null,
            row.reconciled_through ?? null,
          ],
          'membership_id',
        );
      for (const row of input.conversations ?? [])
        await upsert(
          'conversations',
          ['id', 'owner_membership_id', 'project_id'],
          [row.id, row.owner_membership_id, row.project_id],
          'id',
        );
      for (const row of input.jobs ?? [])
        await upsert(
          'conversation_maintenance',
          [
            'id',
            'conversation_id',
            'requester_membership_id',
            'generation',
            'covered_through',
            'memory_complete',
            'memory_chunk',
            'memory_step',
            'memory_base_revision',
            'memory_manual_at',
            'memory_reconciled_through',
          ],
          [
            row.id,
            row.conversationId,
            row.membershipId,
            row.generation,
            row.coveredThrough,
            row.memory_complete ?? false,
            row.memory_chunk ?? 0,
            row.memory_step ?? 0,
            row.memory_base_revision ?? null,
            row.memory_manual_at ?? null,
            row.memory_reconciled_through ?? null,
          ],
          'id',
        );
      for (const row of input.steps ?? [])
        await client.query(`INSERT INTO ${table('conversation_maintenance_steps')} VALUES ($1,$2)`, [
          row.jobId,
          row.purpose,
        ]);
      for (const row of input.messages ?? []) {
        await upsert(
          'conversation_messages',
          ['id', 'conversation_id', 'membership_id', 'author_kind', 'sequence', 'created_at'],
          [row.id, row.conversationId, row.membershipId, row.authorKind, row.sequence, row.createdAt],
          'id',
        );
        await client.query(`INSERT INTO ${table('conversation_turns')} VALUES ($1,$2)`, [row.id, row.acceptedSequence]);
        for (const part of row.parts)
          await client.query(`INSERT INTO ${table('conversation_parts')} VALUES ($1,$2,$3,$4)`, [
            row.id,
            part.ordinal,
            part.kind,
            part.text,
          ]);
        if (row.internal) await client.query(`INSERT INTO ${table('internal_publications')} VALUES ($1)`, [row.id]);
      }
    });
  }
  await seed(baseMemorySeed(ids));
  return { ids, seed, run, memory, reconciliation, transcript };
}

memoryRepositoryConformance(test, 'Postgres MemoryRepository', fixture);
memoryReconciliationConformance(test, 'Postgres MemoryReconciliationRepository', fixture);
transcriptSourceConformance(test, 'Postgres TranscriptSource', fixture);
