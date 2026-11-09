import type { HumanActor } from '@tulipfarm/access';
import { withHuman } from './saved-policy.ts';
import { relation, type AgentStorage } from './store.ts';
import type { createAgentRecordTools } from './record-tools.ts';

/** Lowercase words of a title or message, ignoring case and punctuation. */
export const tableWords = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Whether a table title appears in one of the texts, ignoring case, punctuation and a plural "s". */
export function namesTable(texts: readonly string[], label: string) {
  const name = tableWords(label);
  if (!name) return false;
  const names = name.endsWith('s') && name.length > 1 ? [name, name.slice(0, -1).trimEnd()] : [name];
  return texts.some(text => {
    const padded = ` ${tableWords(text)} `;
    return names.some(candidate => padded.includes(` ${candidate} `) || padded.includes(` ${candidate}s `));
  });
}

/** Whether a tables.list name filter matches a title: either one contains the other, word for word. */
export function matchesTableName(filter: string, label: string) {
  return namesTable([label], filter) || namesTable([filter], label);
}

type VisibleTable = { id: string; name: string; owningTeamId: string; savedRevision: string };
type Records = Pick<ReturnType<typeof createAgentRecordTools>, 'list'>;

const listedTable = (table: VisibleTable, teams: ReadonlyMap<string, string>) => ({
  id: table.id,
  name: table.name,
  team: teams.get(table.owningTeamId) ?? null,
});
const quoted = (names: readonly string[]) => names.map(name => `"${name}"`).join(', ');

/** Of the tables named in a message, the most specific: "Meadow Stock" is dropped when "Forest Meadow Stock" is named too. */
function mostSpecific(tables: readonly VisibleTable[]) {
  return tables.filter(
    table =>
      !tables.some(
        other =>
          tableWords(other.name) !== tableWords(table.name) &&
          tableWords(other.name).length > tableWords(table.name).length &&
          namesTable([other.name], table.name),
      ),
  );
}

/**
 * Tables whose titles share words with the message, for a reply that names no existing table. A shared word counts
 * more the fewer titles use it, so "Island Stock" ranks "Island Supplies" above the many other "... Stock" tables.
 */
function closeTables<T extends { name: string }>(tables: readonly T[], message: string, limit = 5) {
  const said = new Set(tableWords(message).split(' '));
  const titles = tables.map(table => new Set(tableWords(table.name).split(' ')));
  const uses = new Map<string, number>();
  for (const title of titles) for (const word of title) uses.set(word, (uses.get(word) ?? 0) + 1);
  return tables
    .map((table, index) => {
      const shared = [...titles[index]!].filter(word => word.length > 2 && said.has(word));
      return { table, shared: shared.length, score: shared.reduce((sum, word) => sum + 1 / uses.get(word)!, 0) };
    })
    .filter(item => item.shared > 0)
    .sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name))
    .slice(0, limit)
    .map(item => item.table);
}

type Tx = Parameters<Parameters<typeof withHuman>[4]>[0];
type CatalogTable = { id: string; name: string };

// Names of every active table, read in one query; which of them the person can see is checked only for candidates.
const catalogTables = async (tx: Tx) =>
  (
    await tx.client.query<CatalogTable>(
      `SELECT id,display_name AS name FROM ${relation(tx, 'tf_table_catalog')} WHERE archived_at IS NULL`,
    )
  ).rows;

/** The tables with these IDs that the person can see, in the order given. */
async function visibleTables(records: Records, workspaceId: string, actor: HumanActor, ids: readonly string[]) {
  if (!ids.length) return [];
  const visible: VisibleTable[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const listed = await records.list(workspaceId, actor, { limit: 100, ids, ...(after && { after }) });
    visible.push(...listed.tables);
    if (!listed.nextCursor) break;
    after = listed.nextCursor;
  }
  const byId = new Map(visible.map(table => [table.id, table]));
  return ids.flatMap(id => byId.get(id) ?? []);
}

/** Close names the person can see, for a name no visible table has. */
async function closeVisibleTables(
  records: Records,
  workspaceId: string,
  actor: HumanActor,
  catalog: readonly CatalogTable[],
  text: string,
) {
  const ranked = closeTables(catalog, text, 20);
  return (
    await visibleTables(
      records,
      workspaceId,
      actor,
      ranked.map(table => table.id),
    )
  ).slice(0, 5);
}

