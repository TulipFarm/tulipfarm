import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/github/package.json', import.meta.url));
const { qualifyGitHubCatalog } = await import(require.resolve('@tulipfarm/github/qualification'));
const { qualifyGitHubDeviceCatalog } = await import(require.resolve('@tulipfarm/github/device-qualification'));

export async function runQualification(
  args,
  {
    env = process.env,
    stdout = text => process.stdout.write(text),
    stderr = text => process.stderr.write(text),
    fetcher,
    wait,
    now,
  } = {},
) {
  try {
    if (args.length === 1 && args[0] === '--help') {
      stdout(
        'Usage: node tooling/github-qualification.mjs [--device --account-id <numeric-id>] --inspect --output <new-file>\n       node tooling/github-qualification.mjs [--device --account-id <numeric-id>] --review <review-file> --output <new-file>\nDevice mode reads GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_SCOPES, verifies the chosen account, and keeps its OAuth token in memory. Enable Device Flow on that OAuth App first. No client secret or callback change is needed.\nWithout --device, reads GITHUB_QUALIFICATION_TOKEN from the environment. Never calls tools or changes runtime configuration.\n',
      );
    } else {
      const device = args[0] === '--device';
      const accountId = device && args[1] === '--account-id' ? args[2] : undefined;
      if (device && !accountId) throw new Error();
      if (device) args = args.slice(3);
      const inspecting = args.length === 3 && args[0] === '--inspect' && args[1] === '--output';
      const reviewing = args.length === 4 && args[0] === '--review' && args[2] === '--output';
      if (!inspecting && !reviewing) throw new Error();
      const review = reviewing ? JSON.parse(await readFile(args[1], 'utf8')) : undefined;
      const artifact = device
        ? await qualifyGitHubDeviceCatalog({
            clientId: env.GITHUB_OAUTH_CLIENT_ID ?? '',
            scopes: env.GITHUB_OAUTH_SCOPES ?? '',
            accountId,
            review,
            fetcher,
            wait,
            now,
            showCode: ({ userCode, verificationUri }) =>
              stdout(
                `Open ${verificationUri} and enter ${userCode}. Authorize only the intended OAuth App and GitHub account.\n`,
              ),
          })
        : await qualifyGitHubCatalog({ token: env.GITHUB_QUALIFICATION_TOKEN ?? '', review, fetcher });
      await writeFile(args.at(-1), `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      stdout(
        inspecting
          ? 'Untrusted catalog saved. No bindings approved.\n'
          : 'Reviewed bindings verified and saved. Runtime configuration unchanged.\n',
      );
    }
    return 0;
  } catch {
    stderr(
      'GitHub qualification failed. No runtime configuration changed. Check input, credentials, catalog drift, and output path. For device mode, check Enable Device Flow, the chosen account ID, and browser consent; rerun for a fresh code if denied or expired.\n',
    );
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runQualification(process.argv.slice(2));
