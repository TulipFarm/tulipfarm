import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveHuman, currentMember, type AuthorizationTransaction } from '@tulipfarm/access';
import {
  McpError,
  hostedBindings,
  packageKey,
  type IntegrationRow,
  type McpHostLaunch,
  type McpHostTarget,
  type McpPrincipal,
  type McpSecretVersion,
  type WorkspaceMcpOptions,
} from './contracts.ts';
import { table, type McpStore } from './store.ts';
import { hostedEgress, hostedFingerprint } from './validation.ts';

export const hostedLimits = {
  /** Building the package image, then starting it, each have their own bound inside the host. */
  buildMs: 10 * 60_000,
  startMs: 2 * 60_000,
  connectMs: 30_000,
  removeMs: 30_000,
  /** A claim older than this with no ready sandbox is treated as abandoned. */
  staleClaimMs: 15 * 60_000,
  dailyBuilds: 10,
};
export const installingReason = 'Installing the package. This can take a few minutes.';
export const installFailedReason =
  'The package could not be installed or did not start. Check its name, version and settings.';

const hostRowSchema = z.object({
  generation: z.number().int(),
  sandbox_id: z.string().nullable(),
  fingerprint: z.string().nullable(),
  launched: z
    .object({
      secrets: z.array(z.object({ secretId: z.uuid(), version: z.number().int(), policyVersion: z.number().int() })),
    })
    .nullable(),
  claimed_at: z.date().nullable(),
  ready_at: z.date().nullable(),
});
type HostRow = z.infer<typeof hostRowSchema>;
type Requester = { principal: McpPrincipal } | { membershipId: string };
type Prepared =
  | { kind: 'ready'; row: IntegrationRow; sandboxId: string; generation: number; values: string[] }
  | {
      kind: 'provision';
      row: IntegrationRow;
      launch: McpHostLaunch;
      buildId: string | null;
      previous: { sandboxId: string; generation: number } | null;
      versions: McpSecretVersion[];
      values: string[];
    };

const versionsKey = (secrets: readonly McpSecretVersion[]) =>
  JSON.stringify(
    secrets
      .map(({ secretId, version, policyVersion }) => [secretId, version, policyVersion])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );

