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

One Cloudflare Worker project becomes the production origin for the complete site. Cloudflare Workers Static Assets serves the single HTML page, while the Worker script handles only `/api/*`. The Worker Custom Domain `studio.solarshotmusic.com` points every path on that hostname to this project; Cloudflare creates the necessary DNS record and certificate automatically after the zone is active.

The current GitHub Pages deployment remains untouched during development and Cloudflare preview testing. It stops being the selected production origin only after the Cloudflare custom hostname passes all acceptance checks. The repository may continue to exist on GitHub as source control, but Cloudflare owns production hosting and operations.

The repository becomes one focused Cloudflare project:

- `public/index.html` — the one canonical site file, moved from the repository root without splitting the frontend.
- `src/index.ts` — API request validation, Cal.com calls, response projection, caching, and error handling.
- `test/index.test.ts` — Worker behavior tests using mocked Cal.com responses and generated binding types.
- `wrangler.jsonc` — non-secret Static Assets configuration, `/api/*` worker-first routing, Rate Limiting binding, observability, and the `studio.solarshotmusic.com` custom domain.
- `package.json` and TypeScript configuration — local test, type-check, dry-run, and deploy commands.

Static Assets uses `public/` as its only asset directory and invokes the Worker script first only for `/api/*`. Ordinary site requests are served directly from Cloudflare's asset layer. `CALCOM_API_KEY` exists only as a Cloudflare Worker secret; no committed file contains it.

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
4. A My Sessions entry in header navigation, hero actions, and footer that opens a same-page panel with an email form and four explicit states: idle, loading, results, and generic empty/error.

Results show only title/type, start, end, and status in `America/Chicago`. The empty state never confirms whether an email address exists.

## Worker API Contract

`GET /api/bookings?email=<address>` accepts one syntactically valid email address after trimming and lowercasing. All other methods return `405`; missing or invalid email returns `400`; rate-limit exhaustion returns `429`; upstream failure returns a generic `502` without Cal.com response contents.

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

The Worker merges, deduplicates, filters to actual booking statuses `accepted` and `pending`, sorts by start time, and returns only:

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

- Use Cloudflare's Rate Limiting binding with a 60-second window.
- Use a SHA-256 digest of the normalized email as the rate-limit key so raw addresses are not sent to the counter binding.
- Cache only the projected minimal JSON for a short interval. Cache keys contain the email digest, not the raw address.
- Set `Cache-Control: private, max-age=0` on browser responses so lookup results are not stored in shared browser/proxy caches.
- Return the same successful empty payload for a valid address with no matching bookings.
- Emit structured operational logs without email addresses, API keys, response bodies, or booking details.

## Error Handling

- Frontend validation catches empty or malformed addresses before a request.
- A second submit aborts the prior browser request and starts a fresh loading state.
- `400` shows an inline correction message without navigating away.
- `429` asks the client to wait briefly and retry.
- Network or upstream errors show a generic temporary-unavailable state.
- Cal.com non-JSON, non-2xx, or schema-invalid responses fail closed and never leak upstream content.
- Partial success is not returned: if either required Cal.com status request fails, the Worker returns a generic error rather than an incomplete session list.

## Verification

Implementation is complete only when all of these pass:

1. Unit tests prove validation, method rejection, rate limiting, both Cal.com requests, response projection, deduplication, sorting, privacy filtering, empty state, and upstream failure behavior.
2. Static assertions prove exactly one `embed.js` bootstrap reference and no static script tag.
3. Desktop and sub-900px browser tests prove all four cards and chips select the correct live Cal.com event type.
4. Browser console remains error-free and the DOM contains exactly one embed script.
5. Live Cal.com tests prove each event arrives pending with both payment questions; the consultation test is approved successfully.
6. A known approved email returns only its upcoming accepted/pending sessions; an unknown email receives the same generic empty presentation.
7. `https://studio.solarshotmusic.com` returns HTTPS 200 from the Cloudflare Worker, renders the calendar, and serves the same-origin API route.
8. Cloudflare's dashboard shows the active zone, production Worker deployment, Static Assets, Custom Domain, certificate, Rate Limiting binding, secret name, logs, and analytics in the intended account.
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

Cloudflare's current Workers Rate Limiting documentation states that Rate Limiting bindings are not visible as dashboard objects. The approved behavior is unchanged. Acceptance evidence for `BOOKINGS_RATE_LIMITER` is the committed Wrangler configuration, an exercised `429` response, and privacy-safe Worker logs. The dashboard remains the operational surface for the zone, Worker, deployment, Static Assets, Custom Domain, certificate, secret name, logs, and analytics.
