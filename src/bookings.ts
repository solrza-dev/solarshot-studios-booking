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
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
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
  attendeeEmails: string[];
};

type LookupCredentials = {
  email: string;
  bookingReference: string;
  turnstileToken: string;
};

type LookupBodyResult =
  | { ok: true; credentials: LookupCredentials }
  | { ok: false; unsupportedMediaType: boolean };

type TurnstileVerificationResult = "verified" | "rejected" | "unavailable";

const MAX_BODY_BYTES = 4_096;
const MAX_TURNSTILE_TOKEN_LENGTH = 2_048;
const TURNSTILE_SITEVERIFY =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_ACTION = "my_sessions";
const PRODUCTION_HOSTNAME = "studio.solarshotmusic.com";
const TURNSTILE_DUMMY_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);
const TURNSTILE_DUMMY_SITEKEYS = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);
const TURNSTILE_REJECTION_CODES = new Set([
  "missing-input-response",
  "invalid-input-response",
  "timeout-or-duplicate",
]);

class CalBudgetError extends Error {}

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

export function normalizeBookingReference(value: string | null): string | null {
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return null;

  let candidate = trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !/(^|\.)cal\.com$/i.test(url.hostname)) {
      return null;
    }
    const pathSegments = url.pathname.split("/").filter(Boolean);
    candidate =
      url.searchParams.get("bookingUid") ??
      url.searchParams.get("uid") ??
      pathSegments.at(-1) ??
      "";
  } catch {
    // A bare Cal.com booking UID is the normal input.
  }

  return /^[A-Za-z0-9_-]{8,128}$/.test(candidate) ? candidate : null;
}

async function readBoundedBody(request: Request): Promise<string | null> {
  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_BODY_BYTES
  ) {
    await request.body?.cancel();
    return null;
  }

  if (request.body === null) return null;

  let reader: ReadableStreamBYOBReader;
  try {
    reader = request.body.getReader({ mode: "byob" });
  } catch {
    await request.body.cancel();
    return null;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received <= MAX_BODY_BYTES) {
      const capacity = Math.min(256, MAX_BODY_BYTES + 1 - received);
      const { value, done } = await reader.read(new Uint8Array(capacity));
      if (done) break;
      if (value === undefined) return null;

      const chunk = new Uint8Array(value);
      chunks.push(chunk.slice());
      received += chunk.byteLength;
    }

    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function credentialsFromRequest(request: Request): Promise<LookupBodyResult> {
  const mediaType = request.headers
    .get("Content-Type")
    ?.split(";")
    .at(0)
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return { ok: false, unsupportedMediaType: true };
  }

  const rawBody = await readBoundedBody(request);
  if (rawBody === null) return { ok: false, unsupportedMediaType: false };

  try {
    const body: unknown = JSON.parse(rawBody);
    if (
      !isRecord(body) ||
      typeof body.email !== "string" ||
      typeof body.bookingReference !== "string" ||
      typeof body.turnstileToken !== "string"
    ) {
      return { ok: false, unsupportedMediaType: false };
    }

    const email = normalizeEmail(body.email);
    const bookingReference = normalizeBookingReference(body.bookingReference);
    const turnstileToken = body.turnstileToken.trim();
    if (
      !email ||
      !bookingReference ||
      turnstileToken.length === 0 ||
      turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH
    ) {
      return { ok: false, unsupportedMediaType: false };
    }

    return {
      ok: true,
      credentials: { email, bookingReference, turnstileToken },
    };
  } catch {
    return { ok: false, unsupportedMediaType: false };
  }
}

