# Solarshot Studios Final Booking Features Design

## Status

Revised direction for implementation. Isaiah selected and purchased `solarshotmusic.com` through Porkbun, then directed the entire site and API to move to Cloudflare. The public booking hostname is `studio.solarshotmusic.com`. The similar `solarshopmusic.com` spelling is unregistered and is not part of this project.

## Goal

Complete the four remaining booking features without regressing the working Cal.com embed, and move the complete production site from GitHub Pages to one Cloudflare-managed runtime:

1. Manual payment verification and owner approval for every booking.
2. A Cloudflare-fronted custom hostname with Full (strict) HTTPS.
3. A fourth Artist Consultation event and matching site controls.
4. A privacy-minimized My Sessions lookup backed by a rate-limited Cloudflare Worker.

## Locked Constraints

- Keep Porkbun as registrar for purchases, renewal, registrar lock, and WHOIS privacy. Cloudflare provides authoritative DNS, static hosting, HTTPS, the Worker, secrets, logs, and analytics.
- Make one Cloudflare Worker with Static Assets the production origin for both the site and API. GitHub Pages is no longer the production origin after verified cutover.
- Keep the frontend in the existing single `index.html`.
- Load `https://app.cal.com/embed/embed.js` exactly once, only through the existing bootstrap.
- Do not add Stripe or any payment processor.
- Do not expose Cal.com API keys, payment handles, other attendees, meeting locations, or booking-form answers.
- Do not change existing prices, event durations, or the Tue/Wed/Thu weekly availability, except to create the specified 60-minute consultation on that same schedule.
- Do not hardcode the consultation slug until it has been observed from the live Cal.com event type.

## Architecture

One Cloudflare Worker project becomes the production origin for the complete site. The Worker runs before Static Assets on every path so it can redirect all production HTTP requests before any page or form renders and attach security headers to every HTTPS response. Cloudflare Workers Static Assets still serves the single HTML page. The Worker Custom Domain `studio.solarshotmusic.com` points every path on that hostname to this project; Cloudflare creates the necessary DNS record and certificate automatically after the zone is active.

The current GitHub Pages deployment remains untouched during development and Cloudflare preview testing. It stops being the selected production origin only after the Cloudflare custom hostname passes all acceptance checks. The repository may continue to exist on GitHub as source control, but Cloudflare owns production hosting and operations.

The repository becomes one focused Cloudflare project:

- `public/index.html` — the one canonical site file, moved from the repository root without splitting the frontend.
- `src/index.ts` — default Worker entry point and Durable Object export.
- `src/bookings.ts` — transport enforcement, API request validation, bounded body reading, Cal.com authorization and listing calls, response projection, caching, and error handling.
- `src/rate-limiter.ts` — 256 fixed HMAC-selected rolling request-limit shards plus one fixed rolling Cal.com call-budget Durable Object, all with transactional SQLite events and alarm cleanup.
- `test/index.test.ts` — Worker behavior tests using mocked Cal.com responses and generated binding types.
- `wrangler.jsonc` — non-secret all-path Worker-first Static Assets configuration, Durable Object binding and migration, observability, and the `studio.solarshotmusic.com` custom domain.
- `package.json` and TypeScript configuration — local test, type-check, dry-run, and deploy commands.

Static Assets uses `public/` as its only asset directory and invokes the Worker script first for every path. Production HTTP requests receive an empty `308` to the same HTTPS URL before any asset or API work. HTTPS asset and API responses include `Strict-Transport-Security: max-age=31536000`. `CALCOM_API_KEY` and the independent `RATE_LIMIT_SHARD_KEY` exist only as Cloudflare Worker secrets; no committed file contains either value. The shard key is generated independently and is never reused as the Cal.com credential.

## Domain and Cloudflare Flow

