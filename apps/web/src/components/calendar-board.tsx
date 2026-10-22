import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { CalendarDays, CheckSquare, ChevronDown, Clock3, Cpu, GitBranch } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  calendarDays,
  calendarHourLabels,
  compactItemTime,
  dayKey,
  itemIsPast,
  itemOnDay,
  itemStart,
  itemTime,
  kindLabels,
  layoutDayGroups,
  localDate,
  type CalendarItem,
  type CalendarKind,
  type CalendarView,
} from '@/features/calendar/model';
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from '@tulipfarm/sprout/popover';
import './calendar-board.css';

const minuteHeight = 1.2;
export function CalendarKindIcon({ kind, marked = false }: { kind: CalendarKind; marked?: boolean }) {
  const Icon = { meeting: CalendarDays, task: CheckSquare, agent: Cpu, workflow: GitBranch }[kind];
  return marked ? (
    <span className="calendar-kind-mark" data-kind={kind}>
      <Icon size={14} aria-hidden="true" />
    </span>
  ) : (
    <Icon size={14} aria-hidden="true" />
  );
}
export function CalendarEntry({
  item,
  zone,
  compact = false,
  onSelect,
}: {
  item: CalendarItem;
  zone: string;
  compact?: boolean;
  onSelect: (id: string) => void;
}) {
  const point = item.time.kind === 'point';
  const description = `${item.title}, ${itemTime(item, zone)}, ${kindLabels[item.kind]}, ${item.source}, ${item.status}${point ? ', does not block time' : ''}`;
  return (
    <button
      type="button"
      className="calendar-entry"
      data-kind={item.kind}
      data-compact={compact}
      data-time-kind={item.time.kind}
      onClick={() => onSelect(item.id)}
      aria-label={description}
      title={description}
    >
      {point && <time className="calendar-run-time">{compactItemTime(item, zone)}</time>}
      <span className="calendar-entry-heading">
        <CalendarKindIcon kind={item.kind} />
        <span className="calendar-entry-title">{item.title}</span>
      </span>
      {!point && (
        <span className="calendar-entry-meta">
          {item.time.kind !== 'all-day' && (
            <span className="calendar-entry-time" aria-hidden="true">
              <span className="calendar-entry-range">{compactItemTime(item, zone)}</span>
              <span className="calendar-entry-start">{compactItemTime(item, zone, true)}</span>
            </span>
          )}
          <span className="calendar-entry-source" title={item.source}>
            {item.source}
          </span>
        </span>
      )}
    </button>
  );
}
function OverlapGroup({
  rows,
  day,
  zone,
  onSelect,
}: {
  rows: ReturnType<typeof layoutDayGroups>[number];
  day: string;
  zone: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const top = rows[0]!.top,
    bottom = Math.max(...rows.map(row => row.bottom)),
    height = (bottom - top) * minuteHeight;
  const shown = Math.min(rows.length, Math.max(0, Math.floor((height - 24) / 22)));
  const select = (id: string) => {
    setOpen(false);
    onSelect(id);
  };
  return (
    <div className="calendar-overlap-group" style={{ top: top * minuteHeight, height }}>
      <div className="calendar-overlap-lanes">
        {rows.map(row => (
          <div
            key={row.item.id}
            className="calendar-event-position"
            data-overlap="true"
            data-short={row.bottom - row.top < 45}
            style={{
              top: (row.top - top) * minuteHeight,
              height: (row.bottom - row.top) * minuteHeight,
              left: `${(row.column / row.columns) * 100}%`,
              width: `${100 / row.columns}%`,
            }}
          >
            <CalendarEntry item={row.item} zone={zone} compact={row.bottom - row.top < 45} onSelect={select} />
          </div>
        ))}
      </div>
      <section
        className="calendar-overlap-summary"
        data-kind={rows.every(row => row.item.kind === rows[0]!.item.kind) ? rows[0]!.item.kind : undefined}
        aria-label={`${rows.length} events at this time`}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger className="calendar-overlap-trigger" aria-label={`View all ${rows.length} events on ${day}`}>
            <span className="calendar-overlap-count">
              {rows.length} events
              <ChevronDown size={12} aria-hidden="true" />
            </span>
            <span className="calendar-overlap-touch-titles">
              {rows.slice(0, 2).map(row => (
                <span key={row.item.id}>
                  {compactItemTime(row.item, zone, true)} · {row.item.title}
                </span>
              ))}
            </span>
          </PopoverTrigger>
          <PopoverContent size="work-list" align="start">
            <header className="shrink-0 border-b p-3">
              <PopoverTitle>Events at this time</PopoverTitle>
              <PopoverDescription>
                {localDate(day, '12:00', zone).toLocaleDateString('en', { dateStyle: 'full' })}
              </PopoverDescription>
            </header>
            <div className="calendar-overlap-details">
              {rows.map(row => (
                <CalendarEntry key={row.item.id} item={row.item} zone={zone} onSelect={select} />
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <div className="calendar-overlap-items">
          {rows.slice(0, shown).map(row => (
            <CalendarEntry key={row.item.id} item={row.item} zone={zone} compact onSelect={select} />
          ))}
        </div>
      </section>
    </div>
  );
}
function DayHeading({
  day,
  zone,
  today,
  agenda = false,
  focused,
  onDay,
}: {
  day: string;
  zone: string;
  today: string;
  agenda?: boolean;
  focused?: boolean;
  onDay: (day: string) => void;
}) {
  const value = localDate(day, '12:00', zone);
  return (
    <button
      type="button"
      className="calendar-day-heading"
      data-today={day === today}
      data-focused={focused}
      aria-pressed={focused}
      data-weekend={value.getDay() === 0 || value.getDay() === 6}
      onClick={() => onDay(day)}
      aria-label={`Open ${value.toLocaleDateString('en', { dateStyle: 'full' })}`}
    >
      <span>{value.toLocaleDateString('en', { weekday: 'short' })}</span>
      <strong>{value.getDate()}</strong>
      {agenda && <span>{value.toLocaleDateString('en', { month: 'short' })}</span>}
    </button>
  );
}
function AgendaRows({
  items,
  zone,
  now,
  onSelect,
}: {
  items: CalendarItem[];
  zone: string;
  now: Date;
  onSelect: (id: string) => void;
}) {
  return items.map(item => (
    <div className="calendar-agenda-row" data-past={itemIsPast(item, now, zone)} key={item.id}>
      <time>{itemTime(item, zone)}</time>
      <div className="calendar-agenda-event">
        <CalendarEntry item={item} zone={zone} onSelect={onSelect} />
        <span className="calendar-agenda-source">{item.source}</span>
      </div>
    </div>
  ));
}
export function CalendarBoard({
  items,
  day,
  view,
  zone,
  secondZone,
  now,
  focusAt,
  onSelect,
  onDay,
  onFocusDay,
  onAgenda,
  onCreate,
}: {
  items: CalendarItem[];
  day: string;
  view: CalendarView;
  zone: string;
  secondZone: string | null;
  now: Date;
  focusAt: number | null;
  onSelect: (id: string) => void;
  onDay: (day: string) => void;
  onFocusDay: (day: string) => void;
  onAgenda: (day: string) => void;
  onCreate: (day: string, time: string) => void;
}) {
  const mobile = useIsMobile(),
    [compactWeek, setCompactWeek] = useState(false),
    week = calendarDays(day, view, zone);
  const focusedWeek = (mobile || compactWeek) && view === 'week',
    days = focusedWeek ? [day] : week;
  const today = dayKey(now, zone),
    scroll = useRef<HTMLDivElement>(null);
  const comparisonZone = secondZone && secondZone !== zone ? secondZone : null;
  const zoneLabel = (value: string) => value.split('/').at(-1)!.replaceAll('_', ' ');
  const gridStyle: CSSProperties & { '--calendar-days': number } = { '--calendar-days': days.length };
  const monthStyle: CSSProperties & { '--calendar-month-weeks': number } = {
    '--calendar-month-weeks': days.length / 7,
  };
  useEffect(() => {
    if (!scroll.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCompactWeek(entry.contentRect.width < 1120 + (comparisonZone ? 120 : 80));
    });
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, [view, comparisonZone]);
  useEffect(() => {
    if ((view !== 'day' && view !== 'week') || !scroll.current) return;
    const clock =
      focusAt === null
        ? null
        : new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
            .format(focusAt)
            .split(':')
            .map(Number);
    scroll.current.scrollTop = (clock ? Math.max(0, clock[0]! * 60 + clock[1]! - 60) : 7 * 60) * minuteHeight;
  }, [view, focusAt, zone]);
  if (view === 'month')
    return (
      <div className="calendar-month" role="region" aria-label="Month calendar">
        <div className="calendar-month-weekdays" aria-hidden="true">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(name => (
            <span key={name}>{name}</span>
          ))}
        </div>
        <div className="calendar-month-grid" style={monthStyle}>
          {days.map(value => {
            const scheduled = items
              .filter(item => itemOnDay(item, value, zone))
              .sort((a, b) => itemStart(a).localeCompare(itemStart(b)));
            const events = scheduled.filter(item => item.time.kind !== 'point'),
              runs = scheduled.length - events.length;
            const weekday = localDate(value, '12:00', zone).getDay();
            return (
              <section
                key={value}
                className="calendar-month-day"
                data-outside={value.slice(0, 7) !== day.slice(0, 7)}
                data-weekend={weekday === 0 || weekday === 6}
                aria-label={value}
              >
                <button
                  type="button"
                  className="calendar-date-number"
                  data-today={value === today}
                  onClick={() => onDay(value)}
                  aria-label={`Open ${value}`}
                >
                  {Number(value.slice(-2))}
                </button>
                <div className="calendar-month-events">
                  {events.slice(0, 2).map(item => (
                    <CalendarEntry key={item.id} item={item} zone={zone} compact onSelect={onSelect} />
                  ))}
                  <div className="calendar-month-overflow">
                    {events.length > 2 && (
                      <button type="button" className="calendar-more" onClick={() => onDay(value)}>
                        +{events.length - 2} more
                      </button>
                    )}
                    {runs > 0 && (
                      <button
                        type="button"
                        className="calendar-more calendar-month-runs"
                        aria-label={`View all ${runs} runs on ${value}`}
                        onClick={() => onAgenda(value)}
                      >
                        <Clock3 size={11} aria-hidden="true" />
                        {runs} {runs === 1 ? 'run' : 'runs'}
                      </button>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="calendar-mobile-day"
                  data-today={value === today}
                  data-focused={value === day}
                  aria-pressed={value === day}
                  aria-label={`Show ${value}, ${events.length} events, ${runs} runs`}
                  onClick={() => onFocusDay(value)}
                >
                  <strong>{Number(value.slice(-2))}</strong>
                  <span>
                    {events.length > 0 && (
                      <span>
                        <CalendarDays size={10} aria-hidden="true" />
                        {events.length}
                      </span>
                    )}
                    {runs > 0 && (
                      <span>
                        <Clock3 size={10} aria-hidden="true" />
                        {runs}
                      </span>
                    )}
                  </span>
                </button>
              </section>
            );
          })}
        </div>
        <section className="calendar-month-selected" aria-label="Selected day">
          <header>
            <h3>
              {localDate(day, '12:00', zone).toLocaleDateString('en', {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
              })}
            </h3>
            <button type="button" className="calendar-more" onClick={() => onDay(day)}>
              Open day
            </button>
          </header>
          <AgendaRows
            items={items
              .filter(item => itemOnDay(item, day, zone))
              .sort((a, b) => itemStart(a).localeCompare(itemStart(b)))}
            zone={zone}
            now={now}
            onSelect={onSelect}
          />
          {!items.some(item => itemOnDay(item, day, zone)) && (
            <p className="calendar-quiet-message">Nothing scheduled on this day.</p>
          )}
        </section>
      </div>
    );
  if (view === 'agenda')
    return (
      <div className="calendar-agenda" role="region" aria-label="Agenda">
        {days.map(value => {
          const events = items
            .filter(item => itemOnDay(item, value, zone))
            .sort((a, b) => itemStart(a).localeCompare(itemStart(b)));
          if (!events.length) return null;
          return (
            <section className="calendar-agenda-day" key={value}>
              <DayHeading day={value} today={today} zone={zone} agenda onDay={onDay} />
              <div className="calendar-agenda-items">
                {value === today ? (
                  <>
                    <AgendaRows
                      items={events.filter(item => itemIsPast(item, now, zone))}
                      zone={zone}
                      now={now}
                      onSelect={onSelect}
                    />
                    <div className="calendar-agenda-now">
                      Now · {now.toLocaleTimeString('en', { timeZone: zone, hour: 'numeric', minute: '2-digit' })}
                    </div>
                    <AgendaRows
                      items={events.filter(item => !itemIsPast(item, now, zone))}
                      zone={zone}
                      now={now}
                      onSelect={onSelect}
                    />
                  </>
                ) : (
                  <AgendaRows items={events} zone={zone} now={now} onSelect={onSelect} />
                )}
              </div>
            </section>
          );
        })}
        {!items.length && <p className="calendar-quiet-message">Nothing scheduled in this range.</p>}
      </div>
    );
  return (
    <div
      className="calendar-time-scroll"
      ref={scroll}
      tabIndex={0}
      role="region"
      aria-label={`${view === 'week' ? 'Week' : 'Day'} calendar, scroll to other hours`}
    >
      <div
        className="calendar-time-content"
        data-week={view === 'week' && !focusedWeek}
        data-two-zones={!!comparisonZone}
        data-focused-week={focusedWeek}
        style={gridStyle}
      >
        <div className="calendar-time-top">
          {focusedWeek && (
            <nav className="calendar-week-picker" aria-label="Days in this week">
              {week.map(value => (
                <DayHeading
                  key={value}
                  day={value}
                  today={today}
                  zone={zone}
                  focused={value === day}
                  onDay={onFocusDay}
                />
              ))}
            </nav>
          )}
          <div className="calendar-time-header">
            <div className="calendar-axis-title">
              <span title={zone}>{zoneLabel(zone)}</span>
              {comparisonZone && <span title={comparisonZone}>{zoneLabel(comparisonZone)}</span>}
            </div>
            {days.map(value => (
              <DayHeading key={value} day={value} today={today} zone={zone} onDay={onDay} />
            ))}
          </div>
          {items.some(item => item.time.kind === 'point') && (
            <div className="calendar-runs" role="region" aria-label="Scheduled runs, do not block time">
              <div className="calendar-runs-label" title="Scheduled automation starts. These do not reserve your time.">
                Runs<span>Time stays free</span>
              </div>
              {days.map(value => {
                const runs = items
                  .filter(item => item.time.kind === 'point' && itemOnDay(item, value, zone))
                  .sort((a, b) => itemStart(a).localeCompare(itemStart(b)));
                return (
                  <div className="calendar-runs-day" key={value}>
                    <div className="calendar-runs-expanded">
                      {runs.slice(0, 2).map(item => (
                        <CalendarEntry key={item.id} item={item} zone={zone} compact onSelect={onSelect} />
                      ))}
                      {runs.length > 2 && (
                        <button
                          type="button"
                          className="calendar-more"
                          aria-label={`View all ${runs.length} runs on ${value}`}
                          onClick={() => onAgenda(value)}
                        >
                          +{runs.length - 2} more
                        </button>
                      )}
                    </div>
                    {runs.length > 0 && (
                      <button
                        type="button"
                        className="calendar-runs-compact"
                        aria-label={`View all ${runs.length} runs on ${value}`}
                        onClick={() => onAgenda(value)}
                      >
                        <Clock3 size={12} aria-hidden="true" />
                        {runs.length} {runs.length === 1 ? 'run' : 'runs'}
                        <ChevronDown size={12} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {items.some(item => item.time.kind === 'all-day') && (
            <div className="calendar-all-day">
              <span>All day</span>
              {days.map(value => (
                <div key={value}>
                  {items
                    .filter(item => item.time.kind === 'all-day' && itemOnDay(item, value, zone))
                    .map(item => (
                      <CalendarEntry item={item} zone={zone} compact key={item.id} onSelect={onSelect} />
                    ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="calendar-time-body">
          <div className="calendar-hours" aria-hidden="true">
            {calendarHourLabels(day, zone, comparisonZone).map((labels, hour) => (
              <div key={hour}>
                <span>{labels.primary}</span>
                {labels.secondary && <span>{labels.secondary}</span>}
              </div>
            ))}
          </div>
          {days.map(value => (
            <div
              key={value}
              className="calendar-time-day"
              data-today={value === today}
              data-weekend={[0, 6].includes(localDate(value, '12:00', zone).getDay())}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <button
                  type="button"
                  key={hour}
                  className="calendar-time-slot"
                  aria-label={`Create event ${value} ${String(hour).padStart(2, '0')}:00`}
                  onClick={() => onCreate(value, `${String(hour).padStart(2, '0')}:00`)}
                />
              ))}
              {layoutDayGroups(items, value, zone).map(rows => {
                const row = rows[0]!;
                return rows.length > 1 ? (
                  <OverlapGroup key={row.item.id} rows={rows} day={value} zone={zone} onSelect={onSelect} />
                ) : (
                  <div
                    key={row.item.id}
                    className="calendar-event-position"
                    data-short={row.bottom - row.top < 45}
                    style={{
                      top: row.top * minuteHeight,
                      height: (row.bottom - row.top) * minuteHeight,
                      left: 0,
                      width: '100%',
                    }}
                  >
                    <CalendarEntry
                      item={row.item}
                      zone={zone}
                      compact={row.bottom - row.top < 45}
                      onSelect={onSelect}
                    />
                  </div>
                );
              })}
              {value === today && (
                <div
                  className="calendar-now"
                  style={{
                    top:
                      (Number(
                        new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(
                          now,
                        ),
                      ) *
                        60 +
                        Number(new Intl.DateTimeFormat('en', { timeZone: zone, minute: '2-digit' }).format(now))) *
                      minuteHeight,
                  }}
                >
                  <span />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
