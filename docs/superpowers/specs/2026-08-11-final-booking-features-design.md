# Solarshot Studios Final Booking Features Design

## Status

Approved direction for implementation. Isaiah directed execution after selecting and purchasing `solarshotmusic.com` through Porkbun. The public booking hostname is `studio.solarshotmusic.com`.

## Goal

Complete the four remaining booking features without regressing the working Cal.com embed or replacing the existing GitHub Pages deployment:

1. Manual payment verification and owner approval for every booking.
2. A Cloudflare-fronted custom hostname with Full (strict) HTTPS.
3. A fourth Artist Consultation event and matching site controls.
4. A privacy-minimized My Sessions lookup backed by a rate-limited Cloudflare Worker.

## Locked Constraints

- Keep Porkbun as registrar. Cloudflare provides authoritative DNS, proxying, HTTPS, and the Worker.
- Keep GitHub Pages as the static-site origin and retain the existing GitHub Pages URL as a fallback.
- Keep the frontend in the existing single `index.html`.
- Load `https://app.cal.com/embed/embed.js` exactly once, only through the existing bootstrap.
- Do not add Stripe or any payment processor.
- Do not expose Cal.com API keys, payment handles, other attendees, meeting locations, or booking-form answers.
- Do not change existing prices, event durations, or the Tue/Wed/Thu weekly availability, except to create the specified 60-minute consultation on that same schedule.
- Do not hardcode the consultation slug until it has been observed from the live Cal.com event type.

## Architecture

The static site remains on GitHub Pages. GitHub Pages is configured with the custom domain `studio.solarshotmusic.com`, and Cloudflare proxies that hostname to the GitHub Pages origin. A Cloudflare Worker route matches only `studio.solarshotmusic.com/api/bookings*`; every other request passes directly to GitHub Pages.

This retains the known-good site origin and limits the Worker to the one dynamic feature. It also keeps the existing `https://solrza-dev.github.io/solarshot-studios-booking/` deployment available during DNS and certificate propagation.

The repository adds a focused Worker package beside the static page:

- `worker/src/index.ts` — request validation, Cal.com calls, response projection, caching, and error handling.
- `worker/test/index.test.ts` — Worker behavior tests using mocked Cal.com responses and bindings.
- `worker/wrangler.jsonc` — non-secret Worker configuration, Rate Limiting binding, observability, and production route.
- `worker/package.json` and TypeScript configuration — local test, type-check, and deploy commands.

`CALCOM_API_KEY` exists only as a Cloudflare Worker secret. No local committed file contains it.

## Domain and Cloudflare Flow

1. Add `solarshotmusic.com` as a Cloudflare zone and record the two nameservers Cloudflare assigns.
2. At Porkbun, replace the registrar-default nameservers with those exact Cloudflare nameservers. This is an owner-visible network change and must be verified at the registry before proceeding.
3. Add the GitHub Pages custom domain `studio.solarshotmusic.com` and the repository `CNAME` artifact required by GitHub Pages.
4. In Cloudflare DNS, create a temporary DNS-only `studio` CNAME targeting `solrza-dev.github.io`. Wait until GitHub Pages provisions and verifies HTTPS for the custom hostname.
5. Change only that verified `studio` record to proxied, set SSL/TLS mode to Full (strict), enable Always Use HTTPS, and re-check the Cloudflare-to-GitHub origin path before treating the hostname as live.
6. Deploy the Worker first to its temporary `workers.dev` URL, then attach only the `/api/bookings*` production route after its tests pass.

The apex `solarshotmusic.com` is outside this implementation unless a redirect is required to make the selected studio hostname reachable. No email or unrelated DNS records will be invented.

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
7. `https://studio.solarshotmusic.com` returns HTTPS 200, renders the calendar, and serves the Worker API route.
8. The GitHub Pages URL remains HTTPS-reachable after the custom-domain cutover.
9. Secret scanning finds no API key or credential material in the repository or Git history.
10. Only after these checks pass are the implementation commits pushed to `main` and production rechecked after propagation.

## Rollback

- Worker rollback: restore the prior Worker deployment version or detach the `/api/bookings*` route; the static site remains available.
- DNS rollback: set the `studio` record to DNS-only or remove only the newly created `studio` record after recording its exact pre-state.
- GitHub Pages rollback: remove the custom-domain setting and `CNAME` commit; the `github.io` URL remains the fallback.
- Cal.com rollback: disable the consultation event and revert only the two added questions/manual-approval toggles after recording pre-change state. Existing event prices, durations, and availability remain untouched.

## Stop Condition

Stop immediately after the production acceptance checks pass and the verified implementation is pushed to `main`. Any apex-domain website, email configuration, analytics, payment processor, authentication layer, additional event type, redesign, or hosting migration requires a new owner-approved scope delta.
