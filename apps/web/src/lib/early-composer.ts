/** Removes the composer index.html painted before the app loaded and returns what was typed in it. */
export function takeEarlyComposer(): { text: string; send: boolean } | null {
  const shell = document.getElementById('tf-early');
  if (!shell) return null;
  const text = shell.querySelector('textarea')?.value.trim() ?? '';
  shell.remove();
  return text ? { text, send: shell.dataset.send === 'true' } : null;
}
