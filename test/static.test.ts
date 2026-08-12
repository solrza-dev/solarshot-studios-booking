import { describe, expect, it } from "vitest";

import html from "../public/index.html?raw";

describe("static booking page contract", () => {
  it("keeps exactly one dynamically injected Cal.com embed script", () => {
    expect(
      (html.match(/https:\/\/app\.cal\.com\/embed\/embed\.js/g) ?? []).length,
    ).toBe(1);
    expect(html).not.toMatch(
      /<script[^>]+src=["']https:\/\/app\.cal\.com\/embed\/embed\.js/,
    );
  });

  it("provides three My Sessions entry points and an accessible lookup panel", () => {
    expect((html.match(/href="#my-sessions"/g) ?? []).length).toBe(3);
    expect(html).toContain('id="my-sessions-form"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Cash App, Apple Pay, or Zelle");
    expect(html).toContain(
      "Isaiah verifies payment and approves the request",
    );
    expect(html).toContain('fetch("/api/bookings", {');
    expect(html).toContain('method: "POST"');
    expect(html).toContain(
      "turnstileToken: token",
    );
    expect(html).toContain('id="booking-reference"');
    expect(html).toContain("private booking reference from your Cal.com confirmation");
    expect(html).not.toContain("/api/bookings?email=");
  });

  it("renders one explicit managed Turnstile surface for My Sessions", () => {
    expect(
      (
        html.match(
          /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/g,
        ) ?? []
      ).length,
    ).toBe(1);
    expect(html).toContain('id="turnstile-widget"');
    expect(html).toContain('id="turnstile-script"');
    expect(html).toContain("window.__turnstileScriptFailed = true");
    expect(html).toContain('data-sitekey="__TURNSTILE_SITEKEY__"');
    expect(html).toContain('action: "my_sessions"');
    expect(html).toContain("window.turnstile.reset(turnstileWidgetId)");
    expect(html).toContain("turnstileWaitCount >= 200");
    expect(html).toContain("refresh this page and try again");
    expect(html).not.toContain("1x00000000000000000000AA");
    expect(html).not.toContain("TURNSTILE_SECRET");
  });

  it("maps four booking controls to the live Cal.com event types", () => {
    expect((html.match(/<article class="card"/g) ?? []).length).toBe(4);
    expect((html.match(/<button class="chip(?: active)?"/g) ?? []).length).toBe(4);
    expect(
      (
        html.match(
          /solarshot-enterprises-t1k8k7\/artist-consultation/g,
        ) ?? []
      ).length,
    ).toBe(3);
    expect(html).toContain('data-name="Artist Consultation"');
    expect(html).toContain('data-dur="60 min"');
    expect(html).toContain("Not for music work");

    const consultationCard = html.match(
      /<article class="card"[^>]+artist-consultation[\s\S]*?<\/article>/,
    )?.[0];
    expect(consultationCard).toBeDefined();
    expect((consultationCard?.match(/<li>/g) ?? []).length).toBe(5);
    expect(consultationCard).toContain("Web development &amp; websites");
    expect(consultationCard).toContain("Marketing strategy");
    expect(consultationCard).toContain("Merch &amp; product setup");
    expect(consultationCard).toContain("Photo shoots &amp; visual content");
    expect(consultationCard).toContain("Artist launch planning");
    expect(html).toContain(
      "Studio bookings include the beat intake below; Artist Consultation is not for music work.",
    );
    expect(html).not.toContain(
      "Every session is in-person at the studio, fully hands-on, and includes the beat intake below",
    );
  });
});
