import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BookingRequestLimiter,
  CalApiBudget,
} from "../src/rate-limiter";

async function limiterRowCount(
  limiter: DurableObjectStub<BookingRequestLimiter>,
): Promise<number> {
  return runInDurableObject(limiter, (_instance, state) =>
    state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM rate_events")
      .one().count,
  );
}

async function budgetRowCount(
  budget: DurableObjectStub<CalApiBudget>,
): Promise<number> {
  return runInDurableObject(budget, (_instance, state) =>
    state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM cal_call_events")
      .one().count,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BookingRequestLimiter rolling windows", () => {
  it("allows exactly ten concurrent requests for one source IP digest", async () => {
    const limiter = env.BOOKING_REQUEST_LIMITER.getByName("concurrent-per-ip");
    const results = await Promise.all(
      Array.from({ length: 11 }, () => limiter.checkIp("a".repeat(64))),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    expect(await limiterRowCount(limiter)).toBe(10);
  });

  it("allows exactly five concurrent requests for one credential digest", async () => {
    const limiter = env.BOOKING_REQUEST_LIMITER.getByName(
      "concurrent-per-credential",
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, () => limiter.checkCredential("b".repeat(64))),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    expect(await limiterRowCount(limiter)).toBe(5);
  });

  it("bounds each fixed shard at 120 live events", async () => {
    const limiter = env.BOOKING_REQUEST_LIMITER.getByName("bounded-shard");
    const results = [];
    for (let index = 0; index < 121; index += 1) {
      results.push(
        await limiter.checkIp(index.toString(16).padStart(64, "0")),
      );
    }

    expect(results.filter((result) => result.allowed)).toHaveLength(120);
    expect(results[120]).toMatchObject({ allowed: false });
    expect(await limiterRowCount(limiter)).toBe(120);
  });

  it("enforces the 59,999ms boundary and admits at exactly 60,000ms", async () => {
    let nowMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const limiter = env.BOOKING_REQUEST_LIMITER.getByName("rolling-boundary");
    const digest = "c".repeat(64);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(limiter.checkIp(digest)).resolves.toMatchObject({
        allowed: true,
      });
    }
    nowMs += 59_999;
    await expect(limiter.checkIp(digest)).resolves.toMatchObject({
      allowed: false,
      retryAfter: 1,
    });
    nowMs += 1;
    await expect(limiter.checkIp(digest)).resolves.toMatchObject({
      allowed: true,
    });
    expect(await limiterRowCount(limiter)).toBe(1);
  });

  it("does not reset a live limit when the clock moves backward", async () => {
    let nowMs = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const limiter = env.BOOKING_REQUEST_LIMITER.getByName("backward-clock");
    const digest = "d".repeat(64);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await limiter.checkCredential(digest);
    }
    nowMs -= 30_000;

    await expect(limiter.checkCredential(digest)).resolves.toMatchObject({
      allowed: false,
    });
    expect(await limiterRowCount(limiter)).toBe(5);
  });

  it("persists limits across eviction and removes expired events by alarm", async () => {
    const limiter = env.BOOKING_REQUEST_LIMITER.getByName("eviction-and-cleanup");
    const digest = "e".repeat(64);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await limiter.checkCredential(digest);
    }

    await evictDurableObject(limiter);
    await expect(limiter.checkCredential(digest)).resolves.toMatchObject({
      allowed: false,
    });

    await runInDurableObject(limiter, async (_instance, state) => {
      state.storage.sql.exec("UPDATE rate_events SET occurred_at = 0");
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(limiter)).toBe(true);
    expect(await limiterRowCount(limiter)).toBe(0);
    await expect(
      runInDurableObject(limiter, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBeNull();
  });

  it("deletes expired events and re-arms for the earliest survivor", async () => {
    const limiter = env.BOOKING_REQUEST_LIMITER.getByName("alarm-survivor");
    const survivorAt = Date.now();

    await runInDurableObject(limiter, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO rate_events (scope, key_digest, occurred_at)
         VALUES ('ip', ?, 0), ('credential', ?, ?)`,
        "f".repeat(64),
        "1".repeat(64),
        survivorAt,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(limiter)).toBe(true);
    const remaining = await runInDurableObject(
      limiter,
      async (_instance, state) => ({
        rows: state.storage.sql
          .exec<{ scope: string; key_digest: string }>(
            "SELECT scope, key_digest FROM rate_events",
          )
          .toArray(),
        alarm: await state.storage.getAlarm(),
      }),
    );

    expect(remaining).toEqual({
      rows: [{ scope: "credential", key_digest: "1".repeat(64) }],
      alarm: survivorAt + 60_000,
    });
  });

  it("rejects malformed digests without persisting raw identifiers", async () => {
    const limiter = env.BOOKING_REQUEST_LIMITER.getByName("invalid-key");
    await expect(
      runInDurableObject(limiter, (instance) =>
        instance.checkIp("203.0.113.42"),
      ),
    ).rejects.toThrow("invalid_rate_limit_key");
    expect(await limiterRowCount(limiter)).toBe(0);
  });
});

describe("CalApiBudget rolling window", () => {
  it("atomically allows ninety reservations and rejects the ninety-first", async () => {
    const budget = env.CAL_API_BUDGET.getByName("global-v1");
    const results = await Promise.all(
      Array.from({ length: 91 }, () => budget.reserve()),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(90);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    expect(await budgetRowCount(budget)).toBe(90);
  });

  it("rejects a boundary-straddling burst until the oldest call reaches 60 seconds", async () => {
    let nowMs = 3_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const budget = env.CAL_API_BUDGET.getByName("cross-boundary");
    for (let call = 0; call < 90; call += 1) {
      await budget.reserve();
    }

    nowMs += 59_999;
    await expect(budget.reserve()).resolves.toMatchObject({
      allowed: false,
      retryAfter: 1,
    });
    nowMs += 1;
    await expect(budget.reserve()).resolves.toMatchObject({ allowed: true });
    expect(await budgetRowCount(budget)).toBe(1);
  });

  it("persists across eviction and clears expired calls through its alarm", async () => {
    const budget = env.CAL_API_BUDGET.getByName("budget-eviction");
    for (let call = 0; call < 90; call += 1) {
      await budget.reserve();
    }
    await evictDurableObject(budget);
    await expect(budget.reserve()).resolves.toMatchObject({ allowed: false });

    await runInDurableObject(budget, async (_instance, state) => {
      state.storage.sql.exec("UPDATE cal_call_events SET occurred_at = 0");
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(budget)).toBe(true);
    expect(await budgetRowCount(budget)).toBe(0);
  });
});
