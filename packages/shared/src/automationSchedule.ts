import {
  type AutomationCronTrigger,
  type AutomationGitHubEvent,
  type AutomationScheduleTrigger,
  type AutomationTrigger,
  isValidAutomationCronExpression,
} from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function matchesDay(trigger: AutomationScheduleTrigger, day: number): boolean {
  switch (trigger.cadence) {
    case "hourly":
    case "daily":
      return true;
    case "weekdays":
      return day >= 1 && day <= 5;
    case "weekly":
      return day === trigger.weekday;
  }
}

function atTime(day: DateTime.Zoned, hour: number, minute: number): DateTime.Zoned {
  return DateTime.setParts(day, { hour, minute, second: 0, millisecond: 0 });
}

function zonedNow(nowMs: number, timeZone: string | undefined): DateTime.Zoned {
  return DateTime.makeZonedUnsafe(nowMs, { timeZone: timeZone ?? DateTime.zoneMakeLocal() });
}

/**
 * The most recent time at or before `nowMs` this schedule was due, in epoch ms. Schedules are
 * wall-clock times in `timeZone`, the host's own zone unless given.
 */
export function latestScheduledAt(
  trigger: AutomationScheduleTrigger,
  nowMs: number,
  timeZone?: string,
): number {
  const now = zonedNow(nowMs, timeZone);
  if (trigger.cadence === "hourly") {
    const due = DateTime.setParts(now, { minute: trigger.minute, second: 0, millisecond: 0 });
    const ms = DateTime.toEpochMillis(due);
    return ms > nowMs ? DateTime.toEpochMillis(DateTime.subtract(due, { hours: 1 })) : ms;
  }
  // Every non-hourly cadence fires at least once a week, so eight days back always finds one.
  for (let offset = 0; offset <= 7; offset += 1) {
    const due = atTime(DateTime.subtract(now, { days: offset }), trigger.hour, trigger.minute);
    const ms = DateTime.toEpochMillis(due);
    if (ms <= nowMs && matchesDay(trigger, DateTime.getPart(due, "weekDay"))) return ms;
  }
  throw new Error("unreachable: schedule has no occurrence within a week");
}

/** The first time strictly after `nowMs` this schedule is due, in epoch ms. */
export function nextScheduledAt(
  trigger: AutomationScheduleTrigger,
  nowMs: number,
  timeZone?: string,
): number {
  const now = zonedNow(nowMs, timeZone);
  if (trigger.cadence === "hourly") {
    const due = DateTime.setParts(now, { minute: trigger.minute, second: 0, millisecond: 0 });
    const ms = DateTime.toEpochMillis(due);
    return ms <= nowMs ? DateTime.toEpochMillis(DateTime.add(due, { hours: 1 })) : ms;
  }
  for (let offset = 0; offset <= 7; offset += 1) {
    const due = atTime(DateTime.add(now, { days: offset }), trigger.hour, trigger.minute);
    const ms = DateTime.toEpochMillis(due);
    if (ms > nowMs && matchesDay(trigger, DateTime.getPart(due, "weekDay"))) return ms;
  }
  throw new Error("unreachable: schedule has no occurrence within a week");
}

function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function describeScheduleTrigger(trigger: AutomationScheduleTrigger): string {
  switch (trigger.cadence) {
    case "hourly":
      return `Hourly at :${String(trigger.minute).padStart(2, "0")}`;
    case "daily":
      return `Daily at ${formatClock(trigger.hour, trigger.minute)}`;
    case "weekdays":
      return `Weekdays at ${formatClock(trigger.hour, trigger.minute)}`;
    case "weekly":
      return `${WEEKDAY_NAMES[trigger.weekday]} at ${formatClock(trigger.hour, trigger.minute)}`;
  }
}

export const AUTOMATION_GITHUB_EVENT_LABELS: Record<AutomationGitHubEvent, string> = {
  "pull_request.draft_opened": "Draft opened",
  "pull_request.opened": "Pull request opened",
  "issue.opened": "Issue opened",
};