// Team names are not secret: every table the person can see is labelled with its owning team.
const ownerTeams = async (runtime: AgentStorage, workspaceId: string, actor: HumanActor, teamIds: readonly string[]) =>
  teamIds.length
    ? await withHuman(
        runtime,
        workspaceId,
        actor,
        'read',
        async tx =>
          new Map(
            (
              await tx.client.query<{ id: string; name: string }>(
                `SELECT id,name FROM ${relation(tx, 'tf_teams')} WHERE id=ANY($1::uuid[])`,
                [[...new Set(teamIds)]],
              )
            ).rows.map(row => [row.id, row.name] as const),
          ),
      )
    : new Map<string, string>();

type Definitions = { tables: { id: string; definition: { label: string; owningTeamId: string } }[] };

/**
 * A chat tables.definitions result with each table's team, so tables that share a name can be told apart. For a name
 * the person used, it says when several tables share it, or lists close names when none has it, and it never offers
 * an ID to ask about.
 */
export async function chatTableDefinitions<T extends Definitions>(
  runtime: AgentStorage,
  records: Records,
  workspaceId: string,
  actor: HumanActor,
  name: string | undefined,
  result: T,
) {
  const ownerIds = result.tables.map(table => table.definition.owningTeamId);
  const teams = await ownerTeams(runtime, workspaceId, actor, ownerIds);
  const tables = result.tables.map(table => ({ ...table, team: teams.get(table.definition.owningTeamId) ?? null }));
  const rule = 'Never show the person a table ID or ask them for one.';
  if (!name) return { ...result, tables };
  if (!tables.length) {
    const catalog = await withHuman(runtime, workspaceId, actor, 'read', catalogTables);
    const close = await closeVisibleTables(records, workspaceId, actor, catalog, name);
    const closeTeams = await ownerTeams(
      runtime,
      workspaceId,
      actor,
      close.map(table => table.owningTeamId),
    );
    return {
      ...result,
      tables,
      similar: close.map(table => listedTable(table, closeTeams)).map(({ name, team }) => ({ name, team })),
      instruction: `No table you can see is called "${name}", so write nothing. Tell the person no table with that name exists or is ready${close.length ? `. Your reply must list these close names and ask whether they meant one: ${quoted(close.map(table => table.name))}` : ''}. Offer to create the table if they want one. ${rule}`,
    };
  }
  const labels = new Set(tables.map(table => tableWords(table.definition.label)));
  if (tables.length > 1 && labels.size === 1)
    return {
      ...result,
      tables,
      instruction: `${tables.length} tables are called "${tables[0]!.definition.label}". Unless the person already said which, write nothing and ask them which one they mean, telling the tables apart by team or fields. ${rule}`,
    };
  return { ...result, tables };
}

/**
 * When a chat table tool names a table ID that is not an active table, the model guessed it. Instead of a bare
 * failure, which models answer by asking the person for an ID, resolve the table by the name the person used:
 * return the one table they named, ask which one when several share that name, or say none matches and suggest
 * close names. People never know table IDs, so the result forbids asking for one. A write to a real table is
 * also held when the person's latest message names a title several tables share without naming the team of the
 * chosen one, or names other tables but not the chosen one. Returns null when the call can go ahead.
 */
