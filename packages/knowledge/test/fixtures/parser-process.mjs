const { filename } = JSON.parse(process.argv[2]);
process.stdin.resume();
switch (filename) {
  case 'crash':
    process.kill(process.pid, 'SIGSEGV');
    break;
  case 'exit':
    process.exit(7);
    break;
  case 'content-limit':
    process.stdout.write('{"kind":"failed","failure":"resource-limited"}');
    break;
  case 'hang':
    while (process.pid) Math.sqrt(37);
    break;
  case 'memory': {
    const allocations = [];
    setInterval(() => allocations.push(Buffer.alloc(16 * 1024 * 1024, 42)), 10);
    break;
  }
  case 'output': {
    const chunk = Buffer.alloc(1024 * 1024, 97);
    for (let index = 0; index < 40; index += 1) process.stdout.write(chunk);
    break;
  }
  case 'stderr':
    process.stderr.write('x'.repeat(20_000));
    setInterval(() => {}, 1000);
    break;
  case 'invalid':
    process.stdout.write('{"kind":"ready","result":{}}');
    break;
  case 'credentials': {
    const unexpected = Object.keys(process.env).filter(
      key =>
        ![
          'PATH',
          'LANG',
          'TZ',
          'UV_THREADPOOL_SIZE',
          'NAPI_RS_ENFORCE_VERSION_CHECK',
          'PWD',
          'SHLVL',
          '__CF_USER_TEXT_ENCODING',
        ].includes(key),
    );
    process.stdout.write(JSON.stringify({ kind: 'failed', failure: unexpected.length ? 'malformed' : 'unsupported' }));
    break;
  }
  case 'pid':
    process.stdout.write(String(process.pid));
    setInterval(() => {}, 1000);
    break;
}
