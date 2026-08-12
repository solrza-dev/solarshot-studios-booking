# Cloudflare Cutover — 2026-08-11

## Authorized Scope

Move the complete Solarshot Studios booking site and same-origin booking API to Cloudflare, with Porkbun retained as registrar. Production hostname: `studio.solarshotmusic.com`. No apex redirect or unrelated DNS records are authorized.

## Account Verification

- Authenticated identity: `solarshotenterprises@gmail.com`
- Cloudflare account: `Solarshotenterprises@gmail.com's Account`
- Account ID suffix: `…a045`
- Result: Pass — the authenticated Cloudflare identity matches the owner-selected Solarshot Enterprises business identity.

## Local Gate

- Worker/static unit tests: 63 passed
- Desktop/mobile browser tests: 12 passed
- TypeScript: Pass
- Generated Worker types: Pass
- Wrangler deployment dry run: Pass

These results apply to the owner-approved Turnstile and rolling-budget release. Cloudflare has exactly one managed `Solarshot Studios My Sessions` widget with public sitekey `0x4AAAAAAENnkbBy0KGKWcVQ` and the approved domains `studio.solarshotmusic.com`, `localhost`, and `127.0.0.1`. The production Worker lists exactly the encrypted secret bindings `CALCOM_API_KEY`, `RATE_LIMIT_SHARD_KEY`, and `TURNSTILE_SECRET`; no secret value was captured. The reviewed release is deployed as version `04482c5d-35f1-460c-91b1-8b87670866ca`.

## Preview

- URL: `https://solarshot-studios-booking.solarshotenterprises.workers.dev`
- Version: `426644a5-85f2-4a95-bdb7-4ad9ec32845d`
- Historical preview secret name: `CALCOM_API_KEY` — present; value was not captured. The secure release additionally requires independently generated `RATE_LIMIT_SHARD_KEY`; only its name will be recorded.
- Static parity: Pass — local and deployed `index.html` SHA-256 `1b45996a933ccb34444a27d98638e2d93aa3ccaa97c6943ffcfd5c0b41d0846e`.
- Cal.com connectivity: Pass — a synthetic unknown address returned `200` with `{"sessions":[]}`.
- Client response privacy: Pass — `private, max-age=0, no-store`.
- Request privacy: Pass after safety correction — the client now sends `POST /api/bookings` with the email in JSON, leaving the request URL free of customer identifiers.
- Log privacy: Pass — the live request URL contained no email, and the custom log contained only event, session count, and cache outcome. Persisted automatic invocation logs are disabled as defense in depth.
- Historical rate-limit acceptance: the preview passed five requests followed by `429`, but its per-email Durable Object design was rejected by independent release review because unique unauthenticated emails could create unbounded persistent objects. This preview is not an approved rollback target.

## DNS and Production

### Pre-cutover Porkbun authoritative snapshot

- Current nameservers: `curitiba.ns.porkbun.com`, `fortaleza.ns.porkbun.com`, `maceio.ns.porkbun.com`, `salvador.ns.porkbun.com`.
- DNSSEC: Porkbun toggle off; registry DNSSEC shows zero records; public `DS` lookup returns no record.
- Public nameserver lookup independently confirms the same four Porkbun nameservers.

| Type | Host | Value | Priority | TTL |
| --- | --- | --- | ---: | ---: |
| ALIAS | `solarshotmusic.com` | `uixie.porkbun.com` | — | 600 |
| CNAME | `*.solarshotmusic.com` | `uixie.porkbun.com` | — | 600 |
| MX | `solarshotmusic.com` | `fwd1.porkbun.com` | 10 | 600 |
| MX | `solarshotmusic.com` | `fwd2.porkbun.com` | 20 | 600 |
| TXT | `solarshotmusic.com` | `v=spf1 include:_spf.porkbun.com ~all` | — | 600 |
| TXT | `_acme-challenge.solarshotmusic.com` | `CVN3r7kCX85CYWZZy9kqBE5tOMmcT2I9Gp5ErxFCGP8` | — | 600 |
| TXT | `_acme-challenge.solarshotmusic.com` | `lZsRKTIx_6gRWjf5_KiJ63FMartCVFb8cjSgG8nRAkw` | — | 600 |