export async function digestEmail(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function keyedDigest(
  scope: "ip",
  value: string,
  shardKey: string,
): Promise<string> {
  if (value.length === 0 || value.length > 128 || shardKey.length < 32) {
    throw new Error("invalid_keyed_digest_input");
  }
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(shardKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(`identifier:${scope}:${value}`),
  );
  return Array.from(new Uint8Array(mac), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function rateLimitShardName(
  scopedDigest: string,
  shardKey: string,
): Promise<string> {
  if (!/^(ip|credential):[a-f0-9]{64}$/.test(scopedDigest) || shardKey.length < 32) {
    throw new Error("invalid_rate_limit_shard_input");
  }

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(shardKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      hmacKey,
      new TextEncoder().encode(scopedDigest),
    ),
  );
  return rateLimitShardNameFromByte(mac[0]!);
}

export function rateLimitShardNameFromByte(byte: number): string {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
    throw new Error("invalid_rate_limit_shard_byte");
  }
  return `shard-${byte.toString(16).padStart(2, "0")}`;
}

export async function withSecurityHeaders(
  response: Response,
  env?: Env,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  if (
    env &&
    headers.get("Content-Type")?.toLowerCase().includes("text/html")
  ) {
    const sitekey: string =
      typeof env.TURNSTILE_SITEKEY === "string" ? env.TURNSTILE_SITEKEY : "";
    if (
      sitekey.length === 0 ||
      sitekey === "TURNSTILE_SITEKEY_PENDING" ||
      (env.ENVIRONMENT === "production" &&
        TURNSTILE_DUMMY_SITEKEYS.has(sitekey))
    ) {
      return json(
        { error: "Site configuration is temporarily unavailable." },
        503,
      );
    }
    const html = (await response.text()).replaceAll(
      "__TURNSTILE_SITEKEY__",
      sitekey,
    );
    headers.delete("Content-Length");
    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function cacheRequestForDigest(digest: string): Request {
  return new Request(`https://booking-cache.invalid/v1/${digest}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function verifyTurnstile(
  token: string,
  clientIp: string | null,
  env: Env,
): Promise<TurnstileVerificationResult> {
  const hostnameConfig =
    typeof env.TURNSTILE_HOSTNAMES === "string"
      ? env.TURNSTILE_HOSTNAMES
      : "";
  const secret =
    typeof env.TURNSTILE_SECRET === "string" ? env.TURNSTILE_SECRET : "";
  const expectedHostnames = new Set(
    hostnameConfig
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
  );
  const hostnamesAreSafe =
    env.ENVIRONMENT === "production"
      ? expectedHostnames.size === 1 && expectedHostnames.has(PRODUCTION_HOSTNAME)
      : expectedHostnames.size > 0 &&
        Array.from(expectedHostnames).every(
          (hostname) => hostname === "localhost" || hostname === "127.0.0.1",
        );
  if (
    !clientIp ||
    clientIp.length > 128 ||
    secret.length === 0 ||
    !hostnamesAreSafe ||
    (env.ENVIRONMENT === "production" &&
      TURNSTILE_DUMMY_SECRETS.has(secret))
  ) {
    return "unavailable";
  }

  try {
    const response = await fetch(TURNSTILE_SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: clientIp,
      }),
    });
    if (!response.ok) return "unavailable";

    const result: unknown = await response.json();
    if (!isRecord(result) || typeof result.success !== "boolean") {
      return "unavailable";
    }
    if (result.success === false) {
      const errorCodes = result["error-codes"];
      if (
        !Array.isArray(errorCodes) ||
        errorCodes.length === 0 ||
        !errorCodes.every((code) => typeof code === "string")
      ) {
        return "unavailable";
      }
      return errorCodes.every((code) => TURNSTILE_REJECTION_CODES.has(code))
        ? "rejected"
        : "unavailable";
    }
    if (
      typeof result.action !== "string" ||
      typeof result.hostname !== "string"
    ) {
      return "unavailable";
    }
    return result.action === TURNSTILE_ACTION &&
      expectedHostnames.has(result.hostname.toLowerCase())
      ? "verified"
      : "rejected";
  } catch {
    return "unavailable";
  }
}

async function reserveCalCall(env: Env): Promise<void> {
  try {
    const budget = env.CAL_API_BUDGET.getByName("global-v1");
    const decision = await budget.reserve();
    if (!decision.allowed) throw new CalBudgetError("cal_budget_exhausted");
  } catch (error) {
    if (error instanceof CalBudgetError) throw error;
    throw new CalBudgetError("cal_budget_unavailable");
  }
}

async function fetchCal(url: URL, env: Env): Promise<Response> {
  await reserveCalCall(env);
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${env.CALCOM_API_KEY}`,
      "cal-api-version": CAL_API_VERSION,
    },
  });
}

function parseBooking(value: unknown): CalBooking {
  if (!isRecord(value) || !isRecord(value.eventType)) {
    throw new Error("cal_invalid_schema");
  }

  const { uid, title, start, end, status, attendees } = value;
  const slug = value.eventType.slug;
  if (
    typeof uid !== "string" ||
    typeof title !== "string" ||
    typeof start !== "string" ||
    typeof end !== "string" ||
    typeof status !== "string" ||
    typeof slug !== "string" ||
    !Array.isArray(attendees) ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end))
  ) {
    throw new Error("cal_invalid_schema");
  }

  const attendeeEmails = attendees.map((attendee) => {
    if (!isRecord(attendee) || typeof attendee.email !== "string") {
      throw new Error("cal_invalid_schema");
    }
    return attendee.email.trim().toLowerCase();
  });

  return {
    uid,
    title,
    start,
    end,
    status,
    eventType: { slug },
    attendeeEmails,
  };
}

