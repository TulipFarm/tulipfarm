/** Workflow interceptors that keep each activity's attempt count but wait only 100 ms between attempts. */
export const interceptors = () => ({
  outbound: [
    {
      scheduleActivity: (input, next) =>
        next({
          ...input,
          options: {
            ...input.options,
            retry: {
              ...input.options.retry,
              initialInterval: '100 ms',
              backoffCoefficient: 1,
              maximumInterval: '100 ms',
            },
          },
        }),
    },
  ],
});
