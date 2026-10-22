import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const appCss = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const presetUrl = import.meta.resolve('@tulipfarm/sprout/themes/tulipfarm.css');
export const preset = readFileSync(new URL(presetUrl), 'utf8');
const stylesDir = fileURLToPath(new URL('..', presetUrl));
const sproutCss = readdirSync(stylesDir)
  .filter(file => file.endsWith('.css'))
  .map(file => readFileSync(`${stylesDir}/${file}`, 'utf8'))
  .join('\n');

const declarations = (block: string) =>
  Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));

const blockAfter = (css: string, selector: string) => {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing ${selector}`);
  const open = css.indexOf('{', start);
  return declarations(css.slice(open + 1, css.indexOf('}', open)));
};

export const appTokens = blockAfter(appCss, ':root {\n  color-scheme: light dark;');
const modes = [
  blockAfter(preset, ".light [data-sprout-theme='tulipfarm']"),
  blockAfter(preset, ".dark [data-sprout-theme='tulipfarm']"),
];

export const sproutDefines = (token: string) => token in modes[0] || new RegExp(`${token}:`).test(sproutCss);

/** An app token's [light, dark] values, read through Sprout's tulipfarm theme. */
export const themeColor = (name: string): [string, string] => {
  const value = appTokens[`--${name}`];
  const sprout = value?.match(/^var\((--sprout-[\w-]+)\)$/)?.[1];
  if (!sprout) throw new Error(`--${name} does not read a Sprout token`);
  const [light, dark] = modes.map(mode => mode[sprout]);
  if (!light || !dark) throw new Error(`Sprout's tulipfarm theme does not set ${sprout} in both modes`);
  return [light, dark];
};