1. Add `solarshotmusic.com` as a Cloudflare full-setup zone and record the two nameservers Cloudflare assigns.
2. Inventory every Porkbun DNS record and confirm whether DNSSEC is enabled. Do not rely on Cloudflare's automatic scan as proof.
3. Reproduce every existing record in Cloudflare before delegation. The new domain currently has no evidenced mail or application records, so no speculative records are added.
4. At Porkbun, turn off DNSSEC first if it is active, then replace the four registrar-default nameservers with the two exact Cloudflare nameservers. This security-sensitive network change requires owner confirmation at the action point.
5. Verify the registry and public resolvers return the assigned Cloudflare nameservers and wait until the zone reports Active.
6. Deploy the complete Worker plus Static Assets to its temporary `workers.dev` URL and pass browser, API, secret, and responsive tests there.
7. Attach `studio.solarshotmusic.com` as the Worker's Custom Domain. Cloudflare creates the DNS record and certificate; no external origin certificate or manual `studio` CNAME is required.
8. Keep the zone encryption mode at Full (strict) and Always Use HTTPS. For this Worker Custom Domain, Cloudflare itself is the origin, so production does not depend on a separate GitHub certificate.

The apex `solarshotmusic.com` remains unassigned unless a redirect to `studio.solarshotmusic.com` is separately required for reachability. Porkbun remains the place to buy and renew the domain and manage registrar privacy; Cloudflare becomes the place to see and manage all operational DNS, hosting, certificates, Worker secrets, logs, analytics, and deployments.

## Cal.com Configuration

All four event types use manual approval. Each booking remains pending until Isaiah verifies payment and approves it.

Every event type contains two required booking questions:

- Payment method: Cash App, Apple Pay, or Zelle.
- Payment handle: the sender's exact `@handle` or identifying payment name.

The three existing event types retain their current duration and availability. The fourth event type is:

- Title: Artist Consultation
- Duration: 60 minutes
- Availability: the same Tue/Wed/Thu schedule already used by the studio event types
- Scope: web development and websites; marketing strategy; merch and product setup; photo shoots and visual content; artist launch planning
- Explicit exclusion: music work

The live Cal.com-generated slug is recorded only after the event is created, then added to the page's fourth card, chip, and `SESSIONS` map entry.

## Frontend Design

The existing dark premium system remains unchanged: Space Grotesk and Inter, `#f5a524` accent, current panel tokens, and the current desktop/mobile breakpoint.

The page receives four bounded additions:

1. The fourth Artist Consultation card, using the exact existing card markup and five approved service bullets.
2. The fourth session-switch chip and matching `SESSIONS` entry.
3. Booking copy explaining the real sequence: choose a slot, submit a pending request, pay by the selected method, Isaiah verifies payment, Isaiah approves, and only then is the slot reserved.
4. A My Sessions entry in header navigation, hero actions, and footer that opens a same-page panel requiring both the booking email and the private booking UID or Cal.com booking link from the confirmation, with four explicit states: idle, loading, results, and generic empty/error.

Results show only title/type, start, end, and status in `America/Chicago`. The empty state never confirms whether an email address exists.

## Worker API Contract

`POST /api/bookings` accepts only `Content-Type: application/json` and a JSON body with one syntactically valid email, the private Cal.com booking UID or booking link from that confirmation, and a fresh Turnstile token:

```json
{
  "email": "client@example.com",
  "bookingReference": "<private Cal.com booking UID or link>",
  "turnstileToken": "<single-use Turnstile response>"
}
```

The request body is read as a bounded stream and cancelled after at most 4,097 bytes; a body larger than 4,096 bytes is rejected without buffering the rest. All other methods return `405`; wrong content type returns `415`; malformed JSON, invalid fields, or a missing/oversized Turnstile token return `400`; Turnstile rejection returns a generic `403`; source or credential rate-limit exhaustion returns `429`; limiter, Siteverify, or Cal-budget availability failure returns a generic `503`; cache or Cal.com failure returns a generic `502`. None includes Cloudflare or Cal.com response contents.

