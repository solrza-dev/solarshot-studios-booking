import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cacheRequestForDigest,
  digestEmail,
  handleRequest,
  keyedDigest,
  rateLimitShardName,
  rateLimitShardNameFromByte,
} from "../src/bookings";

const CLIENT_DIGEST =
  "f93fa2e5fb59200922637972bb68e780754fc45c0b8f4f9467779f9dc8e3dfe1";
const CLIENT_CREDENTIAL_DIGEST =
  "73ca1c0d783e4f454f0bf091c639efa486eafa340ac3ff620e8cd3828c59ca8a";
const CLIENT_CACHE_URL =
  `https://booking-cache.invalid/v1/${CLIENT_CREDENTIAL_DIGEST}`;

type TestEnvOptions = {
  checkIp?: (keyDigest: string) => Promise<{
    allowed: boolean;
    retryAfter: number;
  }>;
  checkCredential?: (keyDigest: string) => Promise<{
    allowed: boolean;
    retryAfter: number;
  }>;
  reserve?: () => Promise<{ allowed: boolean; retryAfter: number }>;
  onLimiterName?: (name: string) => void;
  onBudgetName?: (name: string) => void;
};

function testEnv(options: TestEnvOptions = {}): Env {
  const allow = async () => ({ allowed: true, retryAfter: 0 });
  return {
    CALCOM_API_KEY: "test-cal-api-key",
    RATE_LIMIT_SHARD_KEY: "test-rate-limit-shard-key-with-high-entropy",
    TURNSTILE_SECRET: "real-test-turnstile-secret-not-a-dummy-key",
    TURNSTILE_SITEKEY: "production-test-sitekey",
    TURNSTILE_HOSTNAMES: "studio.solarshotmusic.com",
    ENVIRONMENT: "production",
    BOOKING_REQUEST_LIMITER: {
      getByName(name: string) {
        options.onLimiterName?.(name);
        return {
          checkIp: options.checkIp ?? allow,
          checkCredential: options.checkCredential ?? allow,
        };
      },
    },
    CAL_API_BUDGET: {
      getByName(name: string) {
        options.onBudgetName?.(name);
        return { reserve: options.reserve ?? allow };
      },
    },
    ASSETS: {
      fetch: async () => new Response("asset"),
    },
  } as unknown as Env;
}

async function invoke(
  request: Request,
  env = testEnv(),
  now: () => Date = () => new Date("2026-08-11T18:00:00.000Z"),
  siteverify: (request: Request) => Promise<Response> = async () =>
    Response.json({
      success: true,
      hostname: "studio.solarshotmusic.com",
      action: "my_sessions",
    }),
): Promise<Response> {
  const upstreamFetch = globalThis.fetch;
  const routedFetch: typeof fetch = async (input, init) => {
    const outbound = new Request(input, init);
    if (
      outbound.url ===
      "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    ) {
      return siteverify(outbound);
    }
    return upstreamFetch(input, init);
  };
  vi.stubGlobal("fetch", routedFetch);
  const ctx = createExecutionContext();
  try {
    const response = await handleRequest(request, env, ctx, now);
    await waitOnExecutionContext(ctx);
    return response;
  } finally {
    vi.stubGlobal("fetch", upstreamFetch);
  }
}

function bookingRequest(
  email: unknown,
  bookingReference: unknown = "2NtaeaVcKfpmSZ4CthFdfk",
  turnstileToken: unknown = "fresh-turnstile-token",
): Request {
  return new Request("https://example.com/api/bookings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.42",
    },
    body: JSON.stringify({ email, bookingReference, turnstileToken }),
  });
}

function bookingFixture(input: {
  uid: string;
  title: string;
  status: string;
  start: string;
  end: string;
  slug: string;
  attendeeEmail?: string;
}) {
  return {
    id: 123,
    uid: input.uid,
    title: input.title,
    description: "Private planning notes",
    hosts: [
      {
        id: 1,
        name: "Isaiah Matthews",
        email: "owner@example.com",
        displayEmail: "owner@example.com",
        username: "owner",
        timeZone: "America/Chicago",
      },
    ],
    status: input.status,
    start: input.start,
    end: input.end,
    duration: 60,
    eventTypeId: 50,
    eventType: { id: 50, slug: input.slug },
    location: "https://private-meeting.example/room",
    absentHost: false,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
    attendees: [
      {
        name: "Private Client",
        email: input.attendeeEmail ?? "client@example.com",
        displayEmail: input.attendeeEmail ?? "client@example.com",
        timeZone: "America/Chicago",
        absent: false,
        language: "en",
        phoneNumber: "+15555550100",
      },
    ],
    bookingFieldsResponses: {
      paymentMethod: "Zelle",
      paymentHandle: "private-handle",
    },
    cancellationReason: null,
    cancelledByEmail: null,
    reschedulingReason: null,
    rescheduledByEmail: null,
    rescheduledFromUid: null,
    rescheduledToUid: null,
    meetingUrl: "https://private-meeting.example/room",
    metadata: { private: "value" },
    rating: null,
    icsUid: `${input.uid}@example.com`,
    guests: ["guest@example.com"],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await caches.default.delete(new Request(CLIENT_CACHE_URL));
});

