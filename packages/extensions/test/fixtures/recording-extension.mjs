// A fixture extension that fills every server slot and records what it receives.
export const received = { events: [], errors: [], usage: [], hooks: [], contexts: [] };

export default {
  name: 'fixture-recording',
  register(slots, context) {
    received.contexts.push(context.app);
    slots.creditGate({
      available: async () => 0n,
      debit: async () => {
        throw new Error('credits-exhausted');
      },
    });
    slots.flagProvider({ isEnabled: async flag => flag === 'on' });
    slots.usageSink({
      record: usage => {
        received.usage.push(usage);
      },
    });
    slots.analytics({
      capture: event => {
        received.events.push(event);
      },
    });
    slots.errorReporter({
      captureException: (error, distinctId) => {
        received.errors.push({ error, distinctId });
      },
    });
    slots.hooks({
      'user.signed-up': payload => {
        received.hooks.push(payload);
      },
    });
    slots.migrations({
      schema: 'fixture',
      migrations: [{ name: '0001_init.sql', sql: 'CREATE TABLE fixture.t (id int);' }],
    });
  },
};