### Implementation safety addendum — 2026-08-11

Live preview verification showed that Cloudflare invocation metadata records the full incoming request URL. To satisfy this specification's existing prohibition on raw customer identifiers in logs, the implemented interface is the JSON `POST` above. `GET`, including the superseded query-string form, returns `405`. Persisted automatic invocation logs are disabled, while privacy-safe custom event logs remain enabled.

The first Durable Object correction used one object per email digest. Independent review rejected that design because arbitrary emails could create unbounded persistent object cardinality. A second single-global-object correction was also rejected: it let any 60 anonymous attempts block every customer and staggered credential windows could grow past its stated row ceiling. The final request limiter routes into exactly 256 fixed SQLite-backed `BookingRequestLimiter` shards. Shard selection is the first byte of `HMAC-SHA-256(RATE_LIMIT_SHARD_KEY, scope + ":" + digest)`, so callers cannot choose a target shard without the dedicated secret. Each shard atomically enforces rolling source and credential limits, rejects before insertion at 120 live events, deletes expired events through platform alarms, survives eviction, owns its clock, and fails closed. A separate fixed `CalApiBudget` object is intentionally global because it represents the one shared upstream API-key quota; it admits no more than 90 actual Cal GETs in any rolling 60 seconds.

The deploy migrates Durable Object lifecycle management to Cloudflare's declarative `exports` configuration. It tombstones the obsolete `BookingRateLimiter` namespace, permanently deleting only rejected-design limiter counters/digests and their storage, and creates fresh `BookingRequestLimiter` plus `CalApiBudget` namespaces. No booking, attendee, payment, or other customer record is stored in these namespaces. The old limiter state is intentionally not recoverable after deployment.

Before listing sessions, the Worker asks Cal.com for the exact `attendeeEmail` plus `bookingUid` pair and verifies that the returned booking is for that attendee, is `accepted` or `pending`, and has not ended. A syntactically malformed reference returns `400` before any limiter or external call. A well-formed nonexistent, cross-email, cancelled, or past reference returns the same successful empty payload as any other unauthorized pair. A valid current pair acts as a replayable bearer capability and authorizes the requested email to list all of its upcoming accepted and pending sessions. The reference is intentionally not one-time so the owner can revisit My Sessions; it must be kept private and not forwarded. It never appears in an incoming or customer-facing URL, cache key, custom log event, or response. It is sent only to Cal.com over HTTPS as the authenticated outbound `bookingUid` filter required for verification.

The Worker calls the current Cal.com v2 endpoint `GET https://api.cal.com/v2/bookings` with:

- `Authorization: Bearer <CALCOM_API_KEY>`
- `cal-api-version: 2026-05-01`
- `attendeeEmail=<normalized email>`
- `afterStart=<current ISO timestamp>`
- `sortStart=asc`
- `limit=100`

Cal.com accepts only one status filter per request. The Worker therefore issues two awaited requests in parallel:

- `status=upcoming` for accepted future bookings.
- `status=unconfirmed` for pending/manual-approval bookings.

The Worker treats Cal.com's `attendeeEmail` filter as a query hint, not an authorization guarantee. It locally requires every returned booking on every page to contain the normalized authorized email in its attendee list, then merges, deduplicates, filters to actual booking statuses `accepted` and `pending`, sorts by start time, and returns only:

```json
{
  "sessions": [
    {
      "title": "Artist Consultation",
      "start": "2026-08-12T17:00:00.000Z",
      "end": "2026-08-12T18:00:00.000Z",
      "status": "pending",
      "eventTypeSlug": "artist-consultation"
    }
  ]
}
```

No attendee objects, booking-form responses, payment handles, meeting URLs, locations, booking identifiers, or host data cross the Worker boundary.

## Abuse and Privacy Controls