describe("POST /api/bookings request validation", () => {
  it("rejects GET requests, including legacy query-string emails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await invoke(
      new Request("https://example.com/api/bookings?email=a@example.com"),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without calling Cal.com", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await invoke(
      new Request("https://example.com/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Enter a valid email and booking reference.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects non-JSON content and a missing booking reference", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const wrongType = await invoke(
      new Request("https://example.com/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({
          email: "client@example.com",
          bookingReference: "2NtaeaVcKfpmSZ4CthFdfk",
        }),
      }),
    );
    const missingReference = await invoke(
      bookingRequest("client@example.com", ""),
    );

    expect(wrongType.status).toBe(415);
    expect(missingReference.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires a non-empty Turnstile token no longer than 2,048 characters", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const missing = await invoke(
      bookingRequest("client@example.com", "2NtaeaVcKfpmSZ4CthFdfk", ""),
    );
    const oversized = await invoke(
      bookingRequest(
        "client@example.com",
        "2NtaeaVcKfpmSZ4CthFdfk",
        "x".repeat(2_049),
      ),
    );

    expect(missing.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cancels an oversized streaming body before consuming the whole request", async () => {
    let emittedBytes = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        type: "bytes",
        pull(controller: ReadableStreamDefaultController<Uint8Array>) {
          const chunk = new Uint8Array(256).fill(120);
          emittedBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      } as unknown as UnderlyingSource<Uint8Array>,
    );

    const response = await invoke(
      new Request("https://example.com/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    );

    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(emittedBytes).toBeLessThanOrEqual(4_352);
  });

  it.each(["", "not-an-email", "a@b", "a b@example.com"])(
    "rejects invalid email %j",
    async (email) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const response = await invoke(bookingRequest(email));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Enter a valid email and booking reference.",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe("Turnstile admission ordering", () => {
  it("applies the source-IP limit before Siteverify", async () => {
    let siteverifyCalls = 0;
    let credentialCalls = 0;
    const env = testEnv({
      checkIp: async () => ({ allowed: false, retryAfter: 29 }),
      checkCredential: async () => {
        credentialCalls += 1;
        return { allowed: true, retryAfter: 0 };
      },
    });
    const calFetch = vi.spyOn(globalThis, "fetch");

    const response = await invoke(
      bookingRequest("client@example.com"),
      env,
      undefined,
      async () => {
        siteverifyCalls += 1;
        return Response.json({ success: true });
      },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("29");
    expect(siteverifyCalls).toBe(0);
    expect(credentialCalls).toBe(0);
    expect(calFetch).not.toHaveBeenCalled();
  });

  it("sends secret, token, and Cloudflare client IP and requires exact action and hostname", async () => {
    let siteverifyRequest: Request | undefined;
    const calFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ status: "success", data: [] }),
    );

    const response = await invoke(
      bookingRequest("client@example.com"),
      testEnv(),
      undefined,
      async (request) => {
        siteverifyRequest = request;
        return Response.json({
          success: true,
          hostname: "studio.solarshotmusic.com",
          action: "my_sessions",
        });
      },
    );

    expect(response.status).toBe(200);
    expect(calFetch).toHaveBeenCalledTimes(1);
    expect(siteverifyRequest?.method).toBe("POST");
    expect(siteverifyRequest?.headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const fields = new URLSearchParams(
      new TextDecoder().decode(await siteverifyRequest?.arrayBuffer()),
    );
    expect(fields.get("secret")).toBe(
      "real-test-turnstile-secret-not-a-dummy-key",
    );
    expect(fields.get("response")).toBe("fresh-turnstile-token");
    expect(fields.get("remoteip")).toBe("203.0.113.42");
  });

  it.each([
    [
      "challenge rejection",
      () =>
        Response.json({
          success: false,
          "error-codes": ["invalid-input-response"],
        }),
      403,
      { error: "Verification failed. Please complete the check and try again." },
    ],
    [
      "wrong hostname",
      () =>
        Response.json({
          success: true,
          hostname: "attacker.example",
          action: "my_sessions",
        }),
      403,
      { error: "Verification failed. Please complete the check and try again." },
    ],
    [
      "wrong action",
      () =>
        Response.json({
          success: true,
          hostname: "studio.solarshotmusic.com",
          action: "other_action",
        }),
      403,
      { error: "Verification failed. Please complete the check and try again." },
    ],
    [
      "non-2xx",
      () => new Response("private", { status: 503 }),
      503,
      { error: "Sessions are temporarily unavailable. Please try again shortly." },
    ],
    [
      "non-JSON",
      () => new Response("private", { status: 200 }),
      503,
      { error: "Sessions are temporarily unavailable. Please try again shortly." },
    ],
    [
      "timeout",
      () => Promise.reject(new Error("private timeout")),
      503,
      { error: "Sessions are temporarily unavailable. Please try again shortly." },
    ],
    [
      "invalid secret response",
      () =>
        Response.json({
          success: false,
          "error-codes": ["invalid-input-secret"],
        }),
      503,
      { error: "Sessions are temporarily unavailable. Please try again shortly." },
    ],
    [
      "Turnstile internal error",
      () =>
        Response.json({
          success: false,
          "error-codes": ["internal-error"],
        }),
      503,
      { error: "Sessions are temporarily unavailable. Please try again shortly." },
    ],
  ])(
    "fails closed with the correct status for %s before credential, cache, or Cal.com",
    async (_name, reply, expectedStatus, expectedBody) => {
      let credentialCalls = 0;
      const env = testEnv({
        checkCredential: async () => {
          credentialCalls += 1;
          return { allowed: true, retryAfter: 0 };
        },
      });
      const cacheSpy = vi.spyOn(caches.default, "match");
      const calFetch = vi.spyOn(globalThis, "fetch");
      const response = await invoke(
        bookingRequest("client@example.com"),
        env,
        undefined,
        async () => reply(),
      );

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toEqual(expectedBody);
      expect(credentialCalls).toBe(0);
      expect(cacheSpy).not.toHaveBeenCalled();
      expect(calFetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing Cloudflare client IP and treats a production dummy secret as a configuration failure", async () => {
    const withoutIp = bookingRequest("client@example.com");
    withoutIp.headers.delete("CF-Connecting-IP");
    let siteverifyCalls = 0;
    const missingIp = await invoke(
      withoutIp,
      testEnv(),
      undefined,
      async () => {
        siteverifyCalls += 1;
        return Response.json({ success: true });
      },
    );
    const dummyEnv = testEnv();
    dummyEnv.TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
    const dummy = await invoke(
      bookingRequest("client@example.com"),
      dummyEnv,
      undefined,
      async () => {
        siteverifyCalls += 1;
        return Response.json({ success: true });
      },
    );

    expect(missingIp.status).toBe(403);
    expect(dummy.status).toBe(503);
    await expect(missingIp.json()).resolves.toEqual({
      error: "Verification failed. Please complete the check and try again.",
    });
    await expect(dummy.json()).resolves.toEqual({
      error: "Sessions are temporarily unavailable. Please try again shortly.",
    });
    expect(siteverifyCalls).toBe(0);
  });

  it("requires a fresh Siteverify result when a token is replayed", async () => {
    let siteverifyCalls = 0;
    const calFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ status: "success", data: [] }),
    );
    const verify = async () => {
      siteverifyCalls += 1;
      return Response.json(
        siteverifyCalls === 1
          ? {
              success: true,
              hostname: "studio.solarshotmusic.com",
              action: "my_sessions",
            }
          : { success: false, "error-codes": ["timeout-or-duplicate"] },
      );
    };

    const first = await invoke(
      bookingRequest("client@example.com"),
      testEnv(),
      undefined,
      verify,
    );
    const replay = await invoke(
      bookingRequest("client@example.com"),
      testEnv(),
      undefined,
      verify,
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(siteverifyCalls).toBe(2);
    expect(calFetch).toHaveBeenCalledTimes(1);
  });
});