export function describeTrigger(trigger: AutomationTrigger): string {
  switch (trigger.type) {
    case "schedule":
      return describeScheduleTrigger(trigger);
    case "cron":
      return describeCronExpression(trigger.expression) ?? trigger.expression;
    case "github":
      return AUTOMATION_GITHUB_EVENT_LABELS[trigger.event];
  }
}

/** A trigger that fires at clock times, preset or custom. */
export type AutomationTimedTrigger = AutomationScheduleTrigger | AutomationCronTrigger;

function parseCron(expression: string, timeZone: string | undefined): Cron.Cron | null {
  if (!isValidAutomationCronExpression(expression)) return null;
  return Cron.parseUnsafe(expression.trim(), timeZone ?? DateTime.zoneMakeLocal());
}

/** Like `latestScheduledAt`, for any timed trigger. Null for an unparseable cron expression. */
export function latestTriggerAt(
  trigger: AutomationTimedTrigger,
  nowMs: number,
  timeZone?: string,
): number | null {
  if (trigger.type === "schedule") return latestScheduledAt(trigger, nowMs, timeZone);
  const cron = parseCron(trigger.expression, timeZone);
  if (cron === null) return null;
  // `Cron.prev` is exclusive, so the current minute is checked on its own.
  const minuteStart = nowMs - (nowMs % 60_000);
  return Cron.match(cron, minuteStart) ? minuteStart : Cron.prev(cron, minuteStart).getTime();
}

/** Like `nextScheduledAt`, for any timed trigger. Null for an unparseable cron expression. */
export function nextTriggerAt(
  trigger: AutomationTimedTrigger,
  nowMs: number,
  timeZone?: string,
): number | null {
  if (trigger.type === "schedule") return nextScheduledAt(trigger, nowMs, timeZone);
  const cron = parseCron(trigger.expression, timeZone);
  return cron === null ? null : Cron.next(cron, nowMs).getTime();
}

/** The cron expression a preset schedule stands for, for switching a row to custom. */
export function scheduleTriggerToCron(trigger: AutomationScheduleTrigger): string {
  switch (trigger.cadence) {
    case "hourly":
      return `${trigger.minute} * * * *`;
    case "daily":
      return `${trigger.minute} ${trigger.hour} * * *`;
    case "weekdays":
      return `${trigger.minute} ${trigger.hour} * * 1-5`;
    case "weekly":
      return `${trigger.minute} ${trigger.hour} * * ${trigger.weekday}`;
  }
}

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
] as const;

/** "a", "a and b", "a, b, and c". */
function joinList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

/** Sorted values of a cron field, or null when the field allows every value. */
function restricted(values: ReadonlySet<number>, size: number): number[] | null {
  return values.size === 0 || values.size >= size ? null : [...values].sort((a, b) => a - b);
}

/** The step of `start, start+step, …` running to the end of the field, if the values are one. */
function stepFrom(values: readonly number[], size: number): { start: number; step: number } | null {
  const [start, second] = values;
  if (start === undefined || second === undefined) return null;
  const step = second - start;
  // `*/k` and `s-e/k` start below their step; 9,17 is two times of day, not "every 8 hours".
  if (step < 2 || start >= step) return null;
  if (!values.every((value, index) => value === start + index * step)) return null;
  return values.at(-1)! + step >= size ? { start, step } : null;
}

/** A run of consecutive values, if the values are one. */
function contiguous(values: readonly number[]): { first: number; last: number } | null {
  const [first] = values;
  if (first === undefined || values.length < 3) return null;
  return values.every((value, index) => value === first + index)
    ? { first, last: values.at(-1)! }
    : null;
}

function describeWeekdays(weekdays: readonly number[]): string {
  const key = weekdays.join(",");
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "0,6") return "weekends";
  const run = contiguous(weekdays);
  if (run) return `${WEEKDAY_NAMES[run.first]} through ${WEEKDAY_NAMES[run.last]}`;
  return joinList(weekdays.map((day) => WEEKDAY_NAMES[day] ?? String(day)));
}

type TimeDescription =
  | { readonly kind: "clock"; readonly text: string }
  | { readonly kind: "recurring"; readonly text: string };

