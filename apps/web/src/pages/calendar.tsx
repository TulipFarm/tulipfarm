import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Command,
  ExternalLink,
  Inbox,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { format } from 'date-fns';
import { workspaceCalendarRoute, workspaceRoute } from '@/router';
import { Button } from '@tulipfarm/sprout/button';
import { Badge } from '@tulipfarm/sprout/badge';
import { Status } from '@tulipfarm/sprout/status';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@tulipfarm/sprout/accordion';
import { Card, CardFooter, CardHeader } from '@tulipfarm/sprout/card';
import { Calendar } from '@tulipfarm/sprout/calendar';
import { CalendarBoard, CalendarKindIcon } from '@/components/calendar-board';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { CheckboxField, Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Alert } from '@tulipfarm/sprout/alert';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@tulipfarm/sprout/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tulipfarm/sprout/sheet';
import {
  SearchDialog,
  SearchInput,
  SearchList,
  SearchGroup,
  SearchItem,
  SearchEmpty,
  SearchFooter,
  SearchHint,
} from '@tulipfarm/sprout/search-dialog';
import { useFeatureChanges, type useFeatureRead } from '@/lib/query';
import { calendarApi, type ProviderCalendar } from '@/features/calendar/api';
import {
  calendarKinds,
  calendarNowNext,
  calendarRange,
  calendarViews,
  clockTime,
  compactItemTime,
  dayKey,
  freeSlots,
  itemStart,
  itemTime,
  kindLabels,
  localDate,
  moveDate,
  type CalendarKind,
  type CalendarView,
} from '@/features/calendar/model';
import { useCalendarSources } from '@/features/calendar/queries';
import { taskStatusLabels, taskStatusStates } from '@/features/tasks/status';
import { CreateCalendarEvent, type InitialEvent } from '@/features/calendar/create-event';

const viewLabels: Record<CalendarView, string> = { day: 'Day', week: 'Week', month: 'Month', agenda: 'Agenda' };
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = [...new Set([localZone, 'UTC', ...Intl.supportedValuesOf('timeZone')])];
type Read = Pick<ReturnType<typeof useFeatureRead<unknown>>, 'state'> & { refresh: () => Promise<unknown> };