describe("site-wide transport security", () => {
  it("redirects HTTP before serving assets and adds HSTS to HTTPS assets and API errors", async () => {
    let assetCalls = 0;
    const assetUrls: string[] = [];
    let limiterCalls = 0;
    const env = testEnv({
      checkIp: async () => {
        limiterCalls += 1;
        return { allowed: true, retryAfter: 0 };
      },
      checkCredential: async () => {
        limiterCalls += 1;
        return { allowed: true, retryAfter: 0 };
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    env.ASSETS = {
      fetch: async (input: Request) => {
        assetCalls += 1;
        assetUrls.push(new Request(input).url);
        return new Response("secure asset", {
          headers: { "Content-Type": "text/html" },
        });
      },
    } as unknown as Fetcher;

    const redirect = await invoke(
      new Request("http://studio.solarshotmusic.com/path?kept=yes"),
      env,
    );
    const asset = await invoke(new Request("https://example.com/"), env);
    const postRedirect = await invoke(
      new Request("http://studio.solarshotmusic.com/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "client@example.com",
          bookingReference: "2NtaeaVcKfpmSZ4CthFdfk",
        }),
      }),
      env,
    );
    const apiError = await invoke(
      new Request("https://example.com/api/bookings"),
      env,
    );

    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("Location")).toBe(
      "https://studio.solarshotmusic.com/path?kept=yes",
    );
    expect(await redirect.text()).toBe("");
    expect(postRedirect.status).toBe(308);
    expect(postRedirect.headers.get("Location")).toBe(
      "https://studio.solarshotmusic.com/api/bookings",
    );
    expect(await postRedirect.text()).toBe("");
    expect(limiterCalls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(assetCalls).toBe(1);
    expect(assetUrls).toEqual(["https://example.com/"]);
    expect(await asset.text()).toBe("secure asset");
    expect(asset.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000",
    );
    expect(apiError.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000",
    );
  });

  it("injects only the configured public sitekey into HTML and blocks pending or dummy production keys", async () => {
    const htmlAsset = async () =>
      new Response('<div data-sitekey="__TURNSTILE_SITEKEY__"></div>', {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    const readyEnv = testEnv();
    readyEnv.ASSETS = { fetch: htmlAsset } as unknown as Fetcher;
    const ready = await invoke(new Request("https://example.com/"), readyEnv);

    const pendingEnv = testEnv();
    Reflect.set(pendingEnv, "TURNSTILE_SITEKEY", "TURNSTILE_SITEKEY_PENDING");
    pendingEnv.ASSETS = { fetch: htmlAsset } as unknown as Fetcher;
    const pending = await invoke(new Request("https://example.com/"), pendingEnv);

    const dummyEnv = testEnv();
    Reflect.set(dummyEnv, "TURNSTILE_SITEKEY", "1x00000000000000000000AA");
    dummyEnv.ASSETS = { fetch: htmlAsset } as unknown as Fetcher;
    const dummy = await invoke(new Request("https://example.com/"), dummyEnv);

    expect(ready.status).toBe(200);
    expect(await ready.text()).toBe(
      '<div data-sitekey="production-test-sitekey"></div>',
    );
    expect(pending.status).toBe(503);
    expect(dummy.status).toBe(503);
  });
});

describe("booking lookup privacy controls", () => {
  it("hashes normalized email into a deterministic non-reversible lookup key", async () => {
    const digest = await digestEmail("client@example.com");

    expect(digest).toBe(
      CLIENT_DIGEST,
    );
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain("client");
    expect(digest).not.toContain("@");
  });

  it("routes only through 256 fixed shard names selected by a dedicated HMAC key", async () => {
    const allNames = Array.from({ length: 256 }, (_, byte) =>
      rateLimitShardNameFromByte(byte),
    );
    const digest = "73ca1c0d783e4f454f0bf091c639efa486eafa340ac3ff620e8cd3828c59ca8a";
    const first = await rateLimitShardName(`credential:${digest}`, "a".repeat(32));
    const repeated = await rateLimitShardName(
      `credential:${digest}`,
      "a".repeat(32),
    );
    const rekeyed = await rateLimitShardName(
      `credential:${digest}`,
      "b".repeat(32),
    );
    const ipScoped = await rateLimitShardName(`ip:${digest}`, "a".repeat(32));

    expect(new Set(allNames).size).toBe(256);
    expect(allNames.at(0)).toBe("shard-00");
    expect(allNames.at(255)).toBe("shard-ff");
    expect(first).toBe(repeated);
    expect(rekeyed).not.toBe(first);
    expect(ipScoped).not.toBe(first);
    expect(first).toMatch(/^shard-[a-f0-9]{2}$/);
    expect(first).not.toContain(digest);
    await expect(
      rateLimitShardName(`credential:${digest}`, "short-key"),
    ).rejects.toThrow(
      "invalid_rate_limit_shard_input",
    );
    await expect(rateLimitShardName(digest, "a".repeat(32))).rejects.toThrow(
      "invalid_rate_limit_shard_input",
    );
  });

  it("stores a keyed source identifier that cannot be recovered by plain IPv4 hashing", async () => {
    const source = "203.0.113.42";
    const shardKey = "test-rate-limit-shard-key-with-high-entropy";
    const persisted = await keyedDigest("ip", source, shardKey);
    const repeated = await keyedDigest("ip", source, shardKey);
    const rekeyed = await keyedDigest("ip", source, "z".repeat(32));
    const enumerablePlainDigest = await digestEmail(`ip\u0000${source}`);

    expect(persisted).toBe(repeated);
    expect(persisted).not.toBe(rekeyed);
    expect(persisted).not.toBe(enumerablePlainDigest);
    expect(persisted).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted).not.toContain(source);
    await expect(keyedDigest("ip", source, "short")).rejects.toThrow(
      "invalid_keyed_digest_input",
    );
  });

  it("rate limits by credential digest after Siteverify and before Cal.com", async () => {
    const keys: string[] = [];
    const checkedKeys: string[] = [];
    const env = testEnv({
      checkCredential: async (keyDigest) => {
        checkedKeys.push(keyDigest);
        return { allowed: false, retryAfter: 37 };
      },
      onLimiterName: (name) => keys.push(name),
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Cal.com must not be called"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await invoke(bookingRequest("client@example.com"), env);

    expect(keys).toHaveLength(2);
    expect(keys.every((key) => /^shard-[a-f0-9]{2}$/.test(key))).toBe(true);
    expect(keys.join()).not.toContain("client@example.com");
    expect(keys.join()).not.toContain("2NtaeaVcKfpmSZ4CthFdfk");
    expect(checkedKeys).toHaveLength(1);
    expect(checkedKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(checkedKeys[0]).not.toContain("client@example.com");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("37");
    await expect(response.json()).resolves.toEqual({
      error: "Too many requests. Please wait briefly and try again.",
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      JSON.stringify({
        event: "booking_lookup_rate_limited",
        path: "/api/bookings",
      }),
    );
  });

  it("fails closed without exposing limiter errors when the Durable Object is unavailable", async () => {
    const env = testEnv({
      checkIp: async () => {
        throw new Error("private limiter failure for client@example.com");
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Cal.com must not be called"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await invoke(bookingRequest("client@example.com"), env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Sessions are temporarily unavailable. Please try again shortly.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({
        event: "booking_rate_limiter_failed",
        path: "/api/bookings",
      }),
    );
  });

  it.each([
    ["a missing shard secret", undefined],
    ["a short shard secret", "short"],
  ])("fails closed for %s before Siteverify, cache, or Cal.com", async (_name, secret) => {
    const env = testEnv();
    Reflect.set(env, "RATE_LIMIT_SHARD_KEY", secret);
    let siteverifyCalls = 0;
    const cacheSpy = vi.spyOn(caches.default, "match");
    const calFetch = vi.spyOn(globalThis, "fetch");
    const response = await invoke(
      bookingRequest("client@example.com"),
      env,
      undefined,
      async () => {
        siteverifyCalls += 1;
        return Response.json({ success: true });
      },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=0, no-store",
    );
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000",
    );
    await expect(response.json()).resolves.toEqual({
      error: "Sessions are temporarily unavailable. Please try again shortly.",
    });
    expect(siteverifyCalls).toBe(0);
    expect(cacheSpy).not.toHaveBeenCalled();
    expect(calFetch).not.toHaveBeenCalled();
  });

  it("fails closed with private headers when cache infrastructure is unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(caches.default, "match").mockRejectedValue(
      new Error("private cache failure"),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        status: "success",
        data: [
          bookingFixture({
            uid: "2NtaeaVcKfpmSZ4CthFdfk",
            title: "Authorized booking",
            status: "accepted",
            start: "2026-08-12T19:00:00.000Z",
            end: "2026-08-12T20:00:00.000Z",
            slug: "artist-consultation",
          }),
        ],
        pagination: { nextCursor: null, hasMore: false },
      }),
    );

    const response = await invoke(bookingRequest("client@example.com"));

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=0, no-store",
    );
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000",
    );
    await expect(response.json()).resolves.toEqual({
      error: "Sessions are temporarily unavailable. Please try again shortly.",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: "cal_lookup_failed", path: "/api/bookings" }),
    );
  });

  it("fails closed when a credential cache write is unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(caches.default, "put").mockRejectedValue(
      new Error("private cache write failure"),
    );
    const calFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ status: "success", data: [] }),
    );

    const response = await invoke(bookingRequest("client@example.com"));

    expect(response.status).toBe(502);
    expect(calFetch).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      error: "Sessions are temporarily unavailable. Please try again shortly.",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: "cal_lookup_failed", path: "/api/bookings" }),
    );
  });

  it("fails closed before Cal.com when the rolling call budget is unavailable or exhausted", async () => {
    const calFetch = vi.spyOn(globalThis, "fetch");
    const unavailable = await invoke(
      bookingRequest("client@example.com"),
      testEnv({ reserve: async () => Promise.reject(new Error("private")) }),
    );
    const exhausted = await invoke(
      bookingRequest("client@example.com"),
      testEnv({
        reserve: async () => ({ allowed: false, retryAfter: 60 }),
      }),
    );

    expect(unavailable.status).toBe(503);
    expect(exhausted.status).toBe(503);
    expect(calFetch).not.toHaveBeenCalled();
  });

  it("uses a digest-only cache key and serves a private response after rate limiting", async () => {
    const cacheRequest = cacheRequestForDigest(CLIENT_CREDENTIAL_DIGEST);
    expect(cacheRequest.url).toBe(CLIENT_CACHE_URL);
    expect(cacheRequest.url).not.toContain("client@example.com");

    const cachedSessions = {
      sessions: [
        {
          title: "Artist Consultation",
          start: "2026-08-12T19:00:00.000Z",
          end: "2026-08-12T20:00:00.000Z",
          status: "pending",
          eventTypeSlug: "artist-consultation",
        },
      ],
    };
    await caches.default.put(
      cacheRequest,
      Response.json(cachedSessions, {
        headers: {
          "Cache-Control": "public, max-age=60",
          "Content-Type": "application/json; charset=utf-8",
        },
      }),
    );

    const rateLimitKeys: string[] = [];
    let budgetReservations = 0;
    const env = testEnv({
      onLimiterName: (name) => rateLimitKeys.push(name),
      reserve: async () => {
        budgetReservations += 1;
        return { allowed: true, retryAfter: 0 };
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        status: "success",
        data: [
          bookingFixture({
            uid: "2NtaeaVcKfpmSZ4CthFdfk",
            title: "Authorized booking",
            status: "accepted",
            start: "2026-08-12T19:00:00.000Z",
            end: "2026-08-12T20:00:00.000Z",
            slug: "artist-consultation",
          }),
        ],
        pagination: { nextCursor: null, hasMore: false },
      }),
    );
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await invoke(bookingRequest("client@example.com"), env);

    expect(rateLimitKeys).toHaveLength(2);
    expect(rateLimitKeys.every((key) => /^shard-[a-f0-9]{2}$/.test(key))).toBe(
      true,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(budgetReservations).toBe(0);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=0, no-store",
    );
    await expect(response.json()).resolves.toEqual(cachedSessions);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      JSON.stringify({
        event: "booking_lookup_succeeded",
        session_count: 1,
        cache: "hit",
      }),
    );
  });

  it("caches a generic empty credential result for 60 seconds after fresh challenges", async () => {
    let budgetReservations = 0;
    let siteverifyCalls = 0;
    const env = testEnv({
      reserve: async () => {
        budgetReservations += 1;
        return { allowed: true, retryAfter: 0 };
      },
    });
    const calFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ status: "success", data: [] }),
    );
    const verify = async () => {
      siteverifyCalls += 1;
      return Response.json({
        success: true,
        hostname: "studio.solarshotmusic.com",
        action: "my_sessions",
      });
    };

    const first = await invoke(
      bookingRequest("client@example.com"),
      env,
      undefined,
      verify,
    );
    const second = await invoke(
      bookingRequest("client@example.com"),
      env,
      undefined,
      verify,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ sessions: [] });
    await expect(second.json()).resolves.toEqual({ sessions: [] });
    expect(siteverifyCalls).toBe(2);
    expect(calFetch).toHaveBeenCalledTimes(1);
    expect(budgetReservations).toBe(1);
    const cached = await caches.default.match(
      cacheRequestForDigest(CLIENT_CREDENTIAL_DIGEST),
    );
    expect(cached?.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("never performs a ninety-first Cal.com fetch", async () => {
    let reservations = 0;
    const env = testEnv({
      reserve: async () => {
        reservations += 1;
        return { allowed: reservations <= 90, retryAfter: 60 };
      },
    });
    vi.spyOn(caches.default, "put").mockResolvedValue(undefined);
    const calFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(new Request(input, init).url);
        const uid = url.searchParams.get("bookingUid");
        return uid
          ? Response.json({
              status: "success",
              data: [
                bookingFixture({
                  uid,
                  title: "Authorized reference",
                  status: "accepted",
                  start: "2026-08-12T19:00:00.000Z",
                  end: "2026-08-12T20:00:00.000Z",
                  slug: "artist-consultation",
                }),
              ],
            })
          : Response.json({
              status: "success",
              data: [],
              pagination: { nextCursor: null, hasMore: false },
            });
      });

    const responses = [];
    for (let index = 0; index < 31; index += 1) {
      responses.push(
        await invoke(
          bookingRequest(
            "client@example.com",
            `Reference${index.toString().padStart(8, "0")}`,
          ),
          env,
        ),
      );
    }

    expect(responses.slice(0, 30).every((response) => response.status === 200)).toBe(
      true,
    );
    expect(responses[30]?.status).toBe(503);
    expect(reservations).toBe(91);
    expect(calFetch).toHaveBeenCalledTimes(90);
  });
});

