/**
 * A cron expression as English.
 *
 * `0 9 * * 1-5` is not a schedule most people can read, and a routine whose schedule is unreadable
 * is a routine nobody can check. So this translates — but only the shapes it can translate
 * exactly. Anything it does not fully understand returns `null` and the caller shows the raw
 * expression, because a confidently wrong schedule is worse than an untranslated one.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type Field =
  | { kind: "any" }
  | { kind: "step"; step: number }
  | { kind: "value"; value: number }
  | { kind: "list"; values: number[] };

/** Parses one field, normalising `7` to `0` for day-of-week so Sunday has a single spelling. */
function parseField(raw: string, min: number, max: number, sundayIsZero = false): Field | null {
  const normalise = (n: number) => (sundayIsZero && n === 7 ? 0 : n);
  const inRange = (n: number) => Number.isInteger(n) && n >= min && n <= max;

  if (raw === "*") return { kind: "any" };

  const step = /^\*\/(\d+)$/.exec(raw);
  if (step) {
    const value = Number(step[1]);
    return value > 1 && value <= max ? { kind: "step", step: value } : null;
  }

  const range = /^(\d+)-(\d+)$/.exec(raw);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (!inRange(from) || !inRange(to) || from > to) return null;
    const values: number[] = [];
    for (let n = from; n <= to; n += 1) values.push(normalise(n));
    return { kind: "list", values: [...new Set(values)].sort((a, b) => a - b) };
  }

  if (raw.includes(",")) {
    const parts = raw.split(",").map(Number);
    if (!parts.every(inRange)) return null;
    const values = [...new Set(parts.map(normalise))].sort((a, b) => a - b);
    return { kind: "list", values };
  }

  const value = Number(raw);
  return inRange(value) ? { kind: "value", value: normalise(value) } : null;
}

function clockTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The weekday clause, or `null` where the field says every day. */
function weekdayClause(dow: Field): string | null {
  if (dow.kind === "any") return null;
  if (dow.kind === "step") return null;
  if (dow.kind === "value") return `every ${DAY_NAMES[dow.value]}`;

  const days = dow.values;
  if (days.length === 7) return null;
  if (days.join() === "1,2,3,4,5") return "every weekday";
  if (days.join() === "0,6") return "every weekend day";
  return `every ${joinNames(days.map((day) => DAY_NAMES[day]))}`;
}

/**
 * @returns a sentence-case description, or `null` when the expression uses a shape this cannot
 * translate exactly — a stepped weekday, `L`/`W`/`#` operators, or both a day-of-month and a
 * day-of-week, which cron treats as OR and almost nobody reads that way.
 */
export function describeCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dayOfWeek = parseField(fields[4], 0, 7, true);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;

  // Cron ORs day-of-month against day-of-week when both are set. Rather than describe that
  // correctly and confusingly, refuse it.
  if (dayOfMonth.kind !== "any" && dayOfWeek.kind !== "any") return null;
  if (dayOfMonth.kind === "step" || dayOfMonth.kind === "list") return null;
  if (month.kind === "step" || month.kind === "list") return null;

  const weekday = weekdayClause(dayOfWeek);
  if (dayOfWeek.kind !== "any" && weekday === null && dayOfWeek.kind === "step") return null;

  const dayClause =
    weekday ??
    (dayOfMonth.kind === "value"
      ? month.kind === "value"
        ? `every ${MONTH_NAMES[month.value - 1]} ${ordinal(dayOfMonth.value)}`
        : `on the ${ordinal(dayOfMonth.value)} of every month`
      : month.kind === "value"
        ? `every day in ${MONTH_NAMES[month.value - 1]}`
        : "every day");

  // Sub-hourly schedules describe a frequency; anything else describes a clock time.
  if (hour.kind === "any") {
    if (minute.kind === "step") {
      return dayClause === "every day"
        ? `Every ${minute.step} minutes`
        : `Every ${minute.step} minutes, ${dayClause}`;
    }
    if (minute.kind === "any") {
      return dayClause === "every day" ? "Every minute" : `Every minute, ${dayClause}`;
    }
    if (minute.kind === "value") {
      const at = minute.value === 0 ? "on the hour" : `at ${ordinal(minute.value)} past the hour`;
      return dayClause === "every day" ? `Every hour, ${at}` : `Every hour ${dayClause}, ${at}`;
    }
    return null;
  }
  if (minute.kind !== "value") return null;

  if (hour.kind === "step") {
    const at = minute.value === 0 ? "on the hour" : `at ${ordinal(minute.value)} past`;
    return dayClause === "every day"
      ? `Every ${hour.step} hours, ${at}`
      : `Every ${hour.step} hours ${dayClause}, ${at}`;
  }

  const times =
    hour.kind === "value"
      ? clockTime(hour.value, minute.value)
      : joinNames(hour.values.map((h: number) => clockTime(h, minute.value)));

  const lead = dayClause.startsWith("every ")
    ? `Every ${dayClause.slice("every ".length)}`
    : dayClause.charAt(0).toUpperCase() + dayClause.slice(1);
  return `${lead} at ${times}`;
}