- Use exactly 256 fixed HMAC-selected SQLite `BookingRequestLimiter` shards. Each shard stores only rolling-window event timestamps for opaque source-IP or credential digests, rejects before insertion at 120 live events, and deletes expired events through platform alarms. This bounds active limiter storage at 30,720 event rows across fixed object cardinality.
- Apply the controls in this order: bounded parse; per-IP 10 requests in any rolling 60 seconds; mandatory Siteverify; per-credential 5 requests in any rolling 60 seconds; credential-pair cache; global Cal-call reservation; Cal.com.
- Derive the stored source identifier as `HMAC-SHA-256(RATE_LIMIT_SHARD_KEY, "identifier:ip:" + rawIp)` so IPv4 rows and point-in-time recovery are not dictionary-reversible. Select each fixed shard with `HMAC-SHA-256(RATE_LIMIT_SHARD_KEY, scope + ":" + digest)`. Raw IPs, customer identifiers, booking references, Turnstile tokens, and secret keys never enter Durable Object names, rows, custom logs, cache URLs, or responses.
- Use one separate fixed-name `CalApiBudget` Durable Object solely because the Cal.com API key is one shared upstream resource. It atomically admits at most 90 actual outbound Cal.com GETs in any rolling 60 seconds and reserves one slot immediately before every verification or pagination request. Siteverify calls do not spend this budget.
- Do not use aligned minute windows for any final limiter. A burst straddling a clock boundary must still remain within the rolling ceiling.
- Cache only projected minimal JSON or the generic empty result for a short interval after the email/reference pair has been checked. Cache keys contain the credential digest, not the raw email or booking reference.
- Superseding cache correction: the final cache key is the email-plus-reference credential digest, not an email-only digest. Both authorized projected results and generic-empty unauthorized results live for 60 seconds, and every cache lookup still requires a fresh successful Turnstile validation.
- Set `Cache-Control: private, max-age=0` on browser responses so lookup results are not stored in shared browser/proxy caches.
- Return the same successful empty payload for every well-formed but unauthorized pair.
- Emit structured operational logs without email addresses, booking references, digests, API keys, response bodies, or booking details.

### Turnstile security architecture — owner-approved 2026-08-11

The managed Turnstile widget appears only inside the My Sessions form and uses the stable action `my_sessions`. The widget is registered for `studio.solarshotmusic.com`, `localhost`, and `127.0.0.1`; the production Worker nevertheless accepts only a Siteverify response whose hostname exactly equals `studio.solarshotmusic.com`. The public sitekey may be committed in the HTML. `TURNSTILE_SECRET` exists only as a Worker secret.

The browser explicitly renders one widget, retains its widget ID and current token, submits the token in the JSON body, then clears the token and resets that exact widget after every completed request. A retry therefore requires a fresh single-use token. Token, expired, error, and timeout callbacks keep submission disabled and show only generic visitor-safe guidance. A script error or ten-second initialization timeout stops the bounded readiness poll and tells the visitor to check the connection and refresh.

The Worker sends the token and Cloudflare-provided client IP to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with a ten-second timeout. It requires HTTP success, JSON schema validity, `success === true`, action `my_sessions`, and hostname exactly equal to the production hostname. Missing, invalid, expired, replayed, wrong-action, wrong-host, non-JSON, non-2xx, and timeout results all fail closed before cache or Cal.com access. Official Cloudflare dummy sitekeys and secret keys are test-only and are rejected by production configuration.

The first valid lookup for an unknown credential pair spends one Cal reservation, writes a generic-empty 60-second cache entry, and returns the same empty payload used for all well-formed unauthorized pairs. The first valid authorized pair normally spends three Cal reservations: one reference verification plus one page for each of `upcoming` and `unconfirmed`. Pagination spends one reservation per page up to the existing ten-page ceiling per status. A positive or negative cache hit spends zero Cal reservations but still consumes a fresh Turnstile token and the two local rolling limits.

## Error Handling

