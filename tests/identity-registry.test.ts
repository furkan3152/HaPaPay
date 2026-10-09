import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IdentityDirectory } from "../src/domain/identity-directory";

describe("identity directory seam", () => {
  it("resolves every verified social account to one wallet", () => {
    const directory = new IdentityDirectory();
    const wallet = "0x1111111111111111111111111111111111111111";

    directory.link(wallet, [
      { platform: "github", username: "Ada-L" },
      { platform: "x", username: "@ada_l" },
      { platform: "farcaster", username: "ada" },
    ]);

    assert.equal(directory.resolve("github", "ada-l"), wallet);
    assert.equal(directory.resolve("x", "ADA_L"), wallet);
    assert.equal(directory.profile(wallet).accounts.length, 3);
  });

  it("refuses to silently reassign an identity owned by another wallet", () => {
    const directory = new IdentityDirectory();
    directory.link("0x1111111111111111111111111111111111111111", [
      { platform: "telegram", username: "merve" },
    ]);

    assert.throws(() =>
      directory.link("0x2222222222222222222222222222222222222222", [
        { platform: "telegram", username: "@Merve" },
      ]),
      /already linked/,
    );
  });
});