describe("POST /api/bookings Cal.com projection", () => {
  it("returns the same empty result for a reference that does not belong to the email", async () => {
    const requests: Request[] = [];
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        status: "success",
        data: [],
        pagination: { nextCursor: null, hasMore: false },
      });
    });

    const response = await invoke(
      bookingRequest("client@example.com", "wrongPairReference123"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sessions: [] });
    expect(requests).toHaveLength(1);
    const upstreamUrl = new URL(requests.at(0)!.url);
    expect(upstreamUrl.searchParams.get("attendeeEmail")).toBe(
      "client@example.com",
    );
    expect(upstreamUrl.searchParams.get("bookingUid")).toBe(
      "wrongPairReference123",
    );
    expect(infoSpy).toHaveBeenCalledWith(
      JSON.stringify({
        event: "booking_lookup_succeeded",
        session_count: 0,
          cache: "miss",
      }),
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(
      "wrongPairReference123",
    );
    expect(
      await caches.default.match(
        cacheRequestForDigest(CLIENT_CREDENTIAL_DIGEST),
      ),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "a cancelled reference",
      email: "client@example.com",
      status: "cancelled",
      start: "2026-08-12T19:00:00.000Z",
      end: "2026-08-12T20:00:00.000Z",
    },
    {
      name: "an expired reference",
      email: "client@example.com",
      status: "accepted",
      start: "2026-08-10T19:00:00.000Z",
      end: "2026-08-10T20:00:00.000Z",
    },
    {
      name: "a reference belonging to another email",
      email: "other@example.com",
      status: "accepted",
      start: "2026-08-12T19:00:00.000Z",
      end: "2026-08-12T20:00:00.000Z",
    },
  ])("returns the same empty result for $name", async (scenario) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        status: "success",
        data: [
          bookingFixture({
            uid: "2NtaeaVcKfpmSZ4CthFdfk",
            title: "Private reference booking",
            status: scenario.status,
            start: scenario.start,
            end: scenario.end,
            slug: "artist-consultation",
          }),
        ],
        pagination: { nextCursor: null, hasMore: false },
      }),
    );

    const response = await invoke(bookingRequest(scenario.email));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sessions: [] });
  });

  it("walks Cal.com cursors for every upcoming session", async () => {
    const first = bookingFixture({
      uid: "page-one",
      title: "First page",
      status: "accepted",
      start: "2026-08-12T19:00:00.000Z",
      end: "2026-08-12T20:00:00.000Z",
      slug: "artist-consultation",
    });
    const second = bookingFixture({
      uid: "page-two",
      title: "Second page",
      status: "accepted",
      start: "2026-08-13T19:00:00.000Z",
      end: "2026-08-13T20:00:00.000Z",
      slug: "studio-session-2-hours",
    });
    const authorized = bookingFixture({
      uid: "2NtaeaVcKfpmSZ4CthFdfk",
      title: "Reference booking",
      status: "accepted",
      start: "2026-08-14T19:00:00.000Z",
      end: "2026-08-14T20:00:00.000Z",
      slug: "artist-consultation",
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.searchParams.has("bookingUid")) {
        return Response.json({
          status: "success",
          data: [authorized],
          pagination: { nextCursor: null, hasMore: false },
        });
      }
      if (url.searchParams.get("status") === "unconfirmed") {
        return Response.json({
          status: "success",
          data: [],
          pagination: { nextCursor: null, hasMore: false },
        });
      }
      if (!url.searchParams.has("cursor")) {
        return Response.json({
          status: "success",
          data: [first],
          pagination: { nextCursor: "next-page", hasMore: true },
        });
      }
      return Response.json({
        status: "success",
        data: [second],
        pagination: { nextCursor: null, hasMore: false },
      });
    });

    const response = await invoke(bookingRequest("client@example.com"));
    await expect(response.json()).resolves.toEqual({
      sessions: [
        {
          title: "First page",
          start: "2026-08-12T19:00:00.000Z",
          end: "2026-08-12T20:00:00.000Z",
          status: "accepted",
          eventTypeSlug: "artist-consultation",
        },
        {
          title: "Second page",
          start: "2026-08-13T19:00:00.000Z",
          end: "2026-08-13T20:00:00.000Z",
          status: "accepted",
          eventTypeSlug: "studio-session-2-hours",
        },
      ],
    });
  });

  it("drops listing results for other attendees on every Cal.com page", async () => {
    const authorized = bookingFixture({
      uid: "2NtaeaVcKfpmSZ4CthFdfk",
      title: "Reference booking",
      status: "accepted",
      start: "2026-08-14T19:00:00.000Z",
      end: "2026-08-14T20:00:00.000Z",
      slug: "artist-consultation",
    });
    const own = bookingFixture({
      uid: "own-page-one",
      title: "Client session",
      status: "accepted",
      start: "2026-08-12T19:00:00.000Z",
      end: "2026-08-12T20:00:00.000Z",
      slug: "recording-session",
    });
    const foreignPageOne = bookingFixture({
      uid: "foreign-page-one",
      title: "Another attendee first page",
      status: "accepted",
      start: "2026-08-12T20:00:00.000Z",
      end: "2026-08-12T21:00:00.000Z",
      slug: "mixing-session",
      attendeeEmail: "other@example.com",
    });
    const foreignPageTwo = bookingFixture({
      uid: "foreign-page-two",
      title: "Another attendee second page",
      status: "pending",
      start: "2026-08-13T20:00:00.000Z",
      end: "2026-08-13T21:00:00.000Z",
      slug: "artist-consultation",
      attendeeEmail: "other@example.com",
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.searchParams.has("bookingUid")) {
        return Response.json({ status: "success", data: [authorized] });
      }
      if (url.searchParams.get("status") === "unconfirmed") {
        return Response.json({
          status: "success",
          data: [],
          pagination: { nextCursor: null, hasMore: false },
        });
      }
      if (!url.searchParams.has("cursor")) {
        return Response.json({
          status: "success",
          data: [own, foreignPageOne],
          pagination: { nextCursor: "next-page", hasMore: true },
        });
      }
      return Response.json({
        status: "success",
        data: [foreignPageTwo],
        pagination: { nextCursor: null, hasMore: false },
      });
    });

    const response = await invoke(bookingRequest("client@example.com"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessions: [
        {
          title: "Client session",
          start: "2026-08-12T19:00:00.000Z",
          end: "2026-08-12T20:00:00.000Z",
          status: "accepted",
          eventTypeSlug: "recording-session",
        },
      ],
    });
  });

  it("fails closed when Cal.com listing pagination exceeds ten pages", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let fetchCount = 0;
    let budgetReservations = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      fetchCount += 1;
      const url = new URL(new Request(input, init).url);
      if (url.searchParams.has("bookingUid")) {
        return Response.json({
          status: "success",
          data: [
            bookingFixture({
              uid: "2NtaeaVcKfpmSZ4CthFdfk",
              title: "Reference booking",
              status: "accepted",
              start: "2026-08-14T19:00:00.000Z",
              end: "2026-08-14T20:00:00.000Z",
              slug: "artist-consultation",
            }),
          ],
        });
      }

      return Response.json({
        status: "success",
        data: [],
        pagination: {
          nextCursor: `cursor-${fetchCount}`,
          hasMore: true,
        },
      });
    });

    const response = await invoke(
      bookingRequest("client@example.com"),
      testEnv({
        reserve: async () => {
          budgetReservations += 1;
          return { allowed: true, retryAfter: 0 };
        },
      }),
    );

    expect(response.status).toBe(502);
    expect(fetchCount).toBe(21);
    expect(budgetReservations).toBe(21);
    await expect(response.json()).resolves.toEqual({
      error: "Sessions are temporarily unavailable. Please try again shortly.",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: "cal_lookup_failed", path: "/api/bookings" }),
    );
  });

  it("queries both future statuses and returns only deduplicated public fields in start order", async () => {
    const requests: Request[] = [];
    let budgetReservations = 0;
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const accepted = bookingFixture({
      uid: "accepted-uid",
      title: "Recording Session",
      status: "accepted",
      start: "2026-08-13T20:00:00.000Z",
      end: "2026-08-13T22:00:00.000Z",
      slug: "recording-session",
    });
    const pending = bookingFixture({
      uid: "pending-uid",
      title: "Artist Consultation",
      status: "pending",
      start: "2026-08-12T19:00:00.000Z",
      end: "2026-08-12T20:00:00.000Z",
      slug: "artist-consultation",
    });
    const authorized = bookingFixture({
      uid: "2NtaeaVcKfpmSZ4CthFdfk",
      title: "Reference booking",
      status: "accepted",
      start: "2026-08-14T19:00:00.000Z",
      end: "2026-08-14T20:00:00.000Z",
      slug: "artist-consultation",
    });
    const cancelled = bookingFixture({
      uid: "cancelled-uid",
      title: "Cancelled Session",
      status: "cancelled",
      start: "2026-08-12T18:00:00.000Z",
      end: "2026-08-12T19:00:00.000Z",
      slug: "recording-session",
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const requestUrl = new URL(request.url);
      const status = requestUrl.searchParams.get("status");

      return Response.json({
        status: "success",
        data:
          requestUrl.searchParams.has("bookingUid")
            ? [authorized]
            : status === "upcoming"
            ? [accepted, cancelled]
            : [pending, accepted],
        pagination: { nextCursor: null, hasMore: false },
      });
    });

    const response = await invoke(
      bookingRequest(" CLIENT@example.com "),
      testEnv({
        reserve: async () => {
          budgetReservations += 1;
          return { allowed: true, retryAfter: 0 };
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessions: [
        {
          title: "Artist Consultation",
          start: "2026-08-12T19:00:00.000Z",
          end: "2026-08-12T20:00:00.000Z",
          status: "pending",
          eventTypeSlug: "artist-consultation",
        },
        {
          title: "Recording Session",
          start: "2026-08-13T20:00:00.000Z",
          end: "2026-08-13T22:00:00.000Z",
          status: "accepted",
          eventTypeSlug: "recording-session",
        },
      ],
    });

    expect(requests).toHaveLength(3);
    expect(budgetReservations).toBe(3);
    const urls = requests.map((request) => new URL(request.url));
    const statusUrls = urls.filter((url) => url.searchParams.has("status"));
    const verificationUrl = urls.find((url) =>
      url.searchParams.has("bookingUid"),
    );
    expect(statusUrls.map((url) => url.searchParams.get("status")).sort()).toEqual([
      "unconfirmed",
      "upcoming",
    ]);
    expect(verificationUrl?.searchParams.get("bookingUid")).toBe(
      "2NtaeaVcKfpmSZ4CthFdfk",
    );
    expect(
      statusUrls.every(
        (url) => url.searchParams.get("attendeeEmail") === "client@example.com",
      ),
    ).toBe(true);
    expect(
      statusUrls.every(
        (url) =>
          url.searchParams.get("afterStart") === "2026-08-11T18:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      statusUrls.every((url) => url.searchParams.get("sortStart") === "asc"),
    ).toBe(true);
    expect(statusUrls.every((url) => url.searchParams.get("limit") === "100")).toBe(
      true,
    );
    expect(
      requests.every(
        (request) =>
          request.headers.get("Authorization") === "Bearer test-cal-api-key",
      ),
    ).toBe(true);
    expect(
      requests.every(
        (request) =>
          request.headers.get("cal-api-version") === "2026-05-01",
      ),
    ).toBe(true);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      JSON.stringify({
        event: "booking_lookup_succeeded",
        session_count: 2,
        cache: "miss",
      }),
    );

    const cached = await caches.default.match(
      cacheRequestForDigest(CLIENT_CREDENTIAL_DIGEST),
    );
    expect(cached).not.toBeNull();
    expect(cached?.headers.get("Cache-Control")).toBe("public, max-age=60");
    await expect(cached?.json()).resolves.toEqual({
      sessions: [
        {
          title: "Artist Consultation",
          start: "2026-08-12T19:00:00.000Z",
          end: "2026-08-12T20:00:00.000Z",
          status: "pending",
          eventTypeSlug: "artist-consultation",
        },
        {
          title: "Recording Session",
          start: "2026-08-13T20:00:00.000Z",
          end: "2026-08-13T22:00:00.000Z",
          status: "accepted",
          eventTypeSlug: "recording-session",
        },
      ],
    });
  });

  it.each([
    {
      name: "a non-2xx upstream response",
      reply: (status: string) =>
        new Response(
          `private upstream error for client@example.com with ${status} and test-cal-api-key`,
          { status: 503 },
        ),
    },
    {
      name: "a non-JSON upstream response",
      reply: () =>
        new Response("private non-json response for client@example.com", {
          status: 200,
        }),
    },
    {
      name: "a booking missing eventType.slug",
      reply: () =>
        Response.json({
          status: "success",
          data: [
            {
              ...bookingFixture({
                uid: "malformed-uid",
                title: "Malformed Session",
                status: "accepted",
                start: "2026-08-13T20:00:00.000Z",
                end: "2026-08-13T21:00:00.000Z",
                slug: "remove-me",
              }),
              eventType: { id: 50 },
            },
          ],
          pagination: { nextCursor: null, hasMore: false },
        }),
    },
    {
      name: "one successful and one failed status request",
      reply: (status: string) =>
        status === "upcoming"
          ? Response.json({
              status: "success",
              data: [
                bookingFixture({
                  uid: "partial-uid",
                  title: "Partial Session",
                  status: "accepted",
                  start: "2026-08-13T20:00:00.000Z",
                  end: "2026-08-13T21:00:00.000Z",
                  slug: "recording-session",
                }),
              ],
              pagination: { nextCursor: null, hasMore: false },
            })
          : new Response("private failure for client@example.com", {
              status: 502,
            }),
    },
  ])("fails closed for $name", async ({ reply }) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const status = new URL(request.url).searchParams.get("status") ?? "";
      return reply(status);
    });

    const response = await invoke(bookingRequest("client@example.com"));

    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=0, no-store",
    );
    await expect(response.json()).resolves.toEqual({
      error: "Sessions are temporarily unavailable. Please try again shortly.",
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify({ event: "cal_lookup_failed", path: "/api/bookings" }),
    );
  });
});