function parseCalResponse(value: unknown): CalBooking[] {
  if (!isRecord(value) || value.status !== "success" || !Array.isArray(value.data)) {
    throw new Error("cal_invalid_schema");
  }

  return value.data.map(parseBooking);
}

function parseCalPage(value: unknown): {
  bookings: CalBooking[];
  hasMore: boolean;
  nextCursor: string | null;
} {
  if (
    !isRecord(value) ||
    value.status !== "success" ||
    !Array.isArray(value.data) ||
    !isRecord(value.pagination) ||
    typeof value.pagination.hasMore !== "boolean" ||
    (value.pagination.nextCursor !== null &&
      typeof value.pagination.nextCursor !== "string")
  ) {
    throw new Error("cal_invalid_schema");
  }

  return {
    bookings: value.data.map(parseBooking),
    hasMore: value.pagination.hasMore,
    nextCursor: value.pagination.nextCursor,
  };
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

  const bookings: CalBooking[] = [];
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const response = await fetchCal(url, env);
    if (!response.ok) {
      throw new Error(`cal_upstream_${response.status}`);
    }

    const page = parseCalPage(await response.json());
    bookings.push(...page.bookings);
    if (!page.hasMore) return bookings;
    if (!page.nextCursor) throw new Error("cal_invalid_schema");
    url.searchParams.set("cursor", page.nextCursor);
  }

  throw new Error("cal_pagination_limit");
}

async function verifyBookingReference(
  email: string,
  bookingReference: string,
  env: Env,
  now: Date,
): Promise<boolean> {
  const url = new URL(CAL_API);
  url.searchParams.set("attendeeEmail", email);
  url.searchParams.set("bookingUid", bookingReference);
  url.searchParams.set("limit", "1");

  const response = await fetchCal(url, env);
  if (!response.ok) throw new Error(`cal_upstream_${response.status}`);

  const bookings = parseCalResponse(await response.json());
  return bookings.some(
    (booking) =>
      booking.uid === bookingReference &&
      booking.attendeeEmails.includes(email) &&
      (booking.status === "accepted" || booking.status === "pending") &&
      Date.parse(booking.end) >= now.getTime(),
  );
}

