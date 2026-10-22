import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { registerAuth } from './auth.ts';

export function registerUserVisits(
  app: FastifyInstance,
  { auth, pool }: ReturnType<typeof registerAuth>,
  origin: string,
) {
  app.post('/user/visit', { schema: { hide: true } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin !== origin) return reply.code(403).send({ error: 'untrusted-origin' });
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) return reply.code(401).send({ error: 'sign-in-required' });
    const result = await pool.query(
      `
      INSERT INTO app.user_visits (user_id, first_session_id) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING COALESCE(first_session_id = $2, false) AS first_session
    `,
      [session.user.id, session.session.id],
    );
    const row = z.object({ first_session: z.boolean() }).parse(result.rows[0]);
    return { firstSession: row.first_session };
  });
}