- Frontend validation catches empty or malformed addresses and empty booking references before a request.
- A second submit aborts the prior browser request and starts a fresh loading state.
- `400` shows an inline correction message without navigating away.
- `429` asks the client to wait briefly and retry.
- Network or upstream errors show a generic temporary-unavailable state.
- Cal.com non-JSON, non-2xx, schema-invalid, cache, limiter, or excessive-pagination responses fail closed and never leak upstream content.
- Partial success is not returned: if either required Cal.com status request fails, the Worker returns a generic error rather than an incomplete session list.

## Verification

Implementation is complete only when all of these pass:

1. Unit tests prove strict content handling, bounded streaming reads, validation, method rejection, authorization-pair behavior, HMAC selection across exactly 256 fixed shards, rolling per-source/per-credential and shard ceilings, rolling 90-call upstream budgeting, platform alarm delivery/re-arm/clear behavior, eviction persistence, Siteverify ordering and failure modes, pagination, local attendee membership on every listing page, both Cal.com listing requests, response projection, deduplication, sorting, privacy filtering, empty state, and fail-closed infrastructure/upstream behavior.
2. Static assertions prove exactly one `embed.js` bootstrap reference and no static script tag.
3. Desktop and sub-900px browser tests prove all four cards and chips select the correct live Cal.com event type.
4. Browser console remains error-free and the DOM contains exactly one embed script.
5. Live Cal.com tests prove each event arrives pending with both payment questions; the consultation test is approved successfully.
6. A current valid email/reference pair returns only that email's upcoming accepted/pending sessions; syntactically malformed input receives the fixed correction response, while well-formed nonexistent, expired, cancelled, and cross-email references all receive the same generic empty presentation.
7. `http://studio.solarshotmusic.com` redirects without rendering the form, while `https://studio.solarshotmusic.com` returns HTTPS 200 with HSTS from the Cloudflare Worker, renders the calendar, and serves the same-origin API route.
8. Cloudflare's dashboard shows the active zone, production Worker deployment, Static Assets, Custom Domain, certificate, Durable Object binding, both secret names, logs, and analytics in the intended account.
9. Secret scanning finds no API key or credential material in the repository or Git history.
10. Only after these checks pass are the implementation commits pushed to `main` and production rechecked after propagation.

## Rollback

- Worker rollback: restore the prior Worker deployment version. Before cutover, the unchanged GitHub Pages URL remains the fallback; after a deliberate retirement, the tagged pre-migration commit remains the recovery source.
- Domain rollback: detach the Worker Custom Domain, restore the exact pre-delegation Porkbun nameserver set only if Cloudflare activation fails, and verify the registry after either direction.
- Hosting rollback: redeploy the last known-good Worker version. Before the migration commit is pushed, the unchanged GitHub Pages URL remains a live fallback; afterward, restore the tagged pre-migration commit to reactivate it if Cloudflare cannot be recovered promptly.
- Cal.com rollback: disable the consultation event and revert only the two added questions/manual-approval toggles after recording pre-change state. Existing event prices, durations, and availability remain untouched.

## Stop Condition

Stop immediately after the production acceptance checks pass and the verified implementation is pushed to `main`. Any apex-domain website, email configuration, analytics, payment processor, authentication layer, additional event type, redesign, or hosting migration requires a new owner-approved scope delta.

## Implementation Evidence Correction — 2026-08-11

The native Rate Limiting binding was replaced after it failed the live deterministic `429` test. Acceptance evidence for `BOOKING_REQUEST_LIMITER` is the committed fixed 256-shard Durable Object configuration and migration, the independent shard-secret name, HMAC/concurrency/boundary/rollover/platform-alarm tests, an exercised production `429`, bounded privacy-safe logs, and the Cloudflare deployment view. The dashboard remains the operational surface for the zone, Worker, deployment, Static Assets, Custom Domain, certificate, Durable Object namespace, secret names, logs, and analytics.
