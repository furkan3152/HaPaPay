import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RecipientLookupUnavailableError } from "../server/recipient-discovery";
import { anyClaimsLink, identityKeysOf, linkMadeAt, lockOfLink, notTheNameHolder, VaultNameLockOffer, vaultRecipient, type VaultRecipientDirectory } from "../server/vault-recipient";
import { accountCreatedAt, claimsLink, isLockableName, isNameLockId, lockIdsOf, locksOnlyToName, locksToName, mayClaimByName, nameLockId, nameLockLabel, tellsAccountAge } from "../src/domain/vault-lock";

const DAY = 86_400_000;
/** A Discord ID for an account made at `madeAt` (ms): its top bits are milliseconds since Discord's epoch. */
const discordId = (madeAt: number) => String((BigInt(madeAt) - 1_420_070_400_000n) << 22n);
/** An X snowflake for an account made at `madeAt` (ms). */
const xId = (madeAt: number) => String((BigInt(madeAt) - 1_288_834_974_657n) << 22n);
const keyFor = (platform: string, lockId: string) => `${platform}:${lockId}`;

describe("vault links that wait for a name", () => {
  it("writes a name lock apart from any account ID", () => {
    assert.equal(nameLockId(" @New.Friend "), "name:new.friend");
    assert.equal(isNameLockId("name:new.friend"), true);
    assert.equal(isNameLockId("175928847299117063"), false, "account IDs are digits");
    assert.equal(nameLockLabel("Discord", "@New.Friend"), "the Discord name @new.friend");
  });

  it("locks Discord and Telegram to names always, X only when asked, GitHub and Farcaster never", () => {
    assert.deepEqual(["discord", "telegram", "x", "github", "farcaster"].map(locksOnlyToName), [true, true, false, false, false]);
    assert.deepEqual(["discord", "telegram", "x", "github", "farcaster"].map(locksToName), [true, true, true, false, false]);
    assert.deepEqual(["discord", "telegram", "x", "github"].map(tellsAccountAge), [true, false, true, false]);
  });

  it("only takes names the platform allows", () => {
    assert.equal(isLockableName("x", "@Jack"), true);
    assert.equal(isLockableName("x", "fifteen_chars_1"), true);
    assert.equal(isLockableName("x", "sixteen_chars_12"), false);
    assert.equal(isLockableName("x", "bad-name"), false);
    assert.equal(isLockableName("discord", "New.Friend"), true);
    assert.equal(isLockableName("discord", "a"), false, "two characters at least");
    assert.equal(isLockableName("discord", "new..friend"), false);
    assert.equal(isLockableName("discord", "new friend"), false);
    assert.equal(isLockableName("telegram", "toly"), true, "four for collectible names");
    assert.equal(isLockableName("telegram", "bob"), false);
    assert.equal(isLockableName("telegram", "1durov"), false, "starts with a letter");
    assert.equal(isLockableName("telegram", "du.rov"), false);
    assert.equal(isLockableName("github", "octocat"), false, "GitHub links wait for the account");
  });

  it("reads when a Discord or X account was made from its ID", () => {
    // Discord's own example ID: an account made on 2016-04-30.
    assert.equal(new Date(accountCreatedAt("discord", "175928847299117063")!).toISOString(), "2016-04-30T11:18:25.796Z");
    const madeAt = Date.parse("2024-02-01T00:00:00Z");
    assert.equal(accountCreatedAt("discord", discordId(madeAt)), madeAt);
    assert.equal(accountCreatedAt("x", xId(madeAt)), madeAt);
    assert.equal(accountCreatedAt("x", "2244994945"), 0, "X's sequential IDs are older than any link");
    assert.equal(accountCreatedAt("telegram", "123456789"), undefined, "Telegram IDs say nothing about age");
    assert.equal(accountCreatedAt("discord", "name:x"), undefined);
  });

  it("lets a name claim only when the platform confirmed it after the link, on an account older than the link", () => {
    const madeAt = Date.parse("2026-10-01T12:00:00Z");
    const after = new Date(madeAt + 60_000).toISOString();
    const older = { platform: "discord", providerUserId: discordId(madeAt - 365 * DAY), verifiedAt: after };
    assert.equal(mayClaimByName(older, madeAt), true);
    assert.equal(mayClaimByName({ ...older, verifiedAt: new Date(madeAt - 60_000).toISOString() }, madeAt), false, "a sign-in before the link may hold a name given up since");
    assert.equal(mayClaimByName({ ...older, providerUserId: discordId(madeAt + 1_000) }, madeAt), false, "an account made after the link");
    assert.equal(mayClaimByName({ ...older, verifiedAt: "not a date" }, madeAt), false);
    assert.equal(mayClaimByName({ platform: "telegram", providerUserId: "987654321", verifiedAt: after }, madeAt), true);
    assert.equal(mayClaimByName({ platform: "x", providerUserId: xId(madeAt + 1_000), verifiedAt: after }, madeAt), false);
  });

  it("claims a link by account ID always, and by name only under the name rules", () => {
    const madeAt = Date.parse("2026-10-01T12:00:00Z");
    const ali = { platform: "discord", providerUserId: discordId(madeAt - 30 * DAY), username: "ali", verifiedAt: new Date(madeAt + 1_000).toISOString() };
    assert.deepEqual(lockIdsOf(ali), [ali.providerUserId, "name:ali"]);
    assert.deepEqual(lockIdsOf({ platform: "github", providerUserId: "583231", username: "octocat" }), ["583231"]);
    assert.equal(claimsLink(ali, "discord:name:ali", keyFor, madeAt), true);
    assert.equal(claimsLink(ali, "DISCORD:NAME:ALI", keyFor, madeAt), true, "keys compare without case");
    assert.equal(claimsLink(ali, "discord:name:veli", keyFor, madeAt), false);
    assert.equal(claimsLink(ali, "x:name:ali", keyFor, madeAt), false, "the same name on another platform");
    const signedInBefore = { ...ali, verifiedAt: new Date(madeAt - 1_000).toISOString() };
    assert.equal(claimsLink(signedInBefore, "discord:name:ali", keyFor, madeAt), false);
    assert.equal(claimsLink(signedInBefore, `discord:${ali.providerUserId}`, keyFor, madeAt), true, "a link to the account itself needs no fresh sign-in");
    const github = { platform: "github", providerUserId: "583231", username: "octocat", verifiedAt: ali.verifiedAt };
    assert.equal(claimsLink(github, "github:name:octocat", keyFor, madeAt), false, "GitHub links never wait for a name");
  });
});

