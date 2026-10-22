import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { createAuth } from '../src/auth.ts';

export async function authenticatedFixture(db) {
  if (!(await db.platform.query(`SELECT to_regclass('app.users') AS users`)).rows[0].users)
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const identity = new Pool({ connectionString: db.connectionString, options: '-c search_path=app' });
  try {
    const links = [];
    const auth = createAuth(
      identity,
      async ({ url }) => {
        links.push(url);
      },
      async () => {},
    );
    async function signIn() {
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: 'http://localhost:5173' }),
        body: { email: `${randomUUID()}@example.com` },
      });
      const response = await auth.handler(new Request(links.pop()));
      const cookie = response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      return { id: session.user.id, cookie };
    }
    const owner = await signIn(),
      admin = await signIn();
    async function addAdmin(workspace) {
      const membershipId = randomUUID();
      await db.platform.query(
        `INSERT INTO ${qualified(workspace.names.schema, 'tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`,
        [membershipId, admin.id],
      );
      return membershipId;
    }
    return { identity, auth, owner, admin, signIn, addAdmin };
  } catch (error) {
    await identity.end();
    throw error;
  }
}
