export type PublicSession = {
  title: string;
  start: string;
  end: string;
  status: "accepted" | "pending";
  eventTypeSlug: string;
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, max-age=0, no-store",
};

const CAL_API = "https://api.cal.com/v2/bookings";
const CAL_API_VERSION = "2026-05-01";

type CalBooking = {
  uid: string;
  title: string;
  start: string;
  end: string;
  status: string;
  eventType: { slug: string };
};

function json(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function normalizeEmail(value: string | null): string | null {
  if (value === null) return null;

  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export async function digestEmail(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function cacheRequestForDigest(digest: string): Request {
  return new Request(`https://booking-cache.invalid/v1/${digest}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBooking(value: unknown): CalBooking {
  if (!isRecord(value) || !isRecord(value.eventType)) {
    throw new Error("cal_invalid_schema");
  }

  const { uid, title, start, end, status } = value;
  const slug = value.eventType.slug;
  if (
    typeof uid !== "string" ||
    typeof title !== "string" ||
    typeof start !== "string" ||
    typeof end !== "string" ||
    typeof status !== "string" ||
    typeof slug !== "string" ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end))
  ) {
    throw new Error("cal_invalid_schema");
  }

  return {
    uid,
    title,
    start,
    end,
    status,
    eventType: { slug },
  };
}

function parseCalResponse(value: unknown): CalBooking[] {
  if (!isRecord(value) || value.status !== "success" || !Array.isArray(value.data)) {
    throw new Error("cal_invalid_schema");
  }

  return value.data.map(parseBooking);
}

async function fetchStatus(
  email: string,
  status: "upcoming" | "unconfirmed",
  env: Env,
  now: Date,
): Promise<CalBooking[]> {
  const url = new URL(CAL_API);
  url.searchParams.set("attendeeEmail", email);
  url.searchParams.set("afterStart", now.toISOString());
  url.searchParams.set("sortStart", "asc");
  url.searchParams.set("limit", "100");
  url.searchParams.set("status", status);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.CALCOM_API_KEY}`,
      "cal-api-version": CAL_API_VERSION,
    },
  });
  if (!response.ok) {
    throw new Error(`cal_upstream_${response.status}`);
  }

  return parseCalResponse(await response.json());
}

function projectSessions(bookings: CalBooking[]): PublicSession[] {
  const unique = new Map<string, CalBooking>();
  for (const booking of bookings) {
    if (
      (booking.status === "accepted" || booking.status === "pending") &&
      !unique.has(booking.uid)
    ) {
      unique.set(booking.uid, booking);
    }
  }

  return Array.from(unique.values())
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
    .map((booking) => ({
      title: booking.title,
      start: booking.start,
      end: booking.end,
      status: booking.status as PublicSession["status"],
      eventTypeSlug: booking.eventType.slug,
    }));
}

function parseCachedSessions(value: unknown): PublicSession[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error("cache_invalid_schema");
  }

  return value.sessions.map((session) => {
    if (!isRecord(session)) {
      throw new Error("cache_invalid_schema");
    }

    const { title, start, end, status, eventTypeSlug } = session;
    const keys = Object.keys(session).sort();
    if (
      keys.join(",") !== "end,eventTypeSlug,start,status,title" ||
      typeof title !== "string" ||
      typeof start !== "string" ||
      typeof end !== "string" ||
      (status !== "accepted" && status !== "pending") ||
      typeof eventTypeSlug !== "string" ||
      !Number.isFinite(Date.parse(start)) ||
      !Number.isFinite(Date.parse(end))
    ) {
      throw new Error("cache_invalid_schema");
    }

    return { title, start, end, status, eventTypeSlug };
  });
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: () => Date = () => new Date(),
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname !== "/api/bookings") {
    return json({ error: "Not found." }, 404);
  }

  if (request.method !== "GET") {
    return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
  }

  const email = normalizeEmail(url.searchParams.get("email"));
  if (!email) {
    return json({ error: "Enter a valid email address." }, 400);
  }

  const emailDigest = await digestEmail(email);
  const { success } = await env.BOOKINGS_RATE_LIMITER.limit({ key: emailDigest });
  if (!success) {
    console.warn(
      JSON.stringify({
        event: "booking_lookup_rate_limited",
        path: "/api/bookings",
      }),
    );
    return json(
      { error: "Too many requests. Please wait briefly and try again." },
      429,
      { "Retry-After": "60" },
    );
  }

  const cacheRequest = cacheRequestForDigest(emailDigest);
  const cachedResponse = await caches.default.match(cacheRequest);
  if (cachedResponse) {
    try {
      const sessions = parseCachedSessions(await cachedResponse.json());
      console.info(
        JSON.stringify({
          event: "booking_lookup_succeeded",
          session_count: sessions.length,
          cache: "hit",
        }),
      );
      return json({ sessions });
    } catch {
      ctx.waitUntil(caches.default.delete(cacheRequest));
    }
  }

  try {
    const lookupTime = now();
    const [upcoming, unconfirmed] = await Promise.all([
      fetchStatus(email, "upcoming", env, lookupTime),
      fetchStatus(email, "unconfirmed", env, lookupTime),
    ]);
    const sessions = projectSessions([...upcoming, ...unconfirmed]);
    const cacheResponse = Response.json(
      { sessions },
      {
        headers: {
          "Cache-Control": "public, max-age=60",
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
    ctx.waitUntil(caches.default.put(cacheRequest, cacheResponse));

    console.info(
      JSON.stringify({
        event: "booking_lookup_succeeded",
        session_count: sessions.length,
        cache: "miss",
      }),
    );
    return json({ sessions });
  } catch {
    console.error(
      JSON.stringify({ event: "cal_lookup_failed", path: "/api/bookings" }),
    );
    return json(
      { error: "Sessions are temporarily unavailable. Please try again shortly." },
      502,
    );
  }
}
