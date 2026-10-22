/** Records every storage transaction a reply runs, with its duration and the credit ledger statements it issued. */
export function meteredRuntime(runtime) {
  const transactions = [];
  let active = 0;
  return {
    transactions,
    reset() {
      transactions.length = 0;
    },
    get active() {
      return active;
    },
    runtime: {
      ...runtime,
      transaction(workspaceId, range, operation) {
        const record = { ms: 0, statements: [], credits: false, open: true };
        transactions.push(record);
        const started = performance.now();
        active++;
        return runtime
          .transaction(workspaceId, range, async tx => {
            const query = tx.client.query;
            tx.client.query = function (text, ...rest) {
              const sql = typeof text === 'string' ? text : (text?.text ?? '');
              record.statements.push(sql);
              if (/tf_credit_usage|tf_credit_account/.test(sql)) record.credits = true;
              return query.call(this, text, ...rest);
            };
            try {
              return await operation(tx);
            } finally {
              tx.client.query = query;
            }
          })
          .finally(() => {
            active--;
            record.open = false;
            record.ms = performance.now() - started;
          });
      },
    },
  };
}
