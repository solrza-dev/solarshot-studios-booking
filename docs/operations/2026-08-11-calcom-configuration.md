# Cal.com Configuration — 2026-08-11

## Authorized Scope

Configure the three existing Solarshot Studios event types for manual approval and required payment identification, then create one non-music Artist Consultation event with the same availability. This record intentionally excludes credentials, attendee data, payment handles, and booking responses.

## Account

- Business identity: Solarshot Enterprises
- Sign-in identity: `solarshotenterprises@gmail.com`
- Cal.com username: `solarshot-enterprises-t1k8k7`

## Pre-Change State

All three existing events use the `Working hours` availability in `America/Chicago`:

- Tuesday: 12:00 PM–11:00 PM
- Wednesday: 11:00 AM–6:00 PM
- Thursday: 4:00 PM–9:00 PM
- Sunday, Monday, Friday, and Saturday: unavailable

| Event | Live slug | Duration | Requires confirmation | Payment method | Payment handle |
|---|---|---:|---|---|---|
| Mixing & Listening Session | `mixing-listening-session` | 60 minutes | Off | Absent | Absent |
| Studio Session - 2 Hours | `studio-session-2-hours` | 120 minutes | Off | Absent | Absent |
| Studio Session - 4 Hours | `studio-session-4-hours` | 240 minutes | Off | Absent | Absent |

Visible booking questions shared by all three events before the change:

- Your name — required
- Email address — required
- Additional notes — optional
- Add guests — optional
- Reason for reschedule — optional
- How will we handle your beat for this session? — required
- Beat link (YouTube, SoundCloud, or Google Drive) — optional
- Creative direction or reference for live production — optional

The built-in phone and meeting-about questions are hidden.

## Post-Change Read-Back

All four live event types use the same `Working hours` availability and timezone recorded above.

| Event | Live slug | Duration | Requires confirmation | Confirmation mode | Unconfirmed blocks slots | Payment method | Payment handle |
|---|---|---:|---|---|---|---|---|
| Mixing & Listening Session | `mixing-listening-session` | 60 minutes | On | Always | Yes | Required; Cash App, Apple Pay, Zelle | Required |
| Studio Session - 2 Hours | `studio-session-2-hours` | 120 minutes | On | Always | Yes | Required; Cash App, Apple Pay, Zelle | Required |
| Studio Session - 4 Hours | `studio-session-4-hours` | 240 minutes | On | Always | Yes | Required; Cash App, Apple Pay, Zelle | Required |
| Artist Consultation | `artist-consultation` | 60 minutes | On | Always | Yes | Required; Cash App, Apple Pay, Zelle | Required |

The required field identifiers read back as `paymentMethod` and `paymentHandle`. The payment-handle prompt reads: `Enter the sender's exact @handle or identifying payment name`.

Artist Consultation was created as event type ID `6639220`. Its saved public URL was observed directly from Cal.com as:

`https://cal.com/solarshot-enterprises-t1k8k7/artist-consultation`

Its saved description covers web development and websites, marketing strategy, merch and product setup, photo shoots and visual content, and artist launch planning, with the explicit exclusion `Not for music work.` It does not include the studio events' beat-intake questions.

## Public Form Read-Back

| Event slug | Manual-approval language | Required payment method | Required payment handle |
|---|---|---|---|
| `mixing-listening-session` | Pass | Pass | Pass |
| `studio-session-2-hours` | Pass | Pass | Pass |
| `studio-session-4-hours` | Pass | Pass | Pass |
| `artist-consultation` | Pass | Pass | Pass |

No booking was submitted during this configuration read-back.
