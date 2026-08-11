import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cacheRequestForDigest,
  digestEmail,
  handleRequest,
} from "../src/bookings";

const CLIENT_DIGEST =
  "f93fa2e5fb59200922637972bb68e780754fc45c0b8f4f9467779f9dc8e3dfe1";
const CLIENT_CACHE_URL = `https://booking-cache.invalid/v1/${CLIENT_DIGEST}`;

function testEnv(
  limit: (options: { key: string }) => Promise<{ success: boolean }> = async () => ({
    success: true,
  }),
): Env {
  return {
    CALCOM_API_KEY: "test-cal-api-key",
    BOOKINGS_RATE_LIMITER: { limit },
    ASSETS: {
      fetch: async () => new Response("asset"),
    },
  } as unknown as Env;
}

async function invoke(
  request: Request,
  env = testEnv(),
  now: () => Date = () => new Date("2026-08-11T18:00:00.000Z"),
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await handleRequest(request, env, ctx, now);
  await waitOnExecutionContext(ctx);
  return response;
}

function bookingFixture(input: {
  uid: string;
  title: string;
  status: string;
  start: string;
  end: string;
  slug: string;
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
        email: "client@example.com",
        displayEmail: "client@example.com",
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

describe("GET /api/bookings request validation", () => {
  it("rejects non-GET methods without calling Cal.com", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await invoke(
      new Request("https://example.com/api/bookings?email=a@example.com", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["", "not-an-email", "a@b", "a b@example.com"])(
    "rejects invalid email %j",
    async (email) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const response = await invoke(
        new Request(
          `https://example.com/api/bookings?email=${encodeURIComponent(email)}`,
        ),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Enter a valid email address.",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
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

  it("rate limits by email digest before contacting Cal.com", async () => {
    const keys: string[] = [];
    const env = testEnv(async ({ key }) => {
      keys.push(key);
      return { success: false };
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Cal.com must not be called"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await invoke(
      new Request(
        "https://example.com/api/bookings?email=client%40example.com",
      ),
      env,
    );

    expect(keys).toEqual([
      CLIENT_DIGEST,
    ]);
    expect(keys[0]).not.toContain("client@example.com");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
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

  it("uses a digest-only cache key and serves a private response after rate limiting", async () => {
    const cacheRequest = cacheRequestForDigest(CLIENT_DIGEST);
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
    const env = testEnv(async ({ key }) => {
      rateLimitKeys.push(key);
      return { success: true };
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Cal.com must not be called on a cache hit"));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await invoke(
      new Request(
        "https://example.com/api/bookings?email=client%40example.com",
      ),
      env,
    );

    expect(rateLimitKeys).toEqual([CLIENT_DIGEST]);
    expect(fetchSpy).not.toHaveBeenCalled();
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
});

describe("GET /api/bookings Cal.com projection", () => {
  it("queries both future statuses and returns only deduplicated public fields in start order", async () => {
    const requests: Request[] = [];
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
      const status = new URL(request.url).searchParams.get("status");

      return Response.json({
        status: "success",
        data:
          status === "upcoming"
            ? [accepted, cancelled]
            : [pending, accepted],
        pagination: { nextCursor: null, hasMore: false },
      });
    });

    const response = await invoke(
      new Request(
        "https://example.com/api/bookings?email=%20CLIENT%40example.com%20",
      ),
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

    expect(requests).toHaveLength(2);
    const urls = requests.map((request) => new URL(request.url));
    expect(urls.map((url) => url.searchParams.get("status")).sort()).toEqual([
      "unconfirmed",
      "upcoming",
    ]);
    expect(
      urls.every(
        (url) => url.searchParams.get("attendeeEmail") === "client@example.com",
      ),
    ).toBe(true);
    expect(
      urls.every(
        (url) =>
          url.searchParams.get("afterStart") === "2026-08-11T18:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      urls.every((url) => url.searchParams.get("sortStart") === "asc"),
    ).toBe(true);
    expect(urls.every((url) => url.searchParams.get("limit") === "100")).toBe(
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
      cacheRequestForDigest(CLIENT_DIGEST),
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

    const response = await invoke(
      new Request(
        "https://example.com/api/bookings?email=client%40example.com",
      ),
    );

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
