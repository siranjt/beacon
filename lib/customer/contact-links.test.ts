/**
 * Phase E-15.5 — contact-links URL builders.
 *
 * These are the launcher pads from V2CustomerCard chips into the user's
 * email client / phone / HubSpot. A malformed URL silently drops the AM
 * onto a broken page; the bug class is invisible until someone complains.
 * Lock them down at the boundary of every input shape.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildMailto,
  buildTelLink,
  buildHubspotCompanyUrl,
  buildCustomerDetailUrl,
} from "./contact-links";

describe("buildMailto", () => {
  it("uses generic subject when bizname + amName are missing", () => {
    const url = buildMailto("alice@example.com");
    expect(url).toMatch(/^mailto:alice@example\.com\?/);
    expect(url).toMatch(/subject=Quick\+check-in/);
  });

  it("uses bizname-and-am subject when both are provided", () => {
    const url = buildMailto("alice@example.com", {
      bizname: "Acme Spa",
      amName: "Sudha",
    });
    expect(url).toContain("Acme+Spa");
    expect(url).toContain("Sudha");
  });

  it("URL-encodes special chars in subject + body", () => {
    const url = buildMailto("a@b.c", {
      bizname: "Café & Salon",
      amName: "AM",
    });
    // & should become %26, space %20 or +; the URLSearchParams form uses +
    expect(url).not.toContain("&Salon"); // raw & would terminate the query early
    expect(url).toMatch(/Caf%C3%A9/);
  });

  it("falls back to empty body when bizname/amName are partial", () => {
    const onlyBiz = buildMailto("a@b.c", { bizname: "Acme" });
    expect(onlyBiz).toMatch(/body=(?:&|$)/);
    const onlyAm = buildMailto("a@b.c", { amName: "Sudha" });
    expect(onlyAm).toMatch(/body=(?:&|$)/);
  });

  it("always returns a string starting with 'mailto:'", () => {
    expect(buildMailto("x@y.z")).toMatch(/^mailto:/);
    expect(buildMailto("x@y.z", { bizname: "B", amName: "A" })).toMatch(/^mailto:/);
  });
});

describe("buildTelLink", () => {
  it("strips spaces, dashes, parens", () => {
    expect(buildTelLink("(415) 555-1234")).toBe("tel:4155551234");
  });

  it("preserves a leading +", () => {
    expect(buildTelLink("+1 415 555 1234")).toBe("tel:+14155551234");
  });

  it("strips ALL non-digit chars except +", () => {
    expect(buildTelLink("415.555.1234")).toBe("tel:4155551234");
    expect(buildTelLink("415-555-1234 ext 99")).toBe("tel:4155551234");
  });

  it("handles already-clean input as a no-op", () => {
    expect(buildTelLink("4155551234")).toBe("tel:4155551234");
  });

  it("returns 'tel:' on empty / garbage input", () => {
    expect(buildTelLink("")).toBe("tel:");
    expect(buildTelLink("not a phone")).toBe("tel:");
  });
});

describe("buildHubspotCompanyUrl (deprecated path, still in use)", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID;
  });

  it("falls back to ?id= when portal env is unset", () => {
    expect(buildHubspotCompanyUrl("12345")).toBe(
      "https://app.hubspot.com/contacts/?id=12345",
    );
  });

  it("uses portal in path when env is set", () => {
    process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID = "9876";
    expect(buildHubspotCompanyUrl("12345")).toBe(
      "https://app.hubspot.com/contacts/9876/company/12345",
    );
  });

  // Restore original env after test file completes.
  it.skip("[cleanup]", () => {
    if (ORIGINAL) process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID = ORIGINAL;
  });
});

describe("buildCustomerDetailUrl", () => {
  it("builds the internal deep-link path", () => {
    expect(buildCustomerDetailUrl("abc-123")).toBe("/v2/customer/abc-123");
  });

  it("URL-encodes funky entity ids", () => {
    expect(buildCustomerDetailUrl("a b/c")).toBe("/v2/customer/a%20b%2Fc");
  });
});
