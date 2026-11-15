import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickGreeting, pickHomeGreeting } from '../src/features/chat/greeting.ts';

test('greets first-time and returning users by first name', () => {
  assert.equal(pickGreeting('  Dhruv Jain  ', true), 'Welcome, Dhruv');
  assert.equal(pickGreeting('Dhruv', false), 'Welcome back, Dhruv');
  assert.equal(pickGreeting('Éva Smith', true), 'Welcome, Éva');
  assert.equal(pickGreeting('Dhruv', null), 'What should we work on?');
});

test('omits missing names, initials, and email addresses', () => {
  for (const name of [undefined, '', '   ', 'M', 'M.', 'M Smith', 'M. Smith', 'É', '🦉', 'm@example.com']) {
    assert.equal(pickGreeting(name, true), 'Welcome to TulipFarm');
    assert.equal(pickGreeting(name, false), 'Welcome back');
  }
});

const sequence = (...values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length]!;
};
const title = (greeting: ReturnType<typeof pickHomeGreeting>) =>
  `${greeting.before}${greeting.name ?? ''}${greeting.after}`;

test('home greeting varies with the draw and follows the time of day', () => {
  const tuesdayMorning = new Date(2026, 10, 10, 9);
  const titles = new Set(
    [0, 0.2, 0.4, 0.6, 0.8].map(roll => title(pickHomeGreeting('Dhruv', false, tuesdayMorning, sequence(roll)))),
  );
  assert.ok(titles.size > 3, 'different draws give different titles');
  for (const morning of titles) assert.doesNotMatch(morning, /evening|afternoon|late|Friday|weekend/i);
  const night = title(pickHomeGreeting('Dhruv', false, new Date(2026, 10, 10, 23), sequence(0)));
  assert.equal(night, 'Working late, Dhruv?');
});

test('home greeting adds day-specific titles and isolates the name', () => {
  const fridayAfternoon = new Date(2026, 10, 13, 15);
  const all = new Set(
    Array.from({ length: 20 }, (_, index) =>
      title(pickHomeGreeting('Dhruv', false, fridayAfternoon, sequence(index / 20))),
    ),
  );
  assert.ok(all.has('Happy Friday, Dhruv'));
  const saturday = Array.from({ length: 20 }, (_, index) =>
    pickHomeGreeting('Dhruv', false, new Date(2026, 10, 14, 11), sequence(index / 20)),
  );
  assert.ok(saturday.some(greeting => title(greeting) === 'Happy Saturday, Dhruv'));
  for (const greeting of saturday) assert.equal(greeting.name, 'Dhruv');
});

test('home greeting falls back without a name and welcomes first sessions', () => {
  const greeting = pickHomeGreeting('m@example.com', false, new Date(2026, 10, 10, 23), sequence(0));
  assert.deepEqual([greeting.name, title(greeting)], [null, 'Working late?']);
  const first = pickHomeGreeting('Dhruv', true, new Date(2026, 10, 10, 9), sequence(0));
  assert.equal(title(first), 'Welcome, Dhruv');
  assert.equal(first.subtitle, 'How can I help you today?');
});

test('home greeting stays neutral until the visit is known', () => {
  const greeting = pickHomeGreeting('Dhruv', null, new Date(2026, 10, 10, 9), sequence(0));
  assert.deepEqual(greeting, { before: 'What should we work on?', name: null, after: '', subtitle: '' });
});