function projectSessions(bookings: CalBooking[], email: string): PublicSession[] {
  const unique = new Map<string, CalBooking>();
  for (const booking of bookings) {
    if (
      (booking.status === "accepted" || booking.status === "pending") &&
      booking.attendeeEmails.includes(email) &&
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

  if (
    url.protocol === "http:" &&
    url.hostname.toLowerCase() === "studio.solarshotmusic.com"
  ) {
    url.protocol = "https:";
    return new Response(null, {
      status: 308,
      headers: { Location: url.toString() },
    });
  }

  if (url.pathname !== "/api/bookings") {
    return withSecurityHeaders(await env.ASSETS.fetch(request), env);
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405, { Allow: "POST" });
  }

  const lookupBody = await credentialsFromRequest(request);
  if (!lookupBody.ok) {
    return json(
      {
        error: lookupBody.unsupportedMediaType
          ? "Content-Type must be application/json."
          : "Enter a valid email and booking reference.",
      },
      lookupBody.unsupportedMediaType ? 415 : 400,
    );
  }

  const { email, bookingReference, turnstileToken } = lookupBody.credentials;
  const lookupTime = now();
  const credentialDigest = await digestEmail(`${email}\u0000${bookingReference}`);
  const clientIp = request.headers.get("CF-Connecting-IP")?.trim() || null;
  let sourceRateLimit;
  try {
    const clientIpDigest = clientIp
      ? await keyedDigest("ip", clientIp, env.RATE_LIMIT_SHARD_KEY)
      : null;
    if (!clientIpDigest) {
      return json(
        { error: "Verification failed. Please complete the check and try again." },
        403,
      );
    }
    const shardName = await rateLimitShardName(
      `ip:${clientIpDigest}`,
      env.RATE_LIMIT_SHARD_KEY,
    );
    const limiter = env.BOOKING_REQUEST_LIMITER.getByName(shardName);
    sourceRateLimit = await limiter.checkIp(clientIpDigest);
  } catch {
    console.error(
      JSON.stringify({ event: "booking_rate_limiter_failed", path: "/api/bookings" }),
    );
    return json(
      { error: "Sessions are temporarily unavailable. Please try again shortly." },
      503,
    );
  }

  if (!sourceRateLimit.allowed) {
    console.warn(
      JSON.stringify({
        event: "booking_lookup_rate_limited",
        path: "/api/bookings",
      }),
    );
    return json(
      { error: "Too many requests. Please wait briefly and try again." },
      429,
      { "Retry-After": String(sourceRateLimit.retryAfter) },
    );
  }

  const turnstileVerification = await verifyTurnstile(
    turnstileToken,
    clientIp,
    env,
  );
  if (turnstileVerification === "unavailable") {
    console.error(
      JSON.stringify({
        event: "turnstile_verification_unavailable",
        path: "/api/bookings",
      }),
    );
    return json(
      { error: "Sessions are temporarily unavailable. Please try again shortly." },
      503,
    );
  }
  if (turnstileVerification === "rejected") {
    console.warn(
      JSON.stringify({ event: "turnstile_verification_failed", path: "/api/bookings" }),
    );
    return json(
      { error: "Verification failed. Please complete the check and try again." },
      403,
    );
  }

  let credentialRateLimit;
  try {
    const shardName = await rateLimitShardName(
      `credential:${credentialDigest}`,
      env.RATE_LIMIT_SHARD_KEY,
    );
    const limiter = env.BOOKING_REQUEST_LIMITER.getByName(shardName);
    credentialRateLimit = await limiter.checkCredential(credentialDigest);
  } catch {
    console.error(
      JSON.stringify({ event: "booking_rate_limiter_failed", path: "/api/bookings" }),
    );
    return json(
      { error: "Sessions are temporarily unavailable. Please try again shortly." },
      503,
    );
  }

  if (!credentialRateLimit.allowed) {
    console.warn(
      JSON.stringify({ event: "booking_lookup_rate_limited", path: "/api/bookings" }),
    );
    return json(
      { error: "Too many requests. Please wait briefly and try again." },
      429,
      { "Retry-After": String(credentialRateLimit.retryAfter) },
    );
  }

  try {
    const cacheRequest = cacheRequestForDigest(credentialDigest);
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
        await caches.default.delete(cacheRequest);
      }
    }

    const verified = await verifyBookingReference(
      email,
      bookingReference,
      env,
      lookupTime,
    );
    if (!verified) {
      await caches.default.put(
        cacheRequest,
        Response.json(
          { sessions: [] },
          {
            headers: {
              "Cache-Control": "public, max-age=60",
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        ),
      );
      console.info(
        JSON.stringify({
          event: "booking_lookup_succeeded",
          session_count: 0,
          cache: "miss",
        }),
      );
      return json({ sessions: [] });
    }

    const [upcoming, unconfirmed] = await Promise.all([
      fetchStatus(email, "upcoming", env, lookupTime),
      fetchStatus(email, "unconfirmed", env, lookupTime),
    ]);
    const sessions = projectSessions([...upcoming, ...unconfirmed], email);
    const cacheResponse = Response.json(
      { sessions },
      {
        headers: {
          "Cache-Control": "public, max-age=60",
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
    await caches.default.put(cacheRequest, cacheResponse);

    console.info(
      JSON.stringify({
        event: "booking_lookup_succeeded",
        session_count: sessions.length,
        cache: "miss",
      }),
    );
    return json({ sessions });
  } catch (error) {
    if (error instanceof CalBudgetError) {
      console.error(
        JSON.stringify({ event: "cal_budget_unavailable", path: "/api/bookings" }),
      );
      return json(
        { error: "Sessions are temporarily unavailable. Please try again shortly." },
        503,
      );
    }
    console.error(
      JSON.stringify({ event: "cal_lookup_failed", path: "/api/bookings" }),
    );
    return json(
      { error: "Sessions are temporarily unavailable. Please try again shortly." },
      502,
    );
  }
}
