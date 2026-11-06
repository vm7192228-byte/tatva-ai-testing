import { describe, expect, it } from "vitest";
import { classifyAuthBootstrap } from "../../public/codeforge/auth-bootstrap.js";

describe("auth bootstrap state classification", () => {
  it("accepts a verified user", () => {
    expect(classifyAuthBootstrap({ ok: true, status: 200 }, { user: { id: "user-1" } })).toBe("authenticated");
  });

  it("recognizes a successful signed-out response", () => {
    expect(classifyAuthBootstrap({ ok: true, status: 200 }, { user: null })).toBe("signed-out");
  });

  it("does not turn a transient Auth 503 into a signed-out state", () => {
    expect(classifyAuthBootstrap({ ok: false, status: 503 }, { error: "AUTH_UNAVAILABLE" })).toBe("unavailable");
  });

  it("preserves session state on rate limits and unexpected failures", () => {
    expect(classifyAuthBootstrap({ ok: false, status: 429 }, {})).toBe("unavailable");
    expect(classifyAuthBootstrap({ ok: false, status: 502 }, {})).toBe("unavailable");
    expect(classifyAuthBootstrap({ ok: false, status: 403 }, {})).toBe("unavailable");
  });

  it("treats an explicit unauthorized response as signed out", () => {
    expect(classifyAuthBootstrap({ ok: false, status: 401 }, {})).toBe("signed-out");
  });

  it("treats a network failure as unavailable", () => {
    expect(classifyAuthBootstrap(null, null)).toBe("unavailable");
  });
});


describe("billing status outage preservation", () => {
  it("keeps the last verified entitlement during an Auth outage", async () => {
    const { preserveSubscriptionStatus } = await import("../../public/codeforge/auth-bootstrap.js");
    const current = { loaded: true, paid: true, planCode: "pro_monthly", expiresAt: "2030-01-01T00:00:00Z" };
    expect(preserveSubscriptionStatus({ ok: false, status: 503 }, { error: "AUTH_UNAVAILABLE" }, current)).toBe(current);
  });

  it("does not downgrade billing state when the request cannot reach the server", async () => {
    const { preserveSubscriptionStatus } = await import("../../public/codeforge/auth-bootstrap.js");
    const current = { loaded: true, paid: true, planCode: "creator_monthly", expiresAt: null };
    expect(preserveSubscriptionStatus(null, {}, current)).toBe(current);
  });

  it("replaces the entitlement only after a successful status response", async () => {
    const { preserveSubscriptionStatus } = await import("../../public/codeforge/auth-bootstrap.js");
    const current = { loaded: false, paid: false, planCode: null, expiresAt: null };
    expect(preserveSubscriptionStatus({ ok: true, status: 200 }, { paid: true, planCode: "pro_monthly" }, current)).toEqual({
      loaded: true, paid: true, planCode: "pro_monthly", expiresAt: null,
    });
  });
});


describe("auth welcome visibility", () => {
  it("opens welcome for a verified signed-out session", async () => {
    const { shouldOpenAuthWelcome } = await import("../../public/codeforge/auth-bootstrap.js");
    expect(shouldOpenAuthWelcome(null, false)).toBe(true);
  });

  it("does not present the welcome screen during a temporary Auth outage", async () => {
    const { shouldOpenAuthWelcome } = await import("../../public/codeforge/auth-bootstrap.js");
    expect(shouldOpenAuthWelcome(null, true)).toBe(false);
  });

  it("never presents the sign-in welcome over an authenticated session", async () => {
    const { shouldOpenAuthWelcome } = await import("../../public/codeforge/auth-bootstrap.js");
    expect(shouldOpenAuthWelcome({ email: "alpha@example.test" }, false)).toBe(false);
  });
});
