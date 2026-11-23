import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mock, test } from 'node:test';

const actorContext = new AsyncLocalStorage();
let world;

mock.module('node:timers/promises', {
  exports: { setTimeout: ms => world.sleep(actorContext.getStore(), ms) },
});
mock.method(performance, 'now', () => world.now);
const { lockAuthorization } = await import('../src/index.ts');

const lockTimeoutMs = 5_000;
const lockError = code => Object.assign(new Error(`lock wait failed (${code})`), { code });
const advisoryCompatible = (a, b) => a === 'shared' && b === 'shared';
const rowCompatible = (a, b) => a === 'share' && b === 'share';

function parseLock(sql) {
  const advisory = /pg_try_advisory_xact_lock_shared\(/.test(sql)
    ? { mode: 'shared', wait: false }
    : /pg_advisory_xact_lock_shared\(/.test(sql)
      ? { mode: 'shared', wait: true }
      : /pg_advisory_xact_lock\(/.test(sql)
        ? { mode: 'exclusive', wait: true }
        : undefined;
  const row = /FOR UPDATE/.test(sql) ? 'update' : /FOR SHARE/.test(sql) ? 'share' : undefined;
  if (!row || !/tf_authorization_lock/.test(sql)) return undefined;
  return { advisory, row, skipLocked: /SKIP LOCKED/.test(sql) };
}

class World {
  now = 0;
  version = 0;
  advisory = [];
  rows = [];

  constructor(actors, timeoutsPerActor) {
    this.timeoutsPerActor = timeoutsPerActor;
    this.actors = actors.map(([name, mode]) => ({
      name,
      mode,
      state: 'idle',
      level: 0,
      aborted: false,
      queue: [],
      running: undefined,
      waiting: undefined,
      waitingSince: undefined,
      lockSubmittedAt: undefined,
      timeouts: 0,
      sleeping: undefined,
      commit: undefined,
      outcome: undefined,
    }));
  }

  touch() {
    this.version++;
  }

  sleep(actor, ms) {
    this.touch();
    return new Promise(resolve => {
      actor.sleeping = { wakeAt: this.now + ms, resolve };
    });
  }

  submit(actor, sql) {
    this.touch();
    return new Promise((resolve, reject) => {
      actor.queue.push({ sql, resolve, reject });
      if (!actor.running) this.next(actor);
    });
  }

  next(actor) {
    const statement = actor.queue.shift();
    actor.running = statement;
    if (statement) this.execute(actor, statement);
  }

  finish(actor, statement, outcome) {
    this.touch();
    if ('error' in outcome) statement.reject(outcome.error);
    else statement.resolve(outcome.result);
    actor.running = undefined;
    this.next(actor);
  }

  execute(actor, statement) {
    const sql = statement.sql.trim();
    if (actor.aborted && !sql.startsWith('ROLLBACK TO SAVEPOINT'))
      return this.finish(actor, statement, { error: lockError('25P02') });
    if (sql.startsWith('SAVEPOINT')) {
      actor.level++;
      return this.finish(actor, statement, { result: { rowCount: null } });
    }
    if (sql.startsWith('RELEASE SAVEPOINT')) {
      for (const held of this.heldBy(actor)) if (held.level === actor.level) held.level--;
      actor.level--;
      return this.finish(actor, statement, { result: { rowCount: null } });
    }
    if (sql.startsWith('ROLLBACK TO SAVEPOINT')) {
      this.drop(held => held.actor === actor && held.level >= actor.level);
      actor.aborted = false;
      return this.finish(actor, statement, { result: { rowCount: null } });
    }
    const lock = parseLock(sql);
    if (!lock) throw new Error(`The lock model does not know this statement; teach it: ${sql}`);
    actor.lockSubmittedAt = this.version;
    this.touch();
    statement.lock = lock;
    statement.stage = lock.advisory ? 'advisory' : 'row';
    this.advance(actor, statement);
  }

  heldBy(actor) {
    return [...this.advisory.filter(entry => entry.granted), ...this.rows].filter(entry => entry.actor === actor);
  }

  advisoryGrantable(entry) {
    const ahead = this.advisory.slice(0, this.advisory.indexOf(entry));
    return this.advisory.every(
      other =>
        other === entry ||
        other.actor === entry.actor ||
        (!other.granted && !ahead.includes(other)) ||
        advisoryCompatible(entry.mode, other.mode),
    );
  }

  rowGrantable(actor, mode) {
    return this.rows.every(held => held.actor === actor || rowCompatible(mode, held.mode));
  }

  advance(actor, statement) {
    const { lock } = statement;
    if (statement.stage === 'advisory') {
      const entry = { actor, mode: lock.advisory.mode, granted: false, level: actor.level };
      this.advisory.push(entry);
      if (!this.advisoryGrantable(entry)) {
        if (lock.advisory.wait) return this.wait(actor, statement, entry);
        this.advisory.splice(this.advisory.indexOf(entry), 1);
        return this.finish(actor, statement, { result: { rowCount: 0 } });
      }
      entry.granted = true;
      statement.stage = 'row';
    }
    if (this.rowGrantable(actor, lock.row)) return this.grantRow(actor, statement);
    if (lock.skipLocked) return this.finish(actor, statement, { result: { rowCount: 0 } });
    this.wait(actor, statement, { actor, mode: lock.row });
  }

  grantRow(actor, statement) {
    this.checkFairness(actor);
    this.rows.push({ actor, mode: statement.lock.row, level: actor.level });
    this.finish(actor, statement, { result: { rowCount: 1 } });
  }

  wait(actor, statement, entry) {
    this.touch();
    actor.waiting = { statement, entry };
    actor.waitingSince ??= this.version;
  }

  stopWaiting(actor) {
    const { statement, entry } = actor.waiting;
    actor.waiting = undefined;
    actor.waitingSince = undefined;
    if (statement.stage === 'advisory') this.advisory.splice(this.advisory.indexOf(entry), 1);
    return statement;
  }

  regrant() {
    for (let changed = true; changed;) {
      changed = false;
      for (const actor of this.actors) {
        if (!actor.waiting) continue;
        const { statement, entry } = actor.waiting;
        if (statement.stage === 'advisory' ? !this.advisoryGrantable(entry) : !this.rowGrantable(actor, entry.mode))
          continue;
        changed = true;
        if (statement.stage === 'advisory') {
          entry.granted = true;
          actor.waiting = undefined;
          statement.stage = 'row';
          this.advance(actor, statement);
          if (!actor.waiting) actor.waitingSince = undefined;
        } else {
          this.stopWaiting(actor);
          this.grantRow(actor, statement);
        }
      }
    }
  }

  drop(predicate) {
    this.advisory = this.advisory.filter(entry => !(entry.granted && predicate(entry)));
    this.rows = this.rows.filter(entry => !predicate(entry));
    this.regrant();
  }

  timeout(actor) {
    const statement = this.stopWaiting(actor);
    actor.timeouts++;
    actor.aborted = true;
    this.now += lockTimeoutMs;
    this.finish(actor, statement, { error: lockError('55P03') });
    this.regrant();
  }

  end(actor) {
    this.touch();
    this.advisory = this.advisory.filter(entry => entry.actor !== actor);
    this.drop(entry => entry.actor === actor);
  }

  start(actor) {
    actor.state = 'locking';
    this.touch();
    const transaction = { schema: 'workspace_model', client: { query: sql => this.submit(actor, sql) } };
    actorContext.run(actor, async () => {
      try {
        await lockAuthorization(transaction, actor.mode);
        actor.state = 'holding';
        this.touch();
        await new Promise(resolve => {
          actor.commit = resolve;
        });
      } catch (error) {
        actor.outcome = error;
      } finally {
        this.end(actor);
        actor.state = 'done';
        this.touch();
      }
    });
  }

  checkFairness(acquirer) {
    for (const writer of this.actors)
      if (
        writer !== acquirer &&
        writer.mode === 'write' &&
        writer.waitingSince !== undefined &&
        writer.waitingSince < acquirer.lockSubmittedAt
      )
        this.violation ??= `${acquirer.name} took the lock ahead of ${writer.name}, a write that was already waiting`;
  }

  events() {
    const events = [];
    for (const actor of this.actors) {
      if (actor.state === 'idle') events.push({ kind: 'start', actor });
      if (actor.state === 'holding') events.push({ kind: 'commit', actor });
      if (actor.waiting && actor.timeouts < this.timeoutsPerActor) events.push({ kind: 'timeout', actor });
      if (actor.sleeping) events.push({ kind: 'wake', actor });
    }
    return events;
  }

  apply({ kind, actor }) {
    if (kind === 'start') return this.start(actor);
    if (kind === 'commit') return actor.commit();
    if (kind === 'timeout') return this.timeout(actor);
    const { wakeAt, resolve } = actor.sleeping;
    actor.sleeping = undefined;
    this.now = Math.max(this.now, wakeAt);
    this.touch();
    resolve();
  }

  checkExclusion() {
    const holders = this.actors.filter(actor => actor.state === 'holding');
    if (holders.length > 1 && holders.some(actor => actor.mode === 'write'))
      this.violation ??= `${holders.map(actor => actor.name).join(' and ')} hold the lock together, one of them a write`;
  }

  checkOutcomes() {
    for (const actor of this.actors)
      if (actor.outcome)
        this.violation ??= `${actor.name} (${actor.mode}) failed with ${actor.outcome.code ?? actor.outcome.message} after ${actor.timeouts} lock timeout`;
  }
}

async function settle() {
  for (let seen = -1; seen !== world.version;) {
    seen = world.version;
    for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve));
  }
}

async function runOnce(actors, timeouts, path) {
  world = new World(actors, timeouts);
  const choices = [];
  const counts = [];
  const steps = [];
  for (let depth = 0; ; depth++) {
    await settle();
    world.checkExclusion();
    world.checkOutcomes();
    if (world.violation) return { violation: world.violation, steps, choices, counts };
    const events = world.events();
    if (events.length === 0) {
      const stuck = world.actors.filter(actor => actor.state !== 'done');
      if (stuck.length) return { violation: `${stuck.map(actor => actor.name).join(', ')} never finished`, steps };
      return { choices, counts };
    }
    const choice = path[depth] ?? 0;
    choices.push(choice);
    counts.push(events.length);
    const event = events[choice];
    steps.push(`${event.kind} ${event.actor.name}`);
    world.apply(event);
  }
}

async function explore(actors, { timeouts }) {
  let path = [];
  for (let runs = 1; ; runs++) {
    const result = await runOnce(actors, timeouts, path);
    if (result.violation) return { ...result, runs };
    let depth = result.choices.length - 1;
    while (depth >= 0 && result.choices[depth] + 1 >= result.counts[depth]) depth--;
    if (depth < 0) return { runs };
    path = [...result.choices.slice(0, depth), result.choices[depth] + 1];
  }
}

function assertNoViolation({ violation, steps, runs }) {
  assert.equal(violation, undefined, `${violation}\n  after: ${steps?.join(' → ')}\n  (interleaving ${runs})`);
  assert.ok(runs > 20, `explored only ${runs} interleavings`);
}

const scenarios = {
  'a read, a write and a read': [
    ['reader A', 'read'],
    ['writer W', 'write'],
    ['reader B', 'read'],
  ],
  'two writes and a read': [
    ['writer V', 'write'],
    ['reader A', 'read'],
    ['writer W', 'write'],
  ],
};

for (const [name, actors] of Object.entries(scenarios)) {
  test(`${name}: no read takes the lock ahead of a waiting write, and a write holds it alone`, async () => {
    assertNoViolation(await explore(actors, { timeouts: 0 }));
  });

  test(`${name}: a lock wait that times out once is retried, not failed`, async () => {
    assertNoViolation(await explore(actors, { timeouts: 1 }));
  });
}
