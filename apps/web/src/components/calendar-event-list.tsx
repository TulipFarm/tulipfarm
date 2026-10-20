import { useEffect, useState } from 'react';
import type { CalendarEvent } from '@tulipfarm/google-workspace/calendar-events';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { buttonVariants } from '@tulipfarm/sprout/button';
import { Badge } from '@tulipfarm/sprout/badge';

export function eventDate(event: CalendarEvent, timeZone: string, now?: number) {
  if (event.time.kind === 'all-day') {
    const date = (value: string) =>
      new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    const last = new Date(Date.parse(`${event.time.endsBefore}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    return `${date(event.time.startsOn)}${last !== event.time.startsOn ? ` – ${date(last)}` : ''} · All day`;
  }
  const start = new Date(event.time.startsAt);
  const end = new Date(event.time.endsAt);
  const date = (value: Date) =>
    value.toLocaleDateString(undefined, { timeZone, month: 'short', day: 'numeric', year: 'numeric' });
  const clock = (value: Date) => value.toLocaleTimeString(undefined, { timeZone, hour: 'numeric', minute: '2-digit' });
  const sameDay = date(start) === date(end);
  if (now !== undefined && sameDay && date(start) === date(new Date(now))) return `${clock(start)} – ${clock(end)}`;
  return `${date(start)} · ${clock(start)} – ${sameDay ? '' : `${date(end)} · `}${clock(end)} · ${timeZone}`;
}

export function CalendarEventDetails({
  title,
  date,
  attendees,
  location,
}: {
  title: string;
  date?: string | undefined;
  attendees?: CalendarEvent['attendees'];
  location?: string | undefined;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-2">
      <p className="text-sm font-medium break-words text-foreground">{title}</p>
      {date && <p className="text-xs text-muted-foreground">{date}</p>}
      {location && <p className="text-sm whitespace-pre-wrap break-words">{location}</p>}
      {attendees && (
        <ul aria-label="Attendees" className="flex min-w-0 flex-wrap gap-2">
          {attendees.map((attendee, index) => (
            <li key={`${attendee.email}:${index}`} className="min-w-0 max-w-full break-all">
              <Badge variant="outline" size="chip">
                {attendee.displayName ? `${attendee.displayName} · ` : ''}
                {attendee.email}
                {attendee.responseStatus ? ` · ${attendee.responseStatus}` : ''}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CalendarEventList({
  events,
  timeZone,
  compact = false,
}: {
  events: readonly CalendarEvent[];
  timeZone: string;
  compact?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const boundaries = events
      .flatMap(event =>
        event.time.kind === 'timed' ? [Date.parse(event.time.startsAt), Date.parse(event.time.endsAt)] : [],
      )
      .filter(time => time > now);
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(1, Math.min(60_000, ...boundaries.map(time => time - Date.now()))),
    );
    const visible = () => setNow(Date.now());
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [events, now]);
  if (!events.length) return <p className="text-sm text-muted-foreground">No events found.</p>;
  return (
    <ul
      aria-label="Calendar events"
      className="divide-y divide-border overflow-hidden rounded-xl border border-input bg-card"
    >
      {events.map(event => {
        const start = event.time.kind === 'timed' ? Date.parse(event.time.startsAt) : null;
        const ongoing =
          start !== null && start <= now && event.time.kind === 'timed' && Date.parse(event.time.endsAt) > now;
        const minutes = start !== null && start > now ? Math.ceil((start - now) / 60_000) : null;
        return (
          <li
            key={`${event.calendarId}:${event.eventId}`}
            className="flex min-w-0 items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4"
          >
            <span
              aria-hidden="true"
              className={
                ongoing
                  ? 'w-0.5 shrink-0 self-stretch rounded-full bg-primary-text'
                  : 'w-0.5 shrink-0 self-stretch rounded-full bg-input'
              }
            />
            <div className="min-w-0 flex-1 space-y-1">
              <CalendarEventDetails
                title={event.title ?? 'Untitled event'}
                date={compact ? eventDate(event, timeZone, now) : eventDate(event, event.timeZone ?? timeZone)}
                attendees={compact ? undefined : event.attendees}
                location={event.location}
              />
              {ongoing && <p className="text-xs text-primary-text">Happening now</p>}
              {!event.joinUrl && event.conferenceStatus === 'pending' && (
                <p className="text-xs text-muted-foreground">
                  Google Meet is still being created. Read the event again to check.
                </p>
              )}
              {!event.joinUrl && event.conferenceStatus === 'failure' && (
                <p className="text-xs text-destructive">
                  Google could not create the Meet link. The event still exists.
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {event.joinUrl ? (
                <a
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  href={event.joinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                  aria-label={`Join ${event.title ?? 'event'}`}
                >
                  <BrandIcon brand="google-calendar" size="inline" />
                  Join
                </a>
              ) : minutes !== null ? (
                <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {minutes < 60
                    ? `In ${minutes} min`
                    : `In ${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`}
                </span>
              ) : event.eventUrl ? (
                <a
                  className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                  href={event.eventUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                  aria-label={`Open ${event.title ?? 'event'} in Google Calendar`}
                >
                  <BrandIcon brand="google-calendar" size="inline" />
                  Open
                </a>
              ) : (
                <BrandIcon brand="google-calendar" size="inline" />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
