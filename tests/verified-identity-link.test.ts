import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VerifiedIdentityService } from "../server/verified-identity-service";

describe("verified social identity seam", () => {
  it("links provider-verified accounts to the authenticated wallet and resolves by handle", () => {
    const service = new VerifiedIdentityService();
    const wallet = "0x1111111111111111111111111111111111111111";

    service.link(wallet, {
      platform: "github",
      providerUserId: "583231",
      username: "Arc-Builder",
      verifiedAt: "2026-09-13T10:00:00.000Z",
    });

    assert.equal(service.resolve("github", "arc-builder"), wallet);
    assert.deepEqual(service.profile(wallet).accounts[0], {
      platform: "github",
      username: "arc-builder",
      verified: true,
    });
  });

  it("does not let another wallet claim the same provider account", () => {
    const service = new VerifiedIdentityService();
    const proof = {
      platform: "x" as const,
      providerUserId: "9981",
      username: "arcuser",
      verifiedAt: "2026-09-13T10:00:00.000Z",
    };
    service.link("0x1111111111111111111111111111111111111111", proof);

    assert.throws(
      () => service.link("0x2222222222222222222222222222222222222222", proof),
      /already linked/,
    );
  });

  it("moves a handle that changed hands to the account a fresh sign-in proves holds it now", () => {
    // Audit, 2026-10-06: the new owner of a renamed handle was refused as "taken" while payments kept reaching the old one.
    const service = new VerifiedIdentityService();
    const earlier = "0x1111111111111111111111111111111111111111";
    const now = "0x2222222222222222222222222222222222222222";
    service.link(earlier, { platform: "github", providerUserId: "1001", username: "coolname", verifiedAt: "2026-09-13T10:00:00.000Z" });
    service.link(now, { platform: "github", providerUserId: "2002", username: "CoolName", verifiedAt: "2026-10-06T10:00:00.000Z" });
    assert.equal(service.resolve("github", "coolname"), now);
    assert.deepEqual(service.account(earlier, "github"), { platform: "github", providerUserId: "1001", username: "#1001", verifiedAt: "2026-09-13T10:00:00.000Z" }, "the earlier account stays linked by its ID");
    assert.equal(service.resolve("github", "#1001"), earlier);
    service.link(earlier, { platform: "github", providerUserId: "1001", username: "renamed", verifiedAt: "2026-10-06T11:00:00.000Z" });
    assert.equal(service.resolve("github", "renamed"), earlier, "and takes its new handle at its next sign-in");
    assert.equal(service.resolve("github", "#1001"), undefined);
  });
});
