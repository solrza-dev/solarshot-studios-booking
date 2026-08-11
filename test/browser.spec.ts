import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("https://app.cal.com/embed/embed.js", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: "",
    });
  });
});

test("validates the lookup email before making a request", async ({ page }) => {
  let apiCalls = 0;
  await page.route("**/api/bookings**", async (route) => {
    apiCalls += 1;
    await route.fulfill({ json: { sessions: [] } });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Find my sessions" }).click();

  await expect(page.locator("#my-sessions-status")).toHaveText(
    "Enter a valid email address.",
  );
  expect(apiCalls).toBe(0);
});

test("shows loading then renders only projected sessions in America/Chicago time", async ({
  page,
}) => {
  let releaseResponse: (() => void) | undefined;
  const responseReady = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/api/bookings**", async (route) => {
    await responseReady;
    await route.fulfill({
      json: {
        sessions: [
          {
            title: "Artist Consultation",
            start: "2026-08-12T19:00:00.000Z",
            end: "2026-08-12T20:00:00.000Z",
            status: "pending",
            eventTypeSlug: "artist-consultation",
            meetingUrl: "https://private-meeting.example/room",
            paymentHandle: "private-handle",
            attendeeEmail: "private@example.com",
          },
          {
            title: "Studio Session — 2 Hours",
            start: "2026-08-13T20:00:00.000Z",
            end: "2026-08-13T22:00:00.000Z",
            status: "accepted",
            eventTypeSlug: "studio-session-2-hours",
          },
        ],
      },
    });
  });
  await page.goto("/");

  await page.locator("#booking-email").fill("client@example.com");
  await page.getByRole("button", { name: "Find my sessions" }).click();
  await expect(page.locator("#my-sessions-status")).toHaveText(
    "Loading your upcoming sessions…",
  );
  releaseResponse?.();

  const results = page.locator("#my-sessions-results");
  await expect(results).toBeVisible();
  await expect(results.locator(".session-result")).toHaveCount(2);
  await expect(results).toContainText("Artist Consultation");
  await expect(results).toContainText("artist-consultation");
  await expect(results).toContainText("Aug 12, 2026, 2:00 PM");
  await expect(results).toContainText("Aug 12, 2026, 3:00 PM");
  await expect(results).toContainText("Pending");
  await expect(results).toContainText("Accepted");
  await expect(results).not.toContainText("private-meeting");
  await expect(results).not.toContainText("private-handle");
  await expect(results).not.toContainText("private@example.com");
});

test("uses fixed empty and error messages", async ({ page }) => {
  const replies = [
    { status: 200, body: { sessions: [] } },
    { status: 400, body: { error: "private upstream detail" } },
    { status: 429, body: { error: "private upstream detail" } },
    { status: 502, body: { error: "private upstream detail" } },
  ];
  await page.route("**/api/bookings**", async (route) => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected lookup request");
    await route.fulfill({ status: reply.status, json: reply.body });
  });
  await page.goto("/");
  await page.locator("#booking-email").fill("client@example.com");
  const submit = page.getByRole("button", { name: "Find my sessions" });
  const status = page.locator("#my-sessions-status");

  await submit.click();
  await expect(status).toHaveText(
    "No upcoming sessions are available to show. Check the email and try again if needed.",
  );

  await submit.click();
  await expect(status).toHaveText("Enter a valid email address.");

  await submit.click();
  await expect(status).toHaveText(
    "Too many requests. Please wait briefly and try again.",
  );

  await submit.click();
  await expect(status).toHaveText(
    "Sessions are temporarily unavailable. Please try again shortly.",
  );
});
