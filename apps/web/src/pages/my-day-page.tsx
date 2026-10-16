import type { MyDayHabitRow, MyDayTaskRow } from '@nix/api-client';
import { Button, Checkbox, Input, Text, focusRing } from '@nix/ui';
import { useState, type ReactElement, type ReactNode } from 'react';

import { DailyCaptureDialog } from '../daily-notes/daily-capture-dialog';
import { ErrorPanel, LoadingPanel, PartialNotice } from '../components/states/status-panels';
import { useItemDialog } from '../items/item-dialog-context';
import { paneScroller } from '../layout/regions';
import { taskKey, useMyDay, type MyDayState } from '../my-day/use-my-day';
import { useOpenItem } from '../tabs/use-open-item';
import { useWorkspace } from '../workspaces/workspace-context';

/**
 * The My Day destination: what to do today in this workspace, read from the original items.
 *
 * Every row is the item itself - opening it opens the original, finishing it writes the original -
 * so nothing on this page can drift from the note it came from. The heading is outside the state
 * fork for the reason the calendar's is: it answers "where am I" while loading and when failed.
 *
 * **Coverage is shown before emptiness is claimed.** A section that was cut short, or that held
 * something this version could not judge, says so beside whatever rows it did get; "Nothing due"
 * appears only when the read says it saw everything.
 */

const COVERAGE_SENTENCES: Readonly<Record<string, string>> = {
  candidate_limit: 'More items matched than could be checked, so some may be missing.',
  row_limit: 'More tasks qualify than are shown.',
  invalid_schema: 'Some items have a field setup this version cannot read.',
  invalid_properties: 'Some items have a date or completion value this version cannot read.',
  invalid_recurrence: 'Some repeating tasks have a rule or due date this version cannot read.',
  habit_locked: 'Some habits are locked, so their history is hidden.',
  invalid_habit: 'Some habits have settings or history this version cannot read.',
  habit_history_limit: 'Some habits have more history than this version can read.',
};

const TASK_GROUPS = [
  { section: 'today', label: 'Today' },
  { section: 'overdue', label: 'Overdue' },
  { section: 'assigned', label: 'Assigned to you' },
] as const;

function coverageText(
  reasons: readonly { readonly code: string; readonly omitted: number | null }[],
): string {
  return reasons
    .map(({ code, omitted }) => {
      const sentence = COVERAGE_SENTENCES[code] ?? 'Some items could not be checked.';
      return omitted === null ? sentence : `${sentence} (${String(omitted)} affected.)`;
    })
    .join(' ');
}

