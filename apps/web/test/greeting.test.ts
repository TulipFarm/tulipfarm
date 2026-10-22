import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickGreeting } from '../src/features/chat/greeting.ts';

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
