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

/** A title template; `{name}` is replaced with the first name, and `plain` is used when there is none. */
type Title = { named: string; plain: string };

const t = (named: string, plain: string): Title => ({ named, plain });

const anytime: Title[] = [t('Hey {name}', 'Hey there'), t('Hi {name}, good to see you', 'Good to see you')];

const titles = {
  earlyMorning: [t('Up early, {name}', 'Up early'), t('Early start, {name}?', 'Early start?')],
  morning: [
    t('Good morning, {name}', 'Good morning'),
    t('Morning, {name}', 'Morning'),
    t('Rise and shine, {name}', 'Rise and shine'),
    t('Coffee and plans, {name}?', 'Coffee and plans?'),
  ],
  afternoon: [
    t('Good afternoon, {name}', 'Good afternoon'),
    t('Afternoon, {name}', 'Afternoon'),
    t('Back at it, {name}?', 'Back at it?'),
    t('How is the day going, {name}?', 'How is the day going?'),
  ],
  evening: [
    t('Good evening, {name}', 'Good evening'),
    t('Evening, {name}', 'Evening'),
    t('Still going, {name}?', 'Still going?'),
    t('Winding down, {name}?', 'Winding down?'),
  ],
  night: [
    t('Working late, {name}?', 'Working late?'),
    t('Hello, night owl {name}', 'Hello, night owl'),
    t('Burning the midnight oil, {name}?', 'Burning the midnight oil?'),
    t('Quiet hours, {name}', 'Quiet hours'),
  ],
  monday: [t('Fresh week, {name}', 'Fresh week'), t('Happy Monday, {name}', 'Happy Monday')],
  friday: [t('Happy Friday, {name}', 'Happy Friday'), t('Almost the weekend, {name}', 'Almost the weekend')],
  weekend: [t('Happy {day}, {name}', 'Happy {day}'), t('Weekend mode, {name}?', 'Weekend mode?')],
  first: [t('Welcome, {name}', 'Welcome to TulipFarm'), t("Glad you're here, {name}", "Glad you're here")],
} as const;

const subtitles = {
  morning: ["What's first on today's list?", "Let's line up the day.", 'Where should we start?'],
  afternoon: ['What can I take off your plate?', 'What should we move forward?', "What's next?"],
  evening: ['Anything to wrap up before tomorrow?', "Let's close a few loops.", 'What still needs doing?'],
  night: ['Something quick, or a deep dive?', "What's on your mind?", "Let's make it count."],
  anytime: ['What should we work on?', 'What can I help with?', "What's on your list?"],
  first: ['How can I help you today?', 'What would you like to try first?'],
} as const;

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function momentOf(hour: number) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** The greeting title split around the name, so the name can be styled on its own. */
export type HomeGreeting = { before: string; name: string | null; after: string; subtitle: string };

/** A greeting for the new-chat home that follows the time and day, picked at random from a pool. */
export function pickHomeGreeting(
  fullName: string | undefined,
  firstSession: boolean | null,
  now: Date,
  random: () => number = Math.random,
): HomeGreeting {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length) % items.length]!;
  // Until the visit is known, a neutral line avoids flipping from "welcome back" to "welcome".
  if (firstSession === null) return { before: pickGreeting(fullName, null), name: null, after: '', subtitle: '' };
  const returning = pickGreeting(fullName, false);
  const name = returning.startsWith('Welcome back, ') ? returning.slice('Welcome back, '.length) : null;
  const hour = now.getHours();
  const day = now.getDay();
  const moment = momentOf(hour);
  let pool: readonly Title[];
  let subtitle: string;
  if (firstSession === true) {
    pool = titles.first;
    subtitle = pick(subtitles.first);
  } else {
    pool = [
      ...titles[moment],
      ...anytime,
      ...(hour >= 5 && hour < 8 ? titles.earlyMorning : []),
      ...(day === 1 && moment === 'morning' ? titles.monday : []),
      ...(day === 5 && moment !== 'night' && hour >= 12 ? titles.friday : []),
      ...((day === 0 || day === 6) && moment !== 'night' ? titles.weekend : []),
    ];
    subtitle = pick([...subtitles[moment], ...subtitles.anytime]);
  }
  const title = pick(pool);
  const template = (name ? title.named : title.plain).replace('{day}', weekdays[day]!);
  const [before, after = ''] = template.split('{name}');
  return { before: before!, name: name && template.includes('{name}') ? name : null, after, subtitle };
}
