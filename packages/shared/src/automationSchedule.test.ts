import type { AutomationScheduleTrigger } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  describeCronExpression,
  latestScheduledAt,
  latestTriggerAt,
  nextScheduledAt,
  nextTriggerAt,
  scheduleTriggerToCron,
} from "./automationSchedule.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));

function trigger(overrides: Partial<AutomationScheduleTrigger>): AutomationScheduleTrigger {
  return { type: "schedule", cadence: "daily", hour: 9, minute: 0, weekday: 1, ...overrides };
}

// 2026-09-23 is a Wednesday.
describe("latestScheduledAt", () => {
  it("returns today's time once it has passed, yesterday's before", () => {
    const daily = trigger({ cadence: "daily", hour: 9, minute: 30 });
    expect(iso(latestScheduledAt(daily, at("2026-09-23T10:00:00Z"), "UTC"))).toBe(
      "2026-09-23T09:30:00.000Z",
    );
    expect(iso(latestScheduledAt(daily, at("2026-09-23T09:00:00Z"), "UTC"))).toBe(
      "2026-09-22T09:30:00.000Z",
    );
  });

  it("counts the exact due instant as due", () => {
    const daily = trigger({ cadence: "daily", hour: 9, minute: 0 });
    expect(iso(latestScheduledAt(daily, at("2026-09-23T09:00:00Z"), "UTC"))).toBe(
      "2026-09-23T09:00:00.000Z",
    );
  });

  it("skips weekends for weekday schedules", () => {
    const weekdays = trigger({ cadence: "weekdays", hour: 9, minute: 0 });
    // Monday 08:00 → the previous Friday.
    expect(iso(latestScheduledAt(weekdays, at("2026-09-28T08:00:00Z"), "UTC"))).toBe(
      "2026-09-25T09:00:00.000Z",
    );
  });

  it("uses Sunday as weekday 0 for weekly schedules", () => {
    const sunday = trigger({ cadence: "weekly", weekday: 0, hour: 12, minute: 0 });
    expect(iso(latestScheduledAt(sunday, at("2026-09-23T10:00:00Z"), "UTC"))).toBe(
      "2026-09-20T12:00:00.000Z",
    );
  });

  it("steps back an hour when this hour's minute is still ahead", () => {
    const hourly = trigger({ cadence: "hourly", minute: 45 });
    expect(iso(latestScheduledAt(hourly, at("2026-09-23T10:15:00Z"), "UTC"))).toBe(
      "2026-09-23T09:45:00.000Z",
    );
  });

  it("reads wall-clock times in the given zone", () => {
    const daily = trigger({ cadence: "daily", hour: 9, minute: 0 });
    // 09:00 in São Paulo (UTC-3) is 12:00 UTC.
    expect(iso(latestScheduledAt(daily, at("2026-09-23T13:00:00Z"), "America/Sao_Paulo"))).toBe(
      "2026-09-23T12:00:00.000Z",
    );
  });
});

describe("nextScheduledAt", () => {
  it("returns the next matching weekday after now", () => {
    const monday = trigger({ cadence: "weekly", weekday: 1, hour: 10, minute: 0 });
    expect(iso(nextScheduledAt(monday, at("2026-09-23T10:00:00Z"), "UTC"))).toBe(
      "2026-09-28T10:00:00.000Z",
    );
  });

  it("never returns now itself", () => {
    const hourly = trigger({ cadence: "hourly", minute: 0 });
    expect(iso(nextScheduledAt(hourly, at("2026-09-23T10:00:00Z"), "UTC"))).toBe(
      "2026-09-23T11:00:00.000Z",
    );
  });
});

describe("describeCronExpression", () => {
  it.each([
    ["0 */2 * * *", "Every 2 hours"],
    ["0 */3 * * 2,4,5", "Every 3 hours on Tuesday, Thursday, and Friday"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["* * * * *", "Every minute"],
    ["5 * * * *", "Every hour at :05"],
    ["15,45 * * * *", "Every hour at :15 and :45"],
    ["30 9 * * 1-5", "Weekdays at 09:30"],
    ["0 0 * * 0,6", "Weekends at 00:00"],
    ["0 9 * * 1", "Monday at 09:00"],
    ["0 12 * * 2-4", "Tuesday through Thursday at 12:00"],
    // Two times of day, not "every 8 hours starting at 09:00".
    ["0 9,17 * * *", "Daily at 09:00 and 17:00"],
    ["0 1-23/2 * * *", "Every 2 hours starting at 01:00"],
    ["0 9-17 * * 1-5", "Every hour from 09:00 to 17:00 on weekdays"],
    ["*/10 9-17 * * *", "Every 10 minutes from 09:00 to 17:50"],
    ["0 9 1 * *", "At 09:00 on the 1st of the month"],
    ["0 9 1,15 1,7 *", "At 09:00 on the 1st and 15th, in January and July"],
    ["0 0 1 1 *", "At 00:00 on January 1st"],
  ])("reads %s as %s", (expression, label) => {
    expect(describeCronExpression(expression)).toBe(label);
  });

  it("rejects anything but five valid fields", () => {
    expect(describeCronExpression("not cron")).toBeNull();
    expect(describeCronExpression("0 0 * * * *")).toBeNull();
    expect(describeCronExpression("61 * * * *")).toBeNull();
  });
});

describe("cron triggers", () => {
  const everyTwoHours = { type: "cron", expression: "0 */2 * * *" } as const;

  it("counts the current minute as due and looks strictly ahead for the next run", () => {
    expect(iso(latestTriggerAt(everyTwoHours, at("2026-09-23T10:00:30Z"), "UTC"))).toBe(
      "2026-09-23T10:00:00.000Z",
    );
    expect(iso(latestTriggerAt(everyTwoHours, at("2026-09-23T11:59:00Z"), "UTC"))).toBe(
      "2026-09-23T10:00:00.000Z",
    );
    expect(iso(nextTriggerAt(everyTwoHours, at("2026-09-23T10:00:00Z"), "UTC"))).toBe(
      "2026-09-23T12:00:00.000Z",
    );
  });

  it("converts presets to the same schedule", () => {
    for (const preset of [
      trigger({ cadence: "hourly", minute: 15 }),
      trigger({ cadence: "daily", hour: 7, minute: 30 }),
      trigger({ cadence: "weekdays", hour: 9, minute: 0 }),
      trigger({ cadence: "weekly", weekday: 5, hour: 16, minute: 45 }),
    ]) {
      const cron = { type: "cron", expression: scheduleTriggerToCron(preset) } as const;
      const now = at("2026-09-23T10:07:00Z");
      expect(nextTriggerAt(cron, now, "UTC")).toBe(nextScheduledAt(preset, now, "UTC"));
    }
  });
});