export async function guessedChatTable(
  runtime: AgentStorage,
  records: Records,
  workspaceId: string,
  actor: HumanActor,
  origin: { conversationId: string },
  tableId: string,
  write: boolean,
) {
  const found = await withHuman(runtime, workspaceId, actor, 'read', async tx =>
    Boolean(
      (
        await tx.client.query(`SELECT 1 FROM ${relation(tx, 'tf_table_catalog')} WHERE id=$1 AND archived_at IS NULL`, [
          tableId,
        ])
      ).rowCount,
    ),
  );
  if (found && !write) return null;
  const { catalog, messages } = await withHuman(runtime, workspaceId, actor, 'read', async tx => ({
    catalog: await catalogTables(tx),
    messages: (
      await tx.client.query<{ text: string; sequence: number }>(
        `SELECT p.text,m.sequence FROM ${relation(tx, 'tf_conversation_parts')} p JOIN ${relation(tx, 'tf_conversation_messages')} m ON m.id=p.message_id AND m.conversation_id=p.conversation_id WHERE p.conversation_id=$1 AND m.author_kind='human' AND p.text IS NOT NULL ORDER BY m.sequence`,
        [origin.conversationId],
      )
    ).rows,
  }));
  // Only the tables the person named, the chosen table and those sharing its name are checked for access.
  const texts = messages.map(message => message.text);
  const chosen = catalog.find(table => table.id === tableId);
  const visible = await visibleTables(
    records,
    workspaceId,
    actor,
    catalog
      .filter(
        table =>
          table.id === tableId ||
          namesTable(texts, table.name) ||
          (chosen && tableWords(table.name) === tableWords(chosen.name)),
      )
      .map(table => table.id),
  );
  const teams = await ownerTeams(
    runtime,
    workspaceId,
    actor,
    visible.map(table => table.owningTeamId),
  );
  const lastSequence = messages.at(-1)?.sequence;
  const latest = messages.filter(message => message.sequence === lastSequence).map(message => message.text);
  const sources = (tables: readonly VisibleTable[]) =>
    tables.map(table => ({ kind: 'table-schema' as const, tableId: table.id, revision: table.savedRevision }));
  const named = (texts: readonly string[]) => mostSpecific(visible.filter(table => namesTable(texts, table.name)));
  const target = found ? visible.find(table => table.id === tableId) : undefined;
  if (found && !target) return null;
  // A write to a table the person did not name goes ahead, on its review card, unless they named other tables.
  if (target && !namesTable(latest, target.name) && !named(latest).length) return null;
  if (target && namesTable(latest, target.name)) {
    const sameName = visible.filter(table => tableWords(table.name) === tableWords(target.name));
    const team = teams.get(target.owningTeamId);
    if (sameName.length < 2 || (team && namesTable(latest, team))) return null;
    return {
      result: {
        error: 'table-ambiguous',
        tables: sameName.map(table => listedTable(table, teams)),
        instruction: `${sameName.length} tables are called "${target.name}" and the person did not say which, so nothing was written. Ask them which one they mean, telling the tables apart by their team or their fields. Never ask for a table ID.`,
      },
      sources: sources(sameName),
    };
  }
  const matches = named(latest).length ? named(latest) : named(messages.map(message => message.text));
  const names = [...new Set(matches.map(table => tableWords(table.name)))];
  const prefix = target
    ? `Nothing was written: the person did not name "${target.name}", the table you used. Never ask the person for a table ID.`
    : 'No table has the ID you used: never make up a table ID, and never ask the person for one.';
  if (matches.length === 1) {
    const [table] = matches as [VisibleTable];
    return {
      result: {
        error: 'table-not-found',
        tables: [listedTable(table, teams)],
        instruction: `${prefix} The person named "${table.name}", whose table ID is ${table.id}. Call this tool again with that tableId; read its fields with schema.inspect first if you have not.`,
      },
      sources: sources(matches),
    };
  }
  if (matches.length > 1 && names.length === 1)
    return {
      result: {
        error: 'table-ambiguous',
        tables: matches.map(table => listedTable(table, teams)),
        instruction: `${prefix} ${matches.length} tables are called "${matches[0]!.name}". Write nothing yet. Ask the person which one they mean, telling the tables apart by their team or their fields, never by ID.`,
      },
      sources: sources(matches),
    };
  if (matches.length > 1)
    return {
      result: {
        error: 'table-not-found',
        tables: matches.map(table => listedTable(table, teams)),
        instruction: `${prefix} The person named these tables: ${quoted(matches.map(table => table.name))}. Use the ID of the one this change is for and call this tool again.`,
      },
      sources: sources(matches),
    };
  const close = await closeVisibleTables(records, workspaceId, actor, catalog, latest.join(' '));
  const closeTeams = await ownerTeams(
    runtime,
    workspaceId,
    actor,
    close.map(table => table.owningTeamId),
  );
  return {
    result: {
      error: 'table-not-found',
      tables: close.map(table => listedTable(table, closeTeams)),
      instruction: `${prefix} No table you can see has the name the person used, so write nothing. Tell them no table with that name exists or is ready${close.length ? `. Your reply must list these close names and ask whether they meant one: ${quoted(close.map(table => table.name))}` : ''}. Offer to create the table if they want one. Never show the person a table ID.`,
    },
    sources: sources(close),
  };
}
