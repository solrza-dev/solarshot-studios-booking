import { DurableObject } from "cloudflare:workers";

export type RateLimitDecision = {
  allowed: boolean;
  retryAfter: number;
};

const IP_LIMIT = 10;
const CREDENTIAL_LIMIT = 5;
const CAL_CALL_LIMIT = 90;
const SHARD_EVENT_LIMIT = 120;
const WINDOW_MS = 60_000;

type RateScope = "ip" | "credential";

function assertDigest(keyDigest: string): void {
  if (!/^[a-f0-9]{64}$/.test(keyDigest)) {
    throw new Error("invalid_rate_limit_key");
  }
}

function rejected(oldestAt: number, nowMs: number): RateLimitDecision {
  return {
    allowed: false,
    retryAfter: Math.max(
      1,
      Math.min(60, Math.ceil((oldestAt + WINDOW_MS - nowMs) / 1_000)),
    ),
  };
}

export class BookingRequestLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rate_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL CHECK (scope IN ('ip', 'credential')),
          key_digest TEXT NOT NULL,
          occurred_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS rate_events_lookup
          ON rate_events (scope, key_digest, occurred_at);
        CREATE INDEX IF NOT EXISTS rate_events_expiry
          ON rate_events (occurred_at)
      `);
    });
  }

  checkIp(keyDigest: string): Promise<RateLimitDecision> {
    return this.check("ip", keyDigest, IP_LIMIT);
  }

  checkCredential(keyDigest: string): Promise<RateLimitDecision> {
    return this.check("credential", keyDigest, CREDENTIAL_LIMIT);
  }

  override async alarm(): Promise<void> {
    const nowMs = Date.now();
    this.ctx.storage.transactionSync(() => this.deleteExpired(nowMs));
    await this.armForNextExpiry();
  }

  private async check(
    scope: RateScope,
    keyDigest: string,
    limit: number,
  ): Promise<RateLimitDecision> {
    assertDigest(keyDigest);
    const nowMs = Date.now();
    const decision = this.ctx.storage.transactionSync(() => {
      this.deleteExpired(nowMs);
      const shardEvents = this.ctx.storage.sql
        .exec<{ occurred_at: number }>(
          `SELECT occurred_at
           FROM rate_events
           ORDER BY occurred_at ASC, event_id ASC`,
        )
        .toArray();
      if (shardEvents.length >= SHARD_EVENT_LIMIT) {
        return rejected(shardEvents[0]!.occurred_at, nowMs);
      }
      const events = this.ctx.storage.sql
        .exec<{ occurred_at: number }>(
          `SELECT occurred_at
           FROM rate_events
           WHERE scope = ? AND key_digest = ?
           ORDER BY occurred_at ASC, event_id ASC`,
          scope,
          keyDigest,
        )
        .toArray();

      if (events.length >= limit) {
        return rejected(events[0]!.occurred_at, nowMs);
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO rate_events (scope, key_digest, occurred_at)
         VALUES (?, ?, ?)`,
        scope,
        keyDigest,
        nowMs,
      );
      return { allowed: true, retryAfter: 0 };
    });

    await this.armForNextExpiry();
    return decision;
  }

  private deleteExpired(nowMs: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM rate_events WHERE occurred_at <= ?",
      nowMs - WINDOW_MS,
    );
  }

  private async armForNextExpiry(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ expires_at: number | null }>(
        `SELECT MIN(occurred_at + ?) AS expires_at FROM rate_events`,
        WINDOW_MS,
      )
      .one();
    if (row.expires_at === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(row.expires_at);
    }
  }
}

export class CalApiBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS cal_call_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cal_call_events_expiry
          ON cal_call_events (occurred_at)
      `);
    });
  }

  async reserve(): Promise<RateLimitDecision> {
    const nowMs = Date.now();
    const decision = this.ctx.storage.transactionSync(() => {
      this.deleteExpired(nowMs);
      const events = this.ctx.storage.sql
        .exec<{ occurred_at: number }>(
          `SELECT occurred_at
           FROM cal_call_events
           ORDER BY occurred_at ASC, event_id ASC`,
        )
        .toArray();

      if (events.length >= CAL_CALL_LIMIT) {
        return rejected(events[0]!.occurred_at, nowMs);
      }

      this.ctx.storage.sql.exec(
        "INSERT INTO cal_call_events (occurred_at) VALUES (?)",
        nowMs,
      );
      return { allowed: true, retryAfter: 0 };
    });

    await this.armForNextExpiry();
    return decision;
  }

  override async alarm(): Promise<void> {
    const nowMs = Date.now();
    this.ctx.storage.transactionSync(() => this.deleteExpired(nowMs));
    await this.armForNextExpiry();
  }

  private deleteExpired(nowMs: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM cal_call_events WHERE occurred_at <= ?",
      nowMs - WINDOW_MS,
    );
  }

  private async armForNextExpiry(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ expires_at: number | null }>(
        `SELECT MIN(occurred_at + ?) AS expires_at FROM cal_call_events`,
        WINDOW_MS,
      )
      .one();
    if (row.expires_at === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(row.expires_at);
    }
  }
}