async function hostRow(tx: AuthorizationTransaction, integrationId: string, lock = true) {
  return hostRowSchema
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT generation,sandbox_id,fingerprint,launched,claimed_at,ready_at FROM ${table(tx, 'hosts')} WHERE integration_id=$1${lock ? ' FOR UPDATE' : ''}`,
          [integrationId],
        )
      ).rows[0],
    );
}

async function bounded<T>(ms: number, parent: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>) {
  const signal = AbortSignal.any([AbortSignal.timeout(ms), ...(parent ? [parent] : [])]);
  return Promise.race([
    operation(signal),
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new McpError('expired'));
      signal.addEventListener('abort', () => reject(new McpError('expired')), { once: true });
    }),
  ]);
}

/**
 * Runs hosted integrations on the sandbox host. Provisioning happens between short transactions, never inside one:
 * a claim on the next sandbox generation, the host's build and start, then a publish that succeeds only if nothing the
 * sandbox was launched with changed meanwhile.
 */
export function hostedMethods(options: WorkspaceMcpOptions, store: McpStore) {
  async function within<T>(
    workspaceId: string,
    requester: Requester,
    operation: (tx: AuthorizationTransaction, membershipId: string) => Promise<T>,
  ) {
    return store.transaction(workspaceId, async tx => {
      if ('membershipId' in requester) return operation(tx, requester.membershipId);
      const actor =
        typeof requester.principal === 'string' ? await resolveHuman(tx, requester.principal) : requester.principal;
      await currentMember(tx, actor);
      return operation(tx, actor.membershipId);
    });
  }
  /** What the sandbox needs now, read for one member: its launch, fingerprint and the secret versions it holds. */
  async function launchFor(
    tx: AuthorizationTransaction,
    workspaceId: string,
    membershipId: string,
    row: IntegrationRow,
    generation: number,
  ) {
    const credential = store.hostedCredential(workspaceId, row);
    const bindings = hostedBindings(credential);
    const versions = await store.checkHosted(tx, row, credential);
    if (!options.hostedSecrets?.resolve) throw new McpError('disabled');
    let resolved;
    try {
      resolved = await options.hostedSecrets.resolve(tx, {
        workspaceId,
        membershipId,
        bindings,
        serverIdentity: row.server_identity,
        expected: versions,
      });
    } catch {
      throw new McpError('credential-unavailable');
    }
    const egress = hostedEgress(row.egress!, resolved);
    const fingerprint = hostedFingerprint({
      package: row.package!,
      egress,
      secretVersion: row.secret_version,
      names: credential.env.map(entry => entry.name),
      bindings,
      secrets: resolved,
    });
    const variables: Record<string, string> = {};
    const protectedSecrets: McpHostLaunch['protectedSecrets'] = [];
    for (const entry of credential.env) {
      if (!('secretId' in entry)) {
        variables[entry.name] = entry.value;
        continue;
      }
      const secret = resolved.find(secret => secret.secretId === entry.secretId);
      if (!secret) throw new McpError('credential-unavailable');
      if (entry.reveal) variables[entry.name] = secret.value;
      else if (secret.placement && secret.hosts.length)
        protectedSecrets.push({
          variable: entry.name,
          value: secret.value,
          hosts: secret.hosts,
          placement: secret.placement,
        });
      else throw new McpError('secret-denied');
    }
    const launch: McpHostLaunch = {
      workspaceId,
      integrationId: row.id,
      generation,
      fingerprint,
      package: row.package!,
      env: variables,
      protectedSecrets,
      egress,
    };
    return {
      launch,
      versions: resolved.map(({ secretId, version, policyVersion }) => ({ secretId, version, policyVersion })),
      values: resolved.flatMap(secret => [secret.value, ...secret.parts]),
    };
  }
  async function prepare(workspaceId: string, requester: Requester, id: string): Promise<Prepared | null> {
    return within(workspaceId, requester, async (tx, membershipId) => {
      const row = await store.load(tx, id);
      if (row.kind !== 'hosted') return null;
      store.active(row);
      if (!store.hostedStorage(tx)) throw new McpError('disabled');
      const current = await hostRow(tx, id);
      const wanted = await launchFor(tx, workspaceId, membershipId, row, (current?.generation ?? 0) + 1);
      if (current?.sandbox_id && current.ready_at && current.fingerprint === wanted.launch.fingerprint)
        return {
          kind: 'ready' as const,
          row,
          sandboxId: current.sandbox_id,
          generation: current.generation,
          values: wanted.values,
        };
      const key = `${packageKey(row.package!)}@${row.package!.version}`;
      let buildId: string | null = null;
      if (
        !(
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'builds')} WHERE package_key=$1 AND outcome='ready' LIMIT 1`,
            [key],
          )
        ).rowCount
      ) {
        const { count } = z
          .object({ count: z.number() })
          .parse(
            (
              await tx.client.query(
                `SELECT count(*)::integer AS count FROM ${table(tx, 'builds')} WHERE started_at>clock_timestamp()-interval '1 day'`,
              )
            ).rows[0],
          );
        if (count >= hostedLimits.dailyBuilds) throw new McpError('limit');
        buildId = randomUUID();
        await tx.client.query(`INSERT INTO ${table(tx, 'builds')} (id,integration_id,package_key) VALUES ($1,$2,$3)`, [
          buildId,
          id,
          key,
        ]);
      }
      const { generation } = z.object({ generation: z.number().int() }).parse(
        (
          await tx.client.query(
            `INSERT INTO ${table(tx, 'hosts')} (integration_id,generation,fingerprint,claimed_at) VALUES ($1,1,$2,clock_timestamp())
              ON CONFLICT (integration_id) DO UPDATE SET generation=tf_mcp_hosts.generation+1,fingerprint=EXCLUDED.fingerprint,sandbox_id=NULL,launched=NULL,ready_at=NULL,claimed_at=EXCLUDED.claimed_at
              RETURNING generation`,
            [id, wanted.launch.fingerprint],
          )
        ).rows[0],
      );
      await tx.client.query(
        `UPDATE ${table(tx, 'integrations')} SET status_reason=$2 WHERE id=$1 AND status_reason IS DISTINCT FROM $2`,
        [id, installingReason],
      );
      return {
        kind: 'provision' as const,
        row,
        launch: { ...wanted.launch, generation },
        buildId,
        previous: current?.sandbox_id ? { sandboxId: current.sandbox_id, generation: current.generation } : null,
        versions: wanted.versions,
        values: wanted.values,
      };
    });
  }
  async function remove(entry: { workspaceId: string; integrationId: string; sandboxId: string; generation: number }) {
    try {
      await bounded(hostedLimits.removeMs, undefined, signal => options.host!.remove(entry, signal));
      return true;
    } catch {
      return false;
    }
  }
  async function publish(workspaceId: string, prepared: Extract<Prepared, { kind: 'provision' }>, sandboxId: string) {
    return store.transaction(workspaceId, async tx => {
      const row = await store.load(tx, prepared.row.id);
      const current = await hostRow(tx, row.id);
      if (
        row.lifecycle !== 'active' ||
        row.refresh_claim ||
        row.authorization_epoch !== prepared.row.authorization_epoch ||
        row.secret_version !== prepared.row.secret_version ||
        current?.generation !== prepared.launch.generation ||
        current.fingerprint !== prepared.launch.fingerprint
      )
        return false;
      const versions = await store.checkHosted(tx, row, store.hostedCredential(workspaceId, row)).catch(() => null);
      if (!versions || versionsKey(versions) !== versionsKey(prepared.versions)) return false;
      const updated = await tx.client.query(
        `UPDATE ${table(tx, 'hosts')} SET sandbox_id=$3,launched=$4,ready_at=clock_timestamp() WHERE integration_id=$1 AND generation=$2`,
        [row.id, prepared.launch.generation, sandboxId, JSON.stringify({ secrets: prepared.versions })],
      );
      if (!updated.rowCount) return false;
      if (prepared.buildId)
        await tx.client.query(`UPDATE ${table(tx, 'builds')} SET outcome='ready' WHERE id=$1`, [prepared.buildId]);
      await tx.client.query(
        `UPDATE ${table(tx, 'integrations')} SET status_reason=NULL WHERE id=$1 AND status_reason=$2`,
        [row.id, installingReason],
      );
      return true;
    });
  }
  async function fail(workspaceId: string, prepared: Extract<Prepared, { kind: 'provision' }>) {
    await store.transaction(workspaceId, async tx => {
      if (prepared.buildId)
        await tx.client.query(`UPDATE ${table(tx, 'builds')} SET outcome='failed' WHERE id=$1 AND outcome='started'`, [
          prepared.buildId,
        ]);
      const claimed = await tx.client.query(
        `UPDATE ${table(tx, 'hosts')} SET claimed_at=NULL WHERE integration_id=$1 AND generation=$2 AND ready_at IS NULL`,
        [prepared.row.id, prepared.launch.generation],
      );
      if (claimed.rowCount)
        await tx.client.query(`UPDATE ${table(tx, 'integrations')} SET status_reason=$2 WHERE id=$1`, [
          prepared.row.id,
          installFailedReason,
        ]);
    });
  }
  async function forget(workspaceId: string, integrationId: string, sandboxId: string, generation: number) {
    await store.transaction(workspaceId, tx =>
      tx.client.query(
        `UPDATE ${table(tx, 'hosts')} SET sandbox_id=NULL,launched=NULL,ready_at=NULL WHERE integration_id=$1 AND generation=$2 AND sandbox_id=$3`,
        [integrationId, generation, sandboxId],
      ),
    );
  }
  /**
   * Makes sure a hosted integration's sandbox runs what the integration names now, provisioning it if needed, and
   * returns where to reach it. Returns null for a remote integration. Never call this inside a transaction.
   */
  async function ensureHosted(
    workspaceId: string,
    requester: Requester,
    id: string,
    signal?: AbortSignal,
  ): Promise<{ hostTarget: McpHostTarget; values: string[] } | null> {
    for (let attempt = 0; ; attempt++) {
      const prepared = await prepare(workspaceId, requester, id);
      if (!prepared) return null;
      const host = options.host;
      if (!host) throw new McpError('disabled');
      let sandboxId: string;
      if (prepared.kind === 'ready') sandboxId = prepared.sandboxId;
      else {
        if (prepared.previous) await remove({ workspaceId, integrationId: id, ...prepared.previous });
        try {
          sandboxId = (
            await bounded(hostedLimits.buildMs + hostedLimits.startMs, signal, timeout =>
              host.provision(prepared.launch, timeout),
            )
          ).sandboxId;
          z.string().min(1).max(256).parse(sandboxId);
        } catch (error) {
          await fail(workspaceId, prepared);
          throw new McpError('install-failed', { cause: error });
        }
        if (!(await publish(workspaceId, prepared, sandboxId))) {
          await remove({ workspaceId, integrationId: id, sandboxId, generation: prepared.launch.generation });
          if (attempt) throw new McpError('conflict');
          continue;
        }
      }
      const generation = prepared.kind === 'ready' ? prepared.generation : prepared.launch.generation;
      try {
        const target = await bounded(hostedLimits.connectMs, signal, timeout => host.connect({ sandboxId }, timeout));
        const hostTarget = z
          .object({ endpoint: z.url({ protocol: /^https?$/ }), headers: z.record(z.string(), z.string()) })
          .parse(target);
        return { hostTarget, values: [...prepared.values, ...Object.values(hostTarget.headers)] };
      } catch (error) {
        await forget(workspaceId, id, sandboxId, generation);
        if (attempt) throw new McpError('integration-unavailable', { cause: error });
      }
    }
  }
  /** Whether a sandbox the host reports still matches an active integration and what it may currently use. */
  async function current(
    tx: AuthorizationTransaction,
    workspaceId: string,
    entry: { integrationId: string; sandboxId: string; generation: number },
    row: IntegrationRow,
    hosted: HostRow | undefined,
  ) {
    if (!hosted || hosted.generation !== entry.generation) return false;
    if (row.kind !== 'hosted' || row.lifecycle !== 'active' || !row.credential) return false;
    if (!hosted.ready_at)
      return !!hosted.claimed_at && hosted.claimed_at.getTime() > Date.now() - hostedLimits.staleClaimMs;
    if (hosted.sandbox_id !== entry.sandboxId || !hosted.launched) return false;
    const credential = store.hostedCredential(workspaceId, row);
    const versions = await store.checkHosted(tx, row, credential);
    if (versionsKey(versions) !== versionsKey(hosted.launched.secrets)) return false;
    return true;
  }
  return {
    ensureHosted,
    /**
     * Removes every sandbox the host runs whose integration is gone, inactive or replaced, or which holds a secret
     * someone who uses the integration may no longer send. Keeps a sandbox when its workspace cannot be read.
     */
    async sweepHosted(signal: AbortSignal) {
      const host = options.host;
      if (!host) return { checked: 0, removed: 0 };
      let checked = 0;
      let removed = 0;
      for await (const entry of host.list(signal)) {
        signal.throwIfAborted();
        checked++;
        let keep = true;
        try {
          keep = await store.transaction(entry.workspaceId, async tx => {
            if (!store.hostedStorage(tx)) return false;
            const row = await store.load(tx, entry.integrationId).catch(() => null);
            if (!row) return false;
            const hosted = await hostRow(tx, row.id);
            const fine = await current(tx, entry.workspaceId, entry, row, hosted).catch(() => false);
            if (!fine)
              await tx.client.query(
                `UPDATE ${table(tx, 'hosts')} SET sandbox_id=NULL,launched=NULL,ready_at=NULL WHERE integration_id=$1 AND generation=$2 AND sandbox_id=$3`,
                [row.id, entry.generation, entry.sandboxId],
              );
            return fine;
          });
        } catch {
          keep = true;
        }
        if (!keep && (await remove(entry))) removed++;
      }
      return { checked, removed };
    },
  };
}