function SourceStatus({ label, read }: { label: string; read: Read }) {
  if (read.state.kind === 'loading')
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading {label}…
      </p>
    );
  if (read.state.kind === 'unavailable')
    return <p className="text-xs text-muted-foreground">{label} is not available with your current access.</p>;
  if (read.state.kind === 'error' || (read.state.kind === 'ready' && read.state.error))
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-xs text-destructive">
          {label} could not refresh.
        </p>
        <Button variant="outline" size="sm" onClick={() => void read.refresh()}>
          Retry {label}
        </Button>
      </div>
    );
  return null;
}
function ZoneSelect({
  value,
  onChange,
  label,
  optional = false,
}: {
  value: string;
  onChange: (zone: string) => void;
  label: string;
  optional?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={next => {
        if (next !== null) onChange(next);
      }}
      items={[
        ...(optional ? [{ value: '', label: 'Off' }] : []),
        ...zones.map(zone => ({ value: zone, label: zone.replaceAll('_', ' ') })),
      ]}
    >
      <SelectTrigger width="full" size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {optional && <SelectItem value="">Off</SelectItem>}
        {zones.map(zone => (
          <SelectItem value={zone} key={zone}>
            {zone.replaceAll('_', ' ')}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export default function CalendarPage() {
  const { workspace, membershipId } = workspaceRoute.useRouteContext();
  return <PersonalCalendar key={`${workspace.id}:${membershipId}`} workspaceId={workspace.id} slug={workspace.slug} />;
}
function PersonalCalendar({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const search = workspaceCalendarRoute.useSearch(),
    navigate = useNavigate(),
    changes = useFeatureChanges();
  const zone = search.zone ?? localZone,
    view = search.view ?? 'week',
    day = search.date ?? dayKey(new Date(), zone);
  const [now, setNow] = useState(new Date()),
    [secondZone, setSecondZone] = useState('');
  const [kinds, setKinds] = useState<CalendarKind[]>([...calendarKinds]),
    [hiddenSources, setHiddenSources] = useState<string[]>([]);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const range = useMemo(() => calendarRange(day, view, zone), [day, view, zone]);
  const sources = useCalendarSources(workspaceId, slug, range, taskCursor);
  const [selected, setSelected] = useState<string | null>(null),
    [panel, setPanel] = useState<'filters' | 'tasks' | 'follow' | 'find' | null>(null);
  const [create, setCreate] = useState<
      (InitialEvent & { calendars: ProviderCalendar[]; sourceKey: string; zone: string }) | null
    >(null),
    [createOpen, setCreateOpen] = useState(false),
    [createKey, setCreateKey] = useState(0);
  const [commandsOpen, setCommandsOpen] = useState(false),
    [query, setQuery] = useState('');
  const [followBusy, setFollowBusy] = useState(false),
    [followError, setFollowError] = useState<string | null>(null),
    followLock = useRef(false);
  const [duration, setDuration] = useState('30');
  const [pendingOpen, setPendingOpen] = useState(false),
    [focusAt, setFocusAt] = useState<number | null>(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const show = useCallback(
    (next: { date?: string; view?: CalendarView; zone?: string }) => {
      setFocusAt(null);
      return navigate({
        to: '/$workspaceSlug/calendar',
        params: { workspaceSlug: slug },
        search: { date: day, view, zone, ...next },
      });
    },
    [navigate, slug, day, view, zone],
  );
  const today = () => show({ date: dayKey(new Date(), zone) });
  const goToNow = () => {
    const at = new Date();
    setNow(at);
    setFocusAt(at.getTime());
    void navigate({
      to: '/$workspaceSlug/calendar',
      params: { workspaceSlug: slug },
      search: { date: dayKey(at, zone), view: view === 'week' ? 'week' : 'day', zone },
      resetScroll: false,
    });
  };
  const openCreate = (date = day, time = '09:00', title?: string, endTime?: string) => {
    setPendingOpen(false);
    setPanel(null);
    setCreate(current =>
      current?.calendars.length
        ? current
        : {
            date,
            time,
            calendars: google?.calendars ?? [],
            sourceKey,
            zone,
            ...(title ? { title } : {}),
            ...(endTime ? { endTime } : {}),
          },
    );
    setCreateOpen(true);
  };
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            'input, textarea, select, [contenteditable], [role="dialog"], [role="listbox"], [role="menu"]',
          ))
      )
        return;
      if (createOpen || panel || selected || commandsOpen || pendingOpen || datePickerOpen) return;
      const key = event.key.toLowerCase(),
        shortcuts: Record<string, () => void> = {
          '/': () => setCommandsOpen(true),
          t: today,
          c: () => openCreate(),
          d: () => show({ view: 'day' }),
          w: () => show({ view: 'week' }),
          m: () => show({ view: 'month' }),
          a: () => show({ view: 'agenda' }),
          '[': () => show({ date: moveDate(day, view, -1, zone) }),
          ']': () => show({ date: moveDate(day, view, 1, zone) }),
        };
      if (shortcuts[key]) {
        event.preventDefault();
        shortcuts[key]();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const allItems = sources.items;
  const visible = allItems.filter(item => kinds.includes(item.kind) && !hiddenSources.includes(item.sourceId));
  const item = allItems.find(candidate => candidate.id === selected);
  const google = sources.connected && sources.google.state.kind === 'ready' ? sources.google.state.data : null;
  const shownCalendars = google?.calendars.filter(calendar => !hiddenSources.includes(calendar.id)).length ?? 0;
  const filterCount = calendarKinds.length - kinds.length + (google?.calendars.length ?? 0) - shownCalendars;
  const clearFilters = () => {
    setKinds([...calendarKinds]);
    setHiddenSources([]);
  };
  const workflows = sources.workflows.state.kind === 'ready' ? sources.workflows.state.data : null;
  const tasks = sources.tasks.state.kind === 'ready' ? sources.tasks.state.data : null;
  const pendingFailed = [sources.tasks.state, sources.workflows.state].some(
    state => state.kind === 'error' || (state.kind === 'ready' && state.error),
  );
  const pendingUnavailable = [sources.tasks.state, sources.workflows.state].some(state => state.kind === 'unavailable');
  const pendingCount = tasks && workflows ? tasks.tasks.length + workflows.actions.length : null;
  const pendingPartial = !!(tasks?.nextCursor || taskCursor || workflows?.more);
  const pendingLabel = pendingFailed
    ? '!'
    : pendingUnavailable
      ? '—'
      : pendingCount === null
        ? '…'
        : `${pendingCount}${pendingPartial ? '+' : ''}`;
  const pendingDescription = pendingFailed
    ? 'Some pending work could not load. Open to retry.'
    : pendingUnavailable
      ? 'Some pending work is unavailable with your current access.'
      : pendingCount === null
        ? 'Loading pending work'
        : `${pendingLabel} tasks and approvals without a scheduled time`;
  const planning = calendarNowNext(visible, now, zone);
  const planningComplete =
    [sources.agents.state, sources.workflows.state, ...(sources.connected ? [sources.google.state] : [])].every(
      state => state.kind === 'ready' && !state.error,
    ) &&
    sources.integration.state.kind === 'ready' &&
    !sources.integration.error &&
    (!sources.connected || google?.complete);
  const nextDay = planning.next
    ? planning.next.time.kind === 'all-day'
      ? planning.next.time.start
      : dayKey(new Date(itemStart(planning.next)), zone)
    : null;
  const nextDateLabel =
    nextDay && nextDay !== dayKey(now, zone) ? `${format(localDate(nextDay, '12:00', zone), 'EEE d')} · ` : '';
  const calendarStatus = sources.integration.data?.status;
  const sourceKey =
    calendarStatus && calendarStatus.status !== 'disconnected'
      ? `${calendarStatus.integrationId}:${calendarStatus.accountId}:${calendarStatus.generation}`
      : '';
  const canFind =
    !!google?.complete &&
    Date.now() - google.loadedAt < 60000 &&
    sources.google.state.kind === 'ready' &&
    !sources.google.state.error &&
    !sources.google.state.refreshing &&
    sources.integration.state.kind === 'ready' &&
    !sources.integration.error &&
    !sources.integration.busy;
  const slots = canFind ? freeSlots(google.items, day, zone, Number(duration), now.getTime()) : [];
  const follow = async (id: string, following: boolean) => {
    if (followLock.current) return;
    followLock.current = true;
    setFollowBusy(true);
    setFollowError(null);
    try {
      await calendarApi.follow(workspaceId, id, following);
      await changes.change({ keys: [['workflows', 'calendar']] });
    } catch {
      setFollowError('Could not save this follow. Retry with the same choice.');
    } finally {
      followLock.current = false;
      setFollowBusy(false);
    }
  };
  const pendingItems = (
    <>
      {tasks?.tasks.map(task => (
        <article key={task.id} aria-label={task.title} className="grid min-w-0">
          <Card size="sm">
            <CardHeader>
              <div className="grid min-w-0 grid-cols-1">
                <Button
                  variant="ghost"
                  size="md"
                  nativeButton={false}
                  title={task.title}
                  render={
                    <Link to="/$workspaceSlug/agent-tasks/$taskId" params={{ workspaceSlug: slug, taskId: task.id }} />
                  }
                >
                  <CalendarKindIcon kind="task" marked />
                  <span className="min-w-0 flex-1 truncate text-start">{task.title}</span>
                </Button>
              </div>
            </CardHeader>
            <div className="mt-auto">
              <CardFooter>
                <div className="flex w-full items-center justify-between gap-2">
                  <Badge
                    variant={
                      task.status === 'waiting-approval' || task.status === 'waiting-clarification'
                        ? 'warning'
                        : 'secondary'
                    }
                  >
                    <Status state={taskStatusStates[task.status]} size="sm" aria-hidden="true" />
                    {taskStatusLabels[task.status]}
                  </Badge>
                  <Button variant="outline" size="md" onClick={() => openCreate(day, '09:00', task.title)}>
                    <Clock3 size={14} />
                    Reserve time
                  </Button>
                </div>
              </CardFooter>
            </div>
          </Card>
        </article>
      ))}
      {workflows?.actions.map(action => (
        <article key={`${action.runId}:${action.stepId}`} aria-label={action.title} className="grid min-w-0">
          <Card size="sm">
            <CardHeader>
              <div className="grid min-w-0 grid-cols-1">
                <Button
                  variant="ghost"
                  size="md"
                  nativeButton={false}
                  title={action.title}
                  render={
                    <Link
                      to="/$workspaceSlug/workflows"
                      params={{ workspaceSlug: slug }}
                      search={{ workflow: action.workflowId, view: 'runs', run: action.runId }}
                    />
                  }
                >
                  <CalendarKindIcon kind="workflow" marked />
                  <span className="min-w-0 flex-1 truncate text-start">{action.title}</span>
                </Button>
              </div>
            </CardHeader>
            <div className="mt-auto">
              <CardFooter>
                <div className="flex w-full items-center justify-between gap-2">
                  <Badge variant="warning">Needs your input</Badge>
                  <Button
                    variant="outline"
                    size="md"
                    aria-label={`Review ${action.title}`}
                    nativeButton={false}
                    render={
                      <Link
                        to="/$workspaceSlug/workflows"
                        params={{ workspaceSlug: slug }}
                        search={{ workflow: action.workflowId, view: 'runs', run: action.runId }}
                      />
                    }
                  >
                    Review
                    <ChevronRight size={14} />
                  </Button>
                </div>
              </CardFooter>
            </div>
          </Card>
        </article>
      ))}
    </>
  );
  const pendingStatus = (
    <>
      <SourceStatus label="tasks" read={sources.tasks} />
      <SourceStatus label="workflow actions" read={sources.workflows} />
      {workflows?.more && (
        <p className="text-xs text-muted-foreground">
          The workflow list is partial.{' '}
          <Button
            variant="link"
            size="sm"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/workflows" params={{ workspaceSlug: slug }} />}
          >
            Open Workflows
          </Button>
        </p>
      )}
    </>
  );
  const pendingEmpty = pendingCount === 0 && !pendingFailed && !pendingUnavailable;
  const pendingEmptyMessage = pendingPartial
    ? 'No items on this page. Other work may be available.'
    : 'You’re all caught up.';
  const needsTime = (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Tasks and approvals without a scheduled time. Open an item or reserve time on your calendar.
      </p>
      {pendingStatus}
      <div className="space-y-4">{pendingItems}</div>
      {pendingEmpty && <p className="py-5 text-sm text-muted-foreground">{pendingEmptyMessage}</p>}
      <div className="flex flex-wrap gap-2">
        {taskCursor && (
          <Button variant="outline" size="sm" onClick={() => setTaskCursor(null)}>
            First tasks
          </Button>
        )}
        {tasks?.nextCursor && (
          <Button variant="outline" size="sm" onClick={() => setTaskCursor(tasks.nextCursor)}>
            More tasks
          </Button>
        )}
      </div>
    </div>
  );
  const filters = (
    <div className="space-y-4">
      <section className="space-y-2" aria-label="Event types">
        <h2 className="text-sm font-medium">Event types</h2>
        {calendarKinds.map(kind => (
          <CheckboxField
            key={kind}
            variant="neutral"
            label={kindLabels[kind]}
            checked={kinds.includes(kind)}
            onCheckedChange={checked =>
              setKinds(current => (checked ? [...current, kind] : current.filter(value => value !== kind)))
            }
          />
        ))}
        <Button variant="ghost" size="sm" aria-label="Choose workflow follows" onClick={() => setPanel('follow')}>
          <Plus size={14} />
          Follow workflows
        </Button>
      </section>
      <Accordion multiple>
        <AccordionItem value="sources">
          <AccordionTrigger variant="quiet" aria-label="Google calendars" aria-describedby="calendar-source-summary">
            <span className="grid gap-1">
              <span>Google calendars</span>
              <span id="calendar-source-summary" className="text-xs font-normal text-muted-foreground">
                {google ? `${shownCalendars} of ${google.calendars.length} shown` : 'Manage connected calendars'}
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <section className="space-y-2" aria-label="Calendar sources">
              {google?.calendars.map(source => (
                <CheckboxField
                  key={source.id}
                  variant="neutral"
                  label={source.summary}
                  checked={!hiddenSources.includes(source.id)}
                  onCheckedChange={checked =>
                    setHiddenSources(current =>
                      checked ? current.filter(value => value !== source.id) : [...current, source.id],
                    )
                  }
                />
              ))}
              <Button
                variant="link"
                size="sm"
                nativeButton={false}
                render={<Link to="/$workspaceSlug/integrations" params={{ workspaceSlug: slug }} />}
              >
                Manage integrations
              </Button>
            </section>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="zones">
          <AccordionTrigger variant="quiet" aria-label="Time zones" aria-describedby="calendar-zone-summary">
            <span className="grid gap-1">
              <span>Time zones</span>
              <span id="calendar-zone-summary" className="text-xs font-normal text-muted-foreground">
                {zone.split('/').at(-1)?.replaceAll('_', ' ')}
                {secondZone && secondZone !== zone ? ` · ${secondZone.split('/').at(-1)?.replaceAll('_', ' ')}` : ''}
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <section className="space-y-2" aria-label="Time zones">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Calendar time</span>
                <time className="text-xs tabular-nums text-muted-foreground">
                  {now.toLocaleTimeString('en', { timeZone: zone, hour: 'numeric', minute: '2-digit' })}
                </time>
              </div>
              <ZoneSelect label="Calendar time zone" value={zone} onChange={value => show({ zone: value })} />
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-muted-foreground">Compare with</span>
                {secondZone && (
                  <time className="text-xs tabular-nums text-muted-foreground">
                    {now.toLocaleTimeString('en', { timeZone: secondZone, hour: 'numeric', minute: '2-digit' })}
                  </time>
                )}
              </div>
              <ZoneSelect label="Second time zone" value={secondZone} onChange={setSecondZone} optional />
            </section>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      {filterCount > 0 && (
        <Button variant="outline" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
  const commandOptions = [
    { id: 'today', title: 'Go to today', key: 'T', run: today },
    { id: 'create', title: 'Create event', key: 'C', run: () => openCreate() },
    { id: 'find', title: 'Find free time', key: '', run: () => setPanel('find') },
    { id: 'follow', title: 'Follow workflows', key: '', run: () => setPanel('follow') },
    { id: 'now', title: 'Go to now', key: '', run: goToNow },
    ...calendarViews.map(value => ({
      id: value,
      title: `${viewLabels[value]} view`,
      key: value[0]!.toUpperCase(),
      run: () => show({ view: value }),
    })),
  ].filter(option => option.title.toLowerCase().includes(query.toLowerCase()));
  const matchingItems = visible.filter(event => event.title.toLowerCase().includes(query.toLowerCase())).slice(0, 30);
  const title = localDate(day, '12:00', zone).toLocaleDateString('en', { month: 'long', year: 'numeric' });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Calendar"
        actions={
          <>
            <span className="hidden sm:inline-flex">
              <Button
                variant="ghost"
                size="md"
                aria-label="Calendar commands"
                title="Search events and commands (/)"
                onClick={() => setCommandsOpen(true)}
              >
                <Search size={14} />
                Search
              </Button>
            </span>
            <Button size="md" onClick={() => openCreate()}>
              <Plus size={14} />
              Create
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <section
          className="calendar-surface flex min-h-0 min-w-0 flex-1 flex-col bg-card"
          aria-label="Personal calendar"
        >
          <header className="calendar-toolbar">
            <div className="calendar-range-controls">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous range"
                onClick={() => show({ date: moveDate(day, view, -1, zone) })}
              >
                <ChevronLeft size={16} />
              </Button>
              <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
                <h2 className="min-w-0" aria-label={title}>
                  <PopoverTrigger render={<Button variant="ghost" size="md" aria-label="Choose date" />}>
                    <span className="calendar-title-full">{title}</span>
                    <span className="calendar-title-short">{format(localDate(day, '12:00', zone), 'MMM yyyy')}</span>
                    <ChevronDown size={14} />
                  </PopoverTrigger>
                </h2>
                <PopoverContent align="start" aria-label="Choose a calendar date">
                  <Calendar
                    mode="single"
                    weekStartsOn={1}
                    selected={new Date(`${day}T12:00:00`)}
                    defaultMonth={new Date(`${day}T12:00:00`)}
                    onSelect={date => {
                      if (date) {
                        setDatePickerOpen(false);
                        void show({ date: format(date, 'yyyy-MM-dd') });
                      }
                    }}
                  />
                </PopoverContent>
              </Popover>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next range"
                onClick={() => show({ date: moveDate(day, view, 1, zone) })}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
            <div className="calendar-view-control">
              <Select
                value={view}
                onValueChange={value => {
                  const found = calendarViews.find(candidate => candidate === value);
                  if (found) show({ view: found });
                }}
                items={calendarViews.map(value => ({ value, label: viewLabels[value] }))}
              >
                <SelectTrigger size="md" aria-label="Calendar view">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {calendarViews.map(value => (
                    <SelectItem key={value} value={value}>
                      {viewLabels[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="calendar-main-controls">
              <Popover open={pendingOpen} onOpenChange={setPendingOpen}>
                <PopoverTrigger
                  render={<Button variant="outline" size="md" aria-label="Pending work" title={pendingDescription} />}
                >
                  <Inbox size={14} />
                  <span className="calendar-pending-label">Pending work</span>
                  <Badge variant={pendingFailed ? 'destructive' : pendingCount === 0 ? 'secondary' : 'warning'}>
                    {pendingLabel}
                  </Badge>
                  <ChevronDown size={14} />
                </PopoverTrigger>
                <PopoverContent size="work-list" align="start" aria-label="Pending work">
                  <div className="shrink-0 border-b p-3">
                    <PopoverHeader>
                      <PopoverTitle>Pending work</PopoverTitle>
                      <PopoverDescription>Tasks and approvals without a scheduled time.</PopoverDescription>
                    </PopoverHeader>
                  </div>
                  <div
                    role="region"
                    aria-label="Unscheduled tasks and approvals"
                    tabIndex={0}
                    className="min-h-0 space-y-3 overflow-y-auto p-3 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {pendingStatus}
                    <div className="grid gap-2">{pendingItems}</div>
                    {pendingEmpty && <p className="py-3 text-sm text-muted-foreground">{pendingEmptyMessage}</p>}
                  </div>
                  <footer className="flex shrink-0 justify-end border-t p-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="View all pending work"
                      onClick={() => {
                        setPendingOpen(false);
                        setPanel('tasks');
                      }}
                    >
                      View all
                      <ChevronRight size={14} />
                    </Button>
                  </footer>
                </PopoverContent>
              </Popover>
              <Button variant="outline" size="md" onClick={today}>
                Today
              </Button>
              <Button variant="outline" size="md" aria-label="Calendar filters" onClick={() => setPanel('filters')}>
                <SlidersHorizontal size={14} />
                Filters{filterCount > 0 && <Badge variant="secondary">{filterCount}</Badge>}
              </Button>
              <div className="calendar-desktop-tools">
                <Button
                  variant="outline"
                  size="md"
                  aria-label="Find time"
                  onClick={() => {
                    setPanel('find');
                    void sources.google.refresh();
                  }}
                >
                  <Clock3 size={14} />
                  Find time
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Refresh calendar"
                  onClick={() => void sources.refresh()}
                >
                  <RefreshCw size={14} />
                </Button>
              </div>
              <div className="calendar-more-controls">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon" aria-label="More calendar actions" />}
                  >
                    <MoreHorizontal size={16} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent size="menu" align="end">
                    <DropdownMenuItem onClick={() => setCommandsOpen(true)}>
                      <Search size={14} />
                      Search calendar
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setPanel('find');
                        void sources.google.refresh();
                      }}
                    >
                      <Clock3 size={14} />
                      Find time
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void sources.refresh()}>
                      <RefreshCw size={14} />
                      Refresh calendar
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </header>
          <section aria-label="Now and next in this view" className="calendar-now-next">
            <Button variant="ghost" size="md" aria-label="Go to now" onClick={goToNow}>
              Now
              <span className="calendar-current-clock">
                {now.toLocaleTimeString('en', { timeZone: zone, hour: 'numeric', minute: '2-digit' })}
              </span>
            </Button>
            {planning.current[0] && (
              <div className="flex min-w-0 max-w-96 items-center gap-1">
                <span className="shrink-0 text-muted-foreground">Happening now</span>
                <div className="grid min-w-0 grid-cols-1">
                  <Button
                    variant="ghost"
                    size="md"
                    aria-label={`Now in view: ${planning.current[0].title}`}
                    onClick={() => setSelected(planning.current[0]!.id)}
                  >
                    <span className="truncate text-xs">
                      {planning.current[0].title} · {compactItemTime(planning.current[0], zone)}
                      {planning.current.length > 1 ? ` +${planning.current.length - 1}` : ''}
                    </span>
                  </Button>
                </div>
              </div>
            )}
            {planning.next ? (
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <span className="shrink-0 text-muted-foreground">
                  {planning.next.time.kind === 'point' ? 'Next run' : 'Up next'}
                </span>
                <div className="grid min-w-0 grid-cols-1">
                  <Button
                    variant="ghost"
                    size="md"
                    aria-label={`Next in view: ${planning.next.title}`}
                    onClick={() => setSelected(planning.next!.id)}
                  >
                    <span className="truncate text-xs">
                      {nextDateLabel}
                      {compactItemTime(planning.next, zone, true)} · {planning.next.title}
                    </span>
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground">
                {planningComplete ? 'No more events in this view.' : 'Schedule not fully loaded.'}
              </p>
            )}
          </section>
          <div className="space-y-1 px-4 empty:hidden">
            <SourceStatus label="integrations" read={sources.integration} />
            <SourceStatus label="workflows" read={sources.workflows} />
            <SourceStatus label="agent schedules" read={sources.agents} />
            {sources.connected && <SourceStatus label="Google Calendar" read={sources.google} />}
            {calendarStatus && !sources.connected && (
              <p className="py-2 text-xs text-muted-foreground">
                {calendarStatus.status === 'reconnect-required'
                  ? 'Reconnect Google to see calendar events.'
                  : 'Connect Google Calendar to add meetings and find free time.'}{' '}
                <Button
                  variant="link"
                  size="sm"
                  nativeButton={false}
                  render={<Link to="/$workspaceSlug/integrations" params={{ workspaceSlug: slug }} />}
                >
                  Open integrations
                </Button>
              </p>
            )}
            {google?.errors.map(error => (
              <p role="alert" key={error.id} className="py-1 text-xs text-destructive">
                {error.message}{' '}
                <Button variant="link" size="sm" onClick={() => void sources.google.refresh()}>
                  Retry
                </Button>
              </p>
            ))}
            {(workflows?.more || (sources.agents.state.kind === 'ready' && sources.agents.state.data.more)) && (
              <p className="py-1 text-xs text-muted-foreground">
                Some scheduled work is outside this result limit. Choose a shorter view or open Workflows.
              </p>
            )}
            {visible.length === 0 &&
              sources.workflows.state.kind === 'ready' &&
              sources.agents.state.kind === 'ready' &&
              (!sources.connected || sources.google.state.kind === 'ready') && (
                <div className="flex flex-wrap items-center gap-2 py-2 text-xs text-muted-foreground">
                  <p>
                    {allItems.length
                      ? 'No events match these filters.'
                      : 'Nothing scheduled here yet. Create an event or follow a workflow.'}
                  </p>
                  {filterCount > 0 && (
                    <Button variant="outline" size="sm" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  )}
                </div>
              )}
          </div>
          <CalendarBoard
            items={visible}
            day={day}
            view={view}
            zone={zone}
            secondZone={secondZone === zone || !secondZone ? null : secondZone}
            now={now}
            focusAt={focusAt}
            onSelect={setSelected}
            onDay={value => show({ date: value, view: 'day' })}
            onFocusDay={value => show({ date: value })}
            onAgenda={value => show({ date: value, view: 'agenda' })}
            onCreate={openCreate}
          />
        </section>
      </div>
      <Sheet
        open={panel !== null}
        onOpenChange={open => {
          if (!open) setPanel(null);
        }}
      >
        <SheetContent size="lg" side={panel === 'filters' ? 'left' : 'right'}>
          <SheetHeader>
            <SheetTitle>
              {
                {
                  filters: 'Calendar filters',
                  tasks: 'Pending work',
                  follow: 'Follow workflows',
                  find: 'Find free time',
                }[panel ?? 'filters']
              }
            </SheetTitle>
            <SheetDescription>
              {panel === 'find'
                ? 'Your connected calendars only. This does not check guests’ availability.'
                : panel === 'follow'
                  ? 'Follow a workflow to see its schedule. Following does not grant access.'
                  : panel === 'filters'
                    ? 'Choose which events and time zones to show.'
                    : 'Tasks and approvals that need your attention.'}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto px-4 pb-6">
            {panel === 'filters' && filters}
            {panel === 'tasks' && needsTime}
            {panel === 'follow' && (
              <div className="space-y-4">
                <SourceStatus label="workflows" read={sources.workflows} />
                {followError && <Alert variant="destructive">{followError}</Alert>}
                {workflows?.workflows.map(workflow => (
                  <div key={workflow.id} className="space-y-1 rounded-lg border p-3">
                    <CheckboxField
                      label={workflow.name}
                      checked={workflow.following || workflow.personal}
                      disabled={workflow.personal || followBusy}
                      onCheckedChange={checked => void follow(workflow.id, checked)}
                    />
                    {workflow.personal && (
                      <p className="pl-6 text-xs text-muted-foreground">Your workflow · always included</p>
                    )}
                  </div>
                ))}
                {workflows && !workflows.workflows.length && (
                  <p className="text-sm text-muted-foreground">No workflows are available to follow yet.</p>
                )}
                {workflows?.more && (
                  <p className="text-xs text-muted-foreground">
                    This list is limited. Open Workflows for all definitions.
                  </p>
                )}
              </div>
            )}
            {panel === 'find' && (
              <div className="space-y-5">
                <Field label="Day" required>
                  <Input
                    type="date"
                    value={day}
                    onChange={event => {
                      if (event.target.value) show({ date: event.target.value });
                    }}
                  />
                </Field>
                <Field label="Duration" required>
                  <Select
                    value={duration}
                    onValueChange={value => {
                      if (value) setDuration(value);
                    }}
                    items={[
                      { value: '30', label: '30 minutes' },
                      { value: '60', label: '1 hour' },
                      { value: '90', label: '90 minutes' },
                    ]}
                  >
                    <SelectTrigger width="full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30">30 minutes</SelectItem>
                      <SelectItem value="60">1 hour</SelectItem>
                      <SelectItem value="90">90 minutes</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <p className="text-xs text-muted-foreground">
                  9 AM–6 PM in {zone.replaceAll('_', ' ')}. Uses all connected calendars, including hidden ones.
                  Scheduled agents and workflows do not block time.
                </p>
                {!canFind ? (
                  <Alert>
                    Availability is not confirmed. Connect Google Calendar or refresh until every calendar loads.{' '}
                    <Button variant="outline" size="sm" onClick={() => void sources.refresh()}>
                      Refresh availability
                    </Button>
                  </Alert>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Free when last loaded. Calendars can change before you book.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {slots.map(slot => (
                        <Button
                          key={slot.start}
                          variant="outline"
                          onClick={() =>
                            openCreate(day, clockTime(slot.start, zone), undefined, clockTime(slot.end, zone))
                          }
                        >
                          {new Date(slot.start).toLocaleTimeString('en', {
                            timeZone: zone,
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </Button>
                      ))}
                    </div>
                    {!slots.length && (
                      <p className="text-sm text-muted-foreground">
                        No free slots left in these hours. Try another day.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <Sheet
        open={!!item}
        onOpenChange={open => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent size="lg">
          <SheetHeader>
            <SheetTitle>{item?.title}</SheetTitle>
            <SheetDescription>{item ? itemTime(item, zone) : ''}</SheetDescription>
          </SheetHeader>
          {item && (
            <div className="space-y-5 px-4 pb-6">
              <div className="flex flex-wrap items-center gap-2">
                <CalendarKindIcon kind={item.kind} />
                <Badge variant="secondary">{item.status.replaceAll('_', ' ')}</Badge>
                {item.tags?.map(tag => (
                  <Badge variant="outline" key={tag}>
                    {tag}
                  </Badge>
                ))}
              </div>
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <dt className="text-muted-foreground">Calendar</dt>
                <dd className="col-span-2">{item.source}</dd>
                <dt className="text-muted-foreground">Time zone</dt>
                <dd className="col-span-2">{zone.replaceAll('_', ' ')}</dd>
                {item.location && (
                  <>
                    <dt className="text-muted-foreground">Location</dt>
                    <dd className="col-span-2">{item.location}</dd>
                  </>
                )}
              </dl>
              <div className="flex flex-wrap gap-2">
                {item.joinUrl && (
                  <Button
                    nativeButton={false}
                    render={<a href={item.joinUrl} target="_blank" rel="noopener noreferrer" />}
                  >
                    Join meeting
                    <ExternalLink size={14} />
                  </Button>
                )}
                {item.href && (
                  <Button
                    variant="outline"
                    nativeButton={false}
                    render={
                      <a
                        href={item.href}
                        {...(item.href.startsWith('https:') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                      />
                    }
                  >
                    Open {item.kind === 'workflow' ? 'workflow' : item.kind === 'agent' ? 'agent' : 'original'}
                    <ExternalLink size={14} />
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {item.busy ? 'Blocks your personal free time.' : 'Does not block your personal free time.'}
              </p>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent size="lg" keepMounted>
          <SheetHeader>
            <SheetTitle>Create event</SheetTitle>
            <SheetDescription>
              A meeting, focus block, or time to work on a task. Closing keeps your draft on this page.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto px-4 pb-6">
            {create && create.calendars.some(calendar => ['owner', 'writer'].includes(calendar.accessRole)) ? (
              <CreateCalendarEvent
                key={createKey}
                workspaceId={workspaceId}
                calendars={create.calendars}
                initial={create}
                zone={create.zone}
                available={
                  sources.connected === true &&
                  !sources.integration.error &&
                  !sources.integration.busy &&
                  sourceKey === create.sourceKey
                }
                onNew={() => {
                  setCreateKey(key => key + 1);
                  setCreate({ date: day, time: '09:00', calendars: google?.calendars ?? [], sourceKey, zone });
                }}
              />
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Connect a writable Google Calendar before creating events.
                </p>
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={<Link to="/$workspaceSlug/integrations" params={{ workspaceSlug: slug }} />}
                >
                  Open integrations
                </Button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <SearchDialog
        open={commandsOpen}
        onOpenChange={setCommandsOpen}
        title="Calendar commands"
        description="Find an event or use a calendar shortcut."
      >
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Find an event or command…"
          label="Calendar commands"
        />
        <SearchList label="Calendar results">
          <SearchGroup heading="Commands" count={commandOptions.length}>
            {commandOptions.map(option => (
              <SearchItem
                key={option.id}
                value={option.id}
                title={option.title}
                media={<Command size={16} />}
                trailing={option.key}
                onSelect={() => {
                  setCommandsOpen(false);
                  option.run();
                }}
              />
            ))}
          </SearchGroup>
          <SearchGroup heading="Events in this view" count={matchingItems.length}>
            {matchingItems.map(event => (
              <SearchItem
                key={event.id}
                value={event.id}
                title={event.title}
                media={<CalendarKindIcon kind={event.kind} />}
                detail={itemTime(event, zone)}
                onSelect={() => {
                  setCommandsOpen(false);
                  setSelected(event.id);
                }}
              />
            ))}
          </SearchGroup>
          {!commandOptions.length && !matchingItems.length && (
            <SearchEmpty media={<Search />} title="No matches" description="Try another title or calendar command." />
          )}
        </SearchList>
        <SearchFooter>
          <SearchHint keys="/">Open commands</SearchHint>
          <SearchHint keys="[ ]">Previous / next</SearchHint>
          <SearchHint keys="Esc">Close</SearchHint>
        </SearchFooter>
      </SearchDialog>
    </div>
  );
}