function MyDayFrame({
  children,
  action,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <div className={`${paneScroller} flex min-w-0 flex-col gap-3 p-3 sm:p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Text variant="h4" as="h1">
          My Day
        </Text>
        {action}
      </div>
      {children}
    </div>
  );
}

export function MyDayPage(): ReactElement {
  const { workspace, workspaceId } = useWorkspace();
  const state = useMyDay();
  const { openPreview, openPinned } = useOpenItem();
  const open = useItemDialog() ?? openPreview;
  const [captureOpen, setCaptureOpen] = useState(false);

  // The hook clears on a scope change one tick late; never show another workspace's day meanwhile.
  const day = state.day?.workspaceId === workspaceId ? state.day : null;

  const capture = workspace.canUseDailyNotes ? (
    <Button
      variant="secondary"
      onClick={() => {
        setCaptureOpen(true);
      }}
    >
      Capture to today’s note
    </Button>
  ) : null;

  return (
    <MyDayFrame action={capture}>
      {state.status === 'error' && day === null ? (
        <ErrorPanel
          title="My Day could not be loaded"
          detail={state.error ?? 'Try again.'}
          action={
            <Button
              onClick={() => {
                void state.reload();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : day === null ? (
        <LoadingPanel label="My Day" />
      ) : (
        <>
          <Text tone="muted">
            {day.taskDay} · {day.taskTimezone}
          </Text>
          {state.staleReason === null ? null : <PartialNotice pending={state.staleReason} />}
          <TasksSection day={day} state={state} open={open} />
          <HabitsSection day={day} state={state} open={open} />
        </>
      )}
      <DailyCaptureDialog
        open={captureOpen}
        workspaceId={workspaceId}
        onClose={() => {
          setCaptureOpen(false);
        }}
        onOpenItem={openPinned}
      />
    </MyDayFrame>
  );
}

interface SectionProps {
  readonly day: NonNullable<MyDayState['day']>;
  readonly state: MyDayState;
  readonly open: (itemId: string) => void;
}

function TasksSection({ day, state, open }: SectionProps): ReactElement {
  const { rows, coverage } = day.tasks;
  const partial = coverage.kind === 'partial';
  return (
    <section aria-labelledby="my-day-tasks" className="flex flex-col gap-2">
      <Text variant="h5" as="h2" id="my-day-tasks">
        Tasks
      </Text>
      <Text variant="note" tone="muted">
        Repeating tasks show today’s occurrence.
      </Text>
      {partial ? <PartialNotice pending={coverageText(coverage.reasons)} /> : null}
      {rows.length === 0 && !partial ? <Text tone="muted">Nothing due.</Text> : null}
      {TASK_GROUPS.map(({ section, label }) => {
        const group = rows.filter((row) => row.section === section);
        return group.length === 0 ? null : (
          <div key={section} className="flex flex-col gap-1">
            <Text variant="h6" as="h3">
              {label}
            </Text>
            <ul className="flex flex-col gap-1">
              {group.map((row) => (
                <TaskItem key={taskKey(row)} row={row} state={state} open={open} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function TaskItem({
  row,
  state,
  open,
}: {
  readonly row: MyDayTaskRow;
  readonly state: MyDayState;
  readonly open: (itemId: string) => void;
}): ReactElement {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const title = row.title === '' ? 'Untitled' : row.title;

  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Checkbox
          aria-label={`Complete ${title}`}
          checked={false}
          disabled={pending}
          onChange={() => {
            setPending(true);
            setRefusal(null);
            void state
              .completeTask(row)
              .then((reason) => {
                setRefusal(reason);
              })
              .finally(() => {
                setPending(false);
              });
          }}
        />
        <OpenButton itemId={row.itemId} title={title} open={open} />
        <Source containerTitle={row.containerTitle} />
        {row.dueDay === null ? null : (
          <Text as="span" variant="note" tone="muted">
            due {row.dueDay}
          </Text>
        )}
      </div>
      {refusal === null ? null : (
        <Text role="alert" variant="note" tone="accent">
          {refusal}
        </Text>
      )}
    </li>
  );
}

function HabitsSection({ day, state, open }: SectionProps): ReactElement {
  const { rows, coverage } = day.habits;
  const partial = coverage.kind === 'partial';
  return (
    <section aria-labelledby="my-day-habits" className="flex flex-col gap-2">
      <Text variant="h5" as="h2" id="my-day-habits">
        Habits
      </Text>
      {partial ? <PartialNotice pending={coverageText(coverage.reasons)} /> : null}
      {rows.length === 0 && !partial ? <Text tone="muted">No habits scheduled today.</Text> : null}
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <HabitItem
            key={`${row.itemId}:${row.occurrence.date}`}
            row={row}
            taskDay={day.taskDay}
            state={state}
            open={open}
          />
        ))}
      </ul>
    </section>
  );
}

function HabitItem({
  row,
  taskDay,
  state,
  open,
}: {
  readonly row: MyDayHabitRow;
  readonly taskDay: string;
  readonly state: MyDayState;
  readonly open: (itemId: string) => void;
}): ReactElement {
  const { occurrence } = row;
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(String(occurrence.quantity ?? ''));
  const title = row.title === '' ? 'Untitled' : row.title;
  const recorded = occurrence.completed || occurrence.quantity !== null;
  const counted = occurrence.target > 1;

  const act = (write: Promise<string | null>): void => {
    setPending(true);
    setRefusal(null);
    void write
      .then((reason) => {
        setRefusal(reason);
      })
      .finally(() => {
        setPending(false);
      });
  };

  const amount = Number(quantity);
  const amountValid = quantity.trim() !== '' && Number.isFinite(amount) && amount >= 0;

  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {counted ? null : (
          <Checkbox
            aria-label={`${title} done`}
            checked={occurrence.completed}
            disabled={pending}
            onChange={(event) => {
              act(
                event.target.checked
                  ? state.checkIn(row, { completed: true, quantity: null })
                  : state.undoCheckIn(row),
              );
            }}
          />
        )}
        <OpenButton itemId={row.itemId} title={title} open={open} />
        <Source containerTitle={row.containerTitle} />
        {occurrence.date === taskDay ? null : (
          <Text as="span" variant="note" tone="muted">
            {occurrence.date} in {row.timezone}
          </Text>
        )}
        {counted ? (
          <>
            <Input
              type="number"
              min={0}
              aria-label={`${title}, ${occurrence.unit} today`}
              value={quantity}
              disabled={pending}
              onChange={(event) => {
                setQuantity(event.target.value);
              }}
            />
            <Text as="span" variant="note" tone="muted">
              of {occurrence.target} {occurrence.unit}
            </Text>
            <Button
              variant="secondary"
              disabled={pending || !amountValid}
              onClick={() => {
                act(state.checkIn(row, { completed: false, quantity: amount }));
              }}
            >
              Save
            </Button>
            {recorded ? (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  act(state.undoCheckIn(row));
                }}
              >
                Undo
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {refusal === null ? null : (
        <Text role="alert" variant="note" tone="accent">
          {refusal}
        </Text>
      )}
    </li>
  );
}

function OpenButton({
  itemId,
  title,
  open,
}: {
  readonly itemId: string;
  readonly title: string;
  readonly open: (itemId: string) => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={`Open ${title}`}
      className={`min-w-0 truncate text-left ${focusRing}`}
      onClick={() => {
        open(itemId);
      }}
    >
      {title}
    </button>
  );
}

function Source({
  containerTitle,
}: {
  readonly containerTitle: string | null;
}): ReactElement | null {
  return containerTitle === null ? null : (
    <Text as="span" variant="note" tone="muted">
      in {containerTitle}
    </Text>
  );
}
