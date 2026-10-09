import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FarcasterAuthService } from "../server/farcaster-auth-service";

describe("Sign in with Farcaster seam", () => {
  it("links a Farcaster account only after domain, nonce, signature and FID verification", async () => {
    const calls: string[] = [];
    const service = new FarcasterAuthService({
      domain: "hapapay.example",
      siweUri: "https://hapapay.example/farcaster/login",
      client: {
        createChannel: async (args) => {
          calls.push(`create:${args.domain}:${args.nonce}`);
          return { isError: false, data: { channelToken: "secret-channel", url: "farcaster://connect?channelToken=public", nonce: args.nonce! } };
        },
        status: async ({ channelToken }) => {
          calls.push(`status:${channelToken}`);
          return { isError: false, data: { state: "completed", nonce: "nonce-12345678", message: "signed-siwe-message", signature: "0x1234", fid: 6841, username: "arc-user" } };
        },
        verifySignInMessage: async (args) => {
          calls.push(`verify:${args.domain}:${args.nonce}`);
          return { isError: false, success: true, fid: 6841 };
        },
      },
      random: () => "request-12345678",
      nonce: () => "nonce-12345678",
    });

    const request = await service.start("0x1111111111111111111111111111111111111111");
    assert.equal(request.url, "farcaster://connect?channelToken=public");
    assert.equal("channelToken" in request, false);
    assert.deepEqual(
      await service.complete("0x1111111111111111111111111111111111111111", request.requestId),
      { state: "verified", account: { platform: "farcaster", providerUserId: "6841", username: "arc-user" } },
    );
    assert.deepEqual(calls, [
      "create:hapapay.example:nonce-12345678",
      "status:secret-channel",
      "verify:hapapay.example:nonce-12345678",
    ]);
  });

  it("rejects a relay response whose verified FID does not match the profile", async () => {
    const service = new FarcasterAuthService({
      domain: "hapapay.example",
      siweUri: "https://hapapay.example/farcaster/login",
      client: {
        createChannel: async (args) => ({ isError: false, data: { channelToken: "secret", url: "farcaster://connect", nonce: args.nonce! } }),
        status: async () => ({ isError: false, data: { state: "completed", nonce: "nonce-abcdefgh", message: "message", signature: "0xabcd", fid: 42, username: "victim" } }),
        verifySignInMessage: async () => ({ isError: false, success: true, fid: 99 }),
      },
      random: () => "request-abcdefgh",
      nonce: () => "nonce-abcdefgh",
    });
    const request = await service.start("0x1111111111111111111111111111111111111111");
    await assert.rejects(
      service.complete("0x1111111111111111111111111111111111111111", request.requestId),
      /FID mismatch/,
    );
  });
});