### Current authoritative and production state

- Zone: `solarshotmusic.com`, Free plan, Active.
- Assigned nameservers: `owen.ns.cloudflare.com`, `ziggy.ns.cloudflare.com`.
- Registry/public delegation: verified at `1.1.1.1` as the exact Cloudflare pair above.
- The imported zone contains the preserved effective DNS records, with the Porkbun ALIAS translated to apex A records and `www` materialized from the prior wildcard behavior.
- Email-forwarding MX and SPF records are present on Cloudflare's authoritative server.
- Both Porkbun ACME TXT records are present. Cloudflare added one additional managed ACME value for the Worker Custom Domain certificate.
- Worker Custom Domain: `studio.solarshotmusic.com` attached to `solarshot-studios-booking`.
- Current production Worker version: `04482c5d-35f1-460c-91b1-8b87670866ca`.
- Porkbun remains registrar, WHOIS-privacy, registrar-lock, and renewal provider. Cloudflare is authoritative DNS and production hosting.
- DNSSEC remains off; public `DS` lookup is empty.
- Live MX: priority 10 `fwd1.porkbun.com`, priority 20 `fwd2.porkbun.com`. Live SPF: `v=spf1 include:_spf.porkbun.com ~all`.

### Production acceptance — 2026-08-11

- Deployment: Pass — Cloudflare reconciled `BookingRequestLimiter` and `CalApiBudget`, permanently removed the rejected `BookingRateLimiter` namespace, and activated version `04482c5d-35f1-460c-91b1-8b87670866ca` at 100%.
- HTTP protection: Pass — `http://studio.solarshotmusic.com/` and a non-root static path return `308 Permanent Redirect` to the same HTTPS URL before rendering a form.
- HTTPS protection: Pass — the live page returns `200` and the API's wrong-content-type response returns `415`; both include `Strict-Transport-Security: max-age=31536000`.
- Asset integrity: Pass — after replacing the single runtime-injected public Turnstile sitekey with the source placeholder, live and local `index.html` are byte-identical. The pending marker is absent from production.
- Browser rendering: Pass — the site, current Cal.com availability iframe, and `My Sessions` form render at the production hostname. The managed Turnstile token enabled the form without a visible challenge.
- Private lookup: Pass — a reserved synthetic email/reference pair returned the same generic empty result without exposing booking data.
- Rolling credential limit: Pass — five fresh Turnstile-authorized requests for that pair were allowed; the sixth returned the generic `Too many requests` result. No CAPTCHA was displayed or solved.
- Production bindings: Pass — Wrangler reports exactly `CALCOM_API_KEY`, `RATE_LIMIT_SHARD_KEY`, and `TURNSTILE_SECRET` as encrypted secret names. Values were not read or recorded.

### Release and rollback

Independent release review returned `GO` for the deployed candidate after the complete gate passed. The release adds all-path HTTP redirect/HSTS, email-plus-private-reference authorization, local attendee binding on every listing page, a 4,096-byte bounded request, managed Turnstile, exactly 256 secret-HMAC-selected rolling request-limit shards with 120 live events each, credential-digest positive/negative caching, and one true-rolling 90-call Cal.com budget. The superseded production baseline `9002f1b2-23f8-4424-a31b-ab77029b6b10` served the booking form over HTTP without redirect or HSTS and used the rejected email-only/per-email-object design; it is not a known-good rollback.

1. Application rollback must use this exact reviewed secure release version, never `9002f1b2-23f8-4424-a31b-ab77029b6b10` or the earlier preview.
2. DNS rollback, only if Cloudflare authority itself fails, restores the exact four pre-cutover Porkbun nameservers recorded above: `curitiba.ns.porkbun.com`, `fortaleza.ns.porkbun.com`, `maceio.ns.porkbun.com`, and `salvador.ns.porkbun.com`.
3. DNSSEC remains off during any delegation rollback; verify registry NS, MX, SPF, and empty DS after either direction.
