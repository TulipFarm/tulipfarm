const fetcher = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const target = new URL(String(url));
  if (target.hostname === 'api.github.com' || target.hostname === 'api.anthropic.com')
    return fetcher(`${process.env.TEST_PROVIDER_ORIGIN}/${target.hostname}${target.pathname}${target.search}`, init);
  throw new Error('Unexpected test network destination');
};
await import('../dist/worker.js');
process.send?.('ready');
