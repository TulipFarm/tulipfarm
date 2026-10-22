export default {
  name: 'fixture-register-fails',
  register(slots) {
    slots.analytics({ capture: () => undefined });
    throw new Error('missing POSTHOG_KEY');
  },
};
