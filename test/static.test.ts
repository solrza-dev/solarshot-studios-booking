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
  });
});
