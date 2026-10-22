import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('UI policies reject overrides and native controls while accepting variants and layout', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tulip-ui-lint-'));
  try {
    await mkdir(path.join(directory, 'apps/web/src'), { recursive: true });
    const config = JSON.parse(await readFile(path.join(root, '.oxlintrc.json'), 'utf8'));
    config.jsPlugins = [
      fileURLToPath(import.meta.resolve('@shadcn/lint')),
      path.join(root, 'tooling/design-system-lint.mjs'),
    ];
    await writeFile(path.join(directory, '.oxlintrc.json'), JSON.stringify(config));
    const cases = [
      [
        'valid',
        'import { Button } from "@/components/ui/button"; export const Demo = () => <div className="flex gap-2"><Button variant="outline" size="sm">Save</Button></div>;',
        [],
      ],
      [
        'class',
        'import { Button as Action } from "@/components/ui/button"; export const Demo = () => <Action className="p-4">Save</Action>;',
        ['no-component-overrides'],
      ],
      [
        'namespace',
        'import * as UI from "@/components/ui/button"; export const Demo = () => <UI.Button className="w-full">Save</UI.Button>;',
        ['no-component-overrides'],
      ],
      [
        'spread',
        'import { Button } from "@/components/ui/button"; const props = { className: "p-4" }; export const Demo = () => <Button {...props}>Save</Button>;',
        ['no-component-overrides'],
      ],
      [
        'container',
        'import { InputOTP } from "@/components/ui/input-otp"; export const Demo = () => <InputOTP containerClassName="p-4" />;',
        ['no-component-overrides'],
      ],
      ['native', 'export const Demo = () => <button>Save</button>;', ['shared-controls']],
      [
        'fake-control',
        'export const Demo = () => <div role="button" onClick={() => {}}>Save</div>;',
        ['shared-controls'],
      ],
      [
        'native-select',
        'import { NativeSelect } from "@/components/ui/native-select"; export const Demo = () => <NativeSelect aria-label="Team" />;',
        ['custom-select'],
      ],
      [
        'primitive',
        'import { Button } from "@base-ui/react/button"; export const Demo = () => <Button>Save</Button>;',
        ['shared-controls'],
      ],
      ['inline', 'export const Demo = () => <div style={{ color: "red" }}>Save</div>;', ['no-inline-styles']],
      ['raw-color', 'export const Demo = () => <div className="bg-red-500">Save</div>;', ['no-raw-colors']],
      ['arbitrary', 'export const Demo = () => <div className="p-[13px]">Save</div>;', ['no-arbitrary-values']],
      ['copy-text', 'export const Demo = () => <span>Preview</span>;', ['product-copy']],
      ['copy-label', 'export const Demo = () => <div aria-label="Workspace preview" />;', ['product-copy']],
      ['copy-string', 'export const message = "Open the PREVIEW";', ['product-copy']],
      ['copy-template', 'export const message = `Workspace previews`;', ['product-copy']],
      ['copy-unicode', 'export const message = "pre\\u0076iew";', ['product-copy']],
      ['copy-import', 'export { PreviewCard as HoverCard } from "@base-ui/react/preview-card";', []],
    ];
    for (const [name, source, rules] of cases) {
      const filename = path.join(directory, 'apps/web/src', `${name}.tsx`);
      await writeFile(filename, source);
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, 'node_modules/oxlint/bin/oxlint'),
          '--config',
          path.join(directory, '.oxlintrc.json'),
          filename,
        ],
        { cwd: directory, encoding: 'utf8' },
      );
      const output = result.stdout + result.stderr;
      if (rules.length === 0) assert.equal(result.status, 0, output);
      else {
        assert.equal(result.status, 1, `${name}: ${output}`);
        for (const rule of rules) assert(output.includes(rule), `${name}: expected ${rule}\n${output}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
