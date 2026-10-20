export default {
  name: 'fixture-second-gate',
  register(slots) {
    slots.creditGate({ available: async () => null, debit: async () => undefined });
  },
};
