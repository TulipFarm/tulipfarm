import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export async function chooseOption(page, trigger, name) {
  await trigger.focus();
  await trigger.press('Enter');
  const option = page.getByRole('option', { name, exact: true });
  await option.waitFor();
  await option.press('Enter');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
}

export async function assertVisibleFocus(page) {
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    const style = getComputedStyle(element);
    return {
      visible: element.matches(':focus-visible'),
      painted: (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none',
    };
  });
  assert.deepEqual(focus, { visible: true, painted: true }, 'keyboard focus has a visible outline or ring');
}

export async function assertUncovered(action) {
  const evidence = await action.evaluate(button => {
    const box = button.getBoundingClientRect();
    const points = [
      [box.left + 8, box.top + 8],
      [box.right - 8, box.top + 8],
      [box.left + 8, box.bottom - 8],
      [box.right - 8, box.bottom - 8],
      [box.left + box.width / 2, box.top + box.height / 2],
    ];
    return {
      visible:
        Math.round(box.left) >= 0 &&
        Math.round(box.right) <= innerWidth &&
        Math.round(box.top) >= 0 &&
        Math.round(box.bottom) <= innerHeight,
      box: box.toJSON(),
      hits: points.map(([x, y]) => button.contains(document.elementFromPoint(x, y))),
    };
  });
  assert.equal(evidence.visible, true, `the entire action is inside the viewport: ${JSON.stringify(evidence.box)}`);
  assert.deepEqual(evidence.hits, [true, true, true, true, true], 'the entire action receives pointer input');
}

export const evidenceBrowserArgs = () =>
  process.env.BROWSER_CDP_PORT ? [`--remote-debugging-port=${process.env.BROWSER_CDP_PORT}`] : [];

export async function captureEvidence(page, path) {
  if (!process.env.BROWSER_CDP_PORT) return page.screenshot({ path });
  await page.bringToFront();
  const run = (...args) =>
    execFileSync('agent-browser', ['--session', 'audit-evidence', '--cdp', process.env.BROWSER_CDP_PORT, ...args], {
      encoding: 'utf8',
      timeout: 15000,
    });
  const result = JSON.parse(run('tab', 'list', '--json'));
  assert.equal(result.success, true);
  const targets = result.data.tabs.filter(tab => tab.url === page.url());
  assert.equal(targets.length, 1, 'capture targets exactly the tested page, including across browser contexts');
  run('tab', targets[0].tabId);
  run('screenshot', path);
  const image = await readFile(path);
  assert.deepEqual(
    { width: image.readUInt32BE(16), height: image.readUInt32BE(20) },
    page.viewportSize(),
    'captured PNG matches the tested viewport',
  );
}

/** A model picker row: its accessible name starts with the model's name, then any unavailable note and its cost meter. */
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The composer's model menu button, optionally for one chosen model; its name also says where the model runs. */
export function modelPicker(page, name) {
  return page.getByRole('button', { name: new RegExp(`^Model: ${name ? `${escapeRegExp(name)}(, on .+)?$` : ''}`) });
}

/** Wait until a chosen model's default has finished saving: the picker is disabled while it saves. */
export async function modelPickerSaved(page, name) {
  const handle = await modelPicker(page, name).elementHandle();
  await page.waitForFunction(button => !button.disabled, handle);
}

/** A model in the composer's model menu: a choice, or a submenu when several sources offer it. */
export function modelOption(page, name) {
  const label = new RegExp(`^${escapeRegExp(name)}(?=,| Unavailable|$)`);
  return page.getByRole('menuitemradio', { name: label }).or(page.getByRole('menuitem', { name: label }));
}

/** Open the chat list through the sidebar's Chats link, expanding the collapsed mobile sidebar first. */
export async function openChatList(page) {
  const link = page.getByRole('link', { name: 'Chats', exact: true }).first();
  if (!(await link.isVisible()))
    await page
      .getByRole('button', { name: /^toggle sidebar$/i })
      .first()
      .click();
  await link.click();
}

/**
 * Empty a rich-text editor the way a person does. `fill('')` selects the text in the DOM and presses Delete at once;
 * under load the key can arrive before ProseMirror reads that selection, so the draft survives the clear.
 */
export async function clearEditor(editor) {
  await editor.press('ControlOrMeta+a');
  await editor.press('Delete');
}
