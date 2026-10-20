const link = /\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
const timeFormatter = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const dayFormatter = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
const yearFormatter = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' });
const titleFormatter = new Intl.DateTimeFormat([], { dateStyle: 'full', timeStyle: 'medium' });

function formatDate(formatter: Intl.DateTimeFormat, date: Date) {
  return Number.isNaN(date.getTime()) ? date.toString() : formatter.format(date);
}

export function messageTimeTitle(iso: string) {
  return formatDate(titleFormatter, new Date(iso));
}

export function plainTextFromMarkdown(markdown: string) {
  return markdown
    .replace(link, (_, label: string, url: string) => (!label || label === url ? url : `${label} (${url})`))
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
}

export function messageTime(iso: string, now = new Date()) {
  const date = new Date(iso);
  const time = formatDate(timeFormatter, date);
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  const day = formatDate(date.getFullYear() === now.getFullYear() ? dayFormatter : yearFormatter, date);
  return `${day}, ${time}`;
}
