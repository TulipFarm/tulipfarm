// A fixture extension that owns a table in its own schema; 0002 depends on core's app.users.
export default {
  name: 'fixture-ledger',
  register(slots) {
    slots.migrations({
      schema: 'fixture_ledger',
      migrations: [
        { name: '0001_entries.sql', sql: 'CREATE TABLE entries (id uuid PRIMARY KEY, user_id uuid NOT NULL);' },
        { name: '0002_owner.sql', sql: 'ALTER TABLE entries ADD FOREIGN KEY (user_id) REFERENCES app.users(id);' },
      ],
    });
  },
};