function describeCronTime(
  minutes: readonly number[] | null,
  hours: readonly number[] | null,
): TimeDescription {
  // The window runs from the first minute of the first hour to the last minute of the last hour.
  const hourWindow = (values: readonly number[]) => {
    const run = contiguous(values);
    const firstMinute = minutes?.[0] ?? 0;
    const lastMinute = minutes?.at(-1) ?? 59;
    return run
      ? `from ${formatClock(run.first, firstMinute)} to ${formatClock(run.last, lastMinute)}`
      : `during hours ${joinList(values.map((hour) => formatClock(hour, firstMinute)))}`;
  };

  if (minutes === null) {
    return {
      kind: "recurring",
      text: hours ? `Every minute ${hourWindow(hours)}` : "Every minute",
    };
  }
  const minuteStep = stepFrom(minutes, 60);
  if (minuteStep && minuteStep.start === 0) {
    const text = `Every ${minuteStep.step} minutes`;
    return { kind: "recurring", text: hours ? `${text} ${hourWindow(hours)}` : text };
  }
  const [minute] = minutes;
  if (minutes.length === 1 && minute !== undefined) {
    const at = minute === 0 ? "" : ` at :${String(minute).padStart(2, "0")}`;
    if (hours === null) return { kind: "recurring", text: `Every hour${at}` };
    const hourStep = stepFrom(hours, 24);
    if (hourStep) {
      return {
        kind: "recurring",
        text:
          hourStep.start === 0
            ? `Every ${hourStep.step} hours${at}`
            : `Every ${hourStep.step} hours starting at ${formatClock(hourStep.start, minute)}`,
      };
    }
    if (contiguous(hours)) {
      return { kind: "recurring", text: `Every hour ${hourWindow(hours)}` };
    }
    return {
      kind: "clock",
      text: joinList(hours.map((hour) => formatClock(hour, minute))),
    };
  }
  const minuteList = joinList(minutes.map((value) => `:${String(value).padStart(2, "0")}`));
  if (hours === null) return { kind: "recurring", text: `Every hour at ${minuteList}` };
  if (hours.length * minutes.length <= 6) {
    return {
      kind: "clock",
      text: joinList(hours.flatMap((hour) => minutes.map((value) => formatClock(hour, value)))),
    };
  }
  return { kind: "recurring", text: `At ${minuteList} ${hourWindow(hours)}` };
}

/**
 * A plain-language reading of a five-field cron expression, e.g. "0 *\/2 * * *" → "Every 2
 * hours". Null when the expression does not parse.
 */
export function describeCronExpression(expression: string): string | null {
  const cron = parseCron(expression, "UTC");
  if (cron === null) return null;
  const time = describeCronTime(restricted(cron.minutes, 60), restricted(cron.hours, 24));
  const days = restricted(cron.days, 31);
  const months = restricted(cron.months, 12);
  const weekdays = restricted(cron.weekdays, 7);

  const [onlyDay] = days ?? [];
  const [onlyMonth] = months ?? [];
  if (time.kind === "clock" && !weekdays && days?.length === 1 && months?.length === 1) {
    return `At ${time.text} on ${MONTH_NAMES[onlyMonth! - 1]} ${ordinal(onlyDay!)}`;
  }

  const dayParts: string[] = [];
  if (days) dayParts.push(`the ${joinList(days.map(ordinal))}${months ? "" : " of the month"}`);
  if (weekdays) dayParts.push(describeWeekdays(weekdays));
  // Cron runs when either day field matches, so two restricted day fields read as "or".
  const dayText = dayParts.join(" or ");
  const monthText = months
    ? `${dayText ? "," : ""} in ${joinList(months.map((month) => MONTH_NAMES[month - 1] ?? String(month)))}`
    : "";

  if (time.kind === "recurring") {
    return `${time.text}${dayText ? ` on ${dayText}` : ""}${monthText}`;
  }
  if (!dayText) return `${monthText ? "Every day" : "Daily"} at ${time.text}${monthText}`;
  if (weekdays && !days) {
    const label = describeWeekdays(weekdays);
    const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
    return `${capitalized} at ${time.text}${monthText}`;
  }
  return `At ${time.text} on ${dayText}${monthText}`;
}

export const AUTOMATION_WEEKDAY_NAMES = WEEKDAY_NAMES;