describe("vault recipients", () => {
  const found = (platform: string, username: string) => ({ platform, providerUserId: "583231", username }) as Awaited<ReturnType<VaultRecipientDirectory["lookup"]>>;
  const answering: VaultRecipientDirectory = { lookup: async (platform, username) => found(platform, username) };
  const refusing: VaultRecipientDirectory = { lookup: async () => { throw new RecipientLookupUnavailableError("X is not answering."); } };
  const unknown: VaultRecipientDirectory = { lookup: async () => { throw new Error("There is no X account named @nobody."); } };

  it("waits for Discord and Telegram names without asking anyone", async () => {
    let asked = false;
    const directory: VaultRecipientDirectory = { lookup: async () => { asked = true; throw new Error("not asked"); } };
    assert.deepEqual(await vaultRecipient(directory, "discord", " @New.Friend "), { platform: "discord", username: "new.friend", providerUserId: "name:new.friend", lock: "name" });
    assert.deepEqual(await vaultRecipient(directory, "telegram", "Durov"), { platform: "telegram", username: "durov", providerUserId: "name:durov", lock: "name" });
    assert.equal(asked, false);
    await assert.rejects(() => vaultRecipient(directory, "telegram", "bob"), /^Error: Invalid Telegram username\.$/);
    await assert.rejects(() => vaultRecipient(directory, "discord", "new..friend"), /Invalid Discord username/);
  });

  it("waits for the X account while X answers, and offers the name when it does not", async () => {
    assert.deepEqual(await vaultRecipient(answering, "x", "@Jack"), { platform: "x", username: "jack", providerUserId: "583231", lock: "account" });
    await assert.rejects(() => vaultRecipient(refusing, "x", "@Jack"), (error) => error instanceof VaultNameLockOffer && error.lock === "name" && /lock it to the X name @jack instead/.test(error.message));
    assert.deepEqual(await vaultRecipient(refusing, "x", "@Jack", "name"), { platform: "x", username: "jack", providerUserId: "name:jack", lock: "name" });
    await assert.rejects(() => vaultRecipient(unknown, "x", "nobody"), /There is no X account named @nobody/, "a handle X does not know gets no offer");
    await assert.rejects(() => vaultRecipient(refusing, "x", "bad-name", "name"), /Invalid X username/);
  });

  it("waits for GitHub and Farcaster accounts, never their names", async () => {
    assert.deepEqual(await vaultRecipient(answering, "github", "OctoCat", "name"), { platform: "github", username: "octocat", providerUserId: "583231", lock: "account" });
    await assert.rejects(() => vaultRecipient(refusing, "github", "octocat"), RecipientLookupUnavailableError);
  });

  it("dates a link by its record, or by the earliest it can have been made", () => {
    assert.equal(linkMadeAt({ confirmedAt: "2026-10-01T12:00:00.000Z" }, 0n, 0), Date.parse("2026-10-01T12:00:00.000Z"));
    const expiry = BigInt(Date.parse("2026-10-31T12:00:00Z") / 1000);
    assert.equal(linkMadeAt(undefined, expiry, 30 * 86_400), Date.parse("2026-10-01T12:00:00Z"));
    assert.equal(linkMadeAt({ confirmedAt: "" }, expiry, 30 * 86_400), Date.parse("2026-10-01T12:00:00Z"));
  });

  it("tells a name lock from an account lock, finds who can claim, and says why not", () => {
    assert.equal(lockOfLink({ platform: "discord", username: "ali" }, "DISCORD:NAME:ALI", keyFor), "name");
    assert.equal(lockOfLink({ platform: "x", username: "jack" }, "x:583231", keyFor), "account");
    assert.equal(lockOfLink({ platform: "github", username: "octocat" }, "github:name:octocat", keyFor), "account");
    const madeAt = Date.now() - 60_000;
    const ali = { platform: "discord" as const, providerUserId: discordId(madeAt - DAY), username: "ali", verifiedAt: new Date().toISOString() };
    const solana = { platform: "solana" as never, providerUserId: "1", username: "ali", verifiedAt: ali.verifiedAt };
    assert.equal(anyClaimsLink([solana, ali], "discord:name:ali", keyFor, madeAt), true);
    assert.equal(anyClaimsLink([solana], "solana:name:ali", keyFor, madeAt), false, "only vault platforms claim");
    assert.deepEqual(identityKeysOf(ali, keyFor), [`discord:${ali.providerUserId}`, "discord:name:ali"]);
    assert.match(notTheNameHolder("discord", "ali"), /^This link waits for the Discord name @ali\. Connect Discord to HaPaPay with the account that has that name now \(connect it again if it is connected already\); an account made after the link cannot claim it\.$/);
    assert.match(notTheNameHolder("telegram", "durov"), /^This link waits for the Telegram name @durov\. Connect Telegram to HaPaPay with the account that has that name now \(connect it again if it is connected already\)\.$/);
  });
});
