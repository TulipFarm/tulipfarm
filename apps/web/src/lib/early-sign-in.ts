/** Removes the login page index.html painted before the app loaded and returns what was typed in it. */
export function takeEarlySignIn(): { email: string; focused: boolean } | null {
  const shell = document.getElementById('tf-sign-in');
  if (!shell) return null;
  const input = shell.querySelector('input');
  const early = { email: input?.value.trim() ?? '', focused: !!input && document.activeElement === input };
  shell.remove();
  return early;
}
