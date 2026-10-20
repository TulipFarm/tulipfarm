export function pickGreeting(fullName: string | undefined, firstSession: boolean | null) {
  if (firstSession === null) return 'What should we work on?';
  const firstName = fullName?.trim().split(/\s+/)[0];
  const name =
    firstName && [...firstName.replace(/[^\p{L}\p{N}]/gu, '')].length > 1 && !firstName.includes('@')
      ? firstName
      : null;
  return firstSession
    ? name
      ? `Welcome, ${name}`
      : 'Welcome to TulipFarm'
    : name
      ? `Welcome back, ${name}`
      : 'Welcome back';
}
