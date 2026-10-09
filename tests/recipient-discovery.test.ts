import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OfficialRecipientDirectory, RecipientLookupUnavailableError } from "../server/recipient-discovery";
import { MemoryTransientStateStore } from "../server/transient-state-store";

describe("official non-user recipient discovery", () => {
  it("resolves GitHub and X handles to immutable provider user IDs", async () => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    const directory = new OfficialRecipientDirectory({
      xBearerToken: "x-app-token",
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") ?? undefined });
        if (url.includes("api.github.com")) return Response.json({ id: 583231, login: "OctoCat" });
        return Response.json({ data: { id: "2244994945", username: "XDevelopers" } });
      },
    });

    assert.deepEqual(await directory.lookup("github", "@octocat"), {
      platform: "github", providerUserId: "583231", username: "octocat",
    });
    assert.deepEqual(await directory.lookup("x", "@xdevelopers"), {
      platform: "x", providerUserId: "2244994945", username: "xdevelopers",
    });
    assert.equal(requests[1].authorization, "Bearer x-app-token");
  });

  it("tells a handle that does not exist from one it cannot ask about", async () => {
    // The desk asks before it offers a vault link, so a typo gets no link at all.
    const directory = new OfficialRecipientDirectory({
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/users/octocat")) return Response.json({ id: 583231, login: "octocat" });
        if (url.endsWith("/users/no-such-user-zz9")) return new Response("{}", { status: 404 });
        if (url.includes("fnames.farcaster.xyz")) return new Response("{}", { status: 404 });
        return new Response("rate limited", { status: 403 });
      },
    });
    assert.equal(await directory.exists("github", "octocat"), true);
    assert.equal(await directory.exists("github", "no-such-user-zz9"), false);
    assert.equal(await directory.exists("github", "anyone-else"), undefined, "a refusal or an outage is not an answer");
    assert.equal(await directory.exists("farcaster", "nobody-here"), false);
    assert.equal(await directory.exists("farcaster", "name.eth"), false, "an ENS name cannot be a Farcaster name");
    assert.equal(await directory.exists("x", "bob"), "unavailable", "without X's token X cannot be asked: its links wait for the name");
    assert.equal(await directory.exists("telegram", "bob"), undefined);
  });

  it("answers a handle no platform account can have without asking anyone", async () => {
    // Audit, 2026-10-06: a wallet address written as the recipient was offered a vault link as an X handle.
    const asked: string[] = [];
    const directory = new OfficialRecipientDirectory({ fetch: async (input) => { asked.push(String(input)); return new Response("{}", { status: 404 }); } });
    assert.equal(await directory.exists("x", "0x1234567890123456789012345678901234567890"), false, "an X handle has at most 15 characters");
    assert.equal(await directory.exists("x", "bob.eth"), false, "an X handle has no dot");
    assert.equal(await directory.exists("github", "a".repeat(40)), false, "a GitHub login has at most 39 characters");
    assert.equal(await directory.exists("github", "-bob"), false);
    assert.equal(await directory.exists("farcaster", "bob_smith"), false);
    assert.equal(asked.length, 0);
    assert.equal(await directory.exists("x", "@Bob_99"), "unavailable", "a handle X can have is never asked from the chat; without X's token, X cannot be asked at all");
    assert.equal(await directory.exists("telegram", "a".repeat(40)), undefined, "Telegram and Discord are never refused here");
    assert.equal(await directory.exists("github", "octo_acme"), false, "asked, and GitHub's 404 is an answer");
    assert.equal(asked.length, 1);
  });

  it("reads X's answer for a username nobody holds as not found, never asks X from the chat, and keeps answers for five minutes", async () => {
    const requests: string[] = [];
    let githubDown = true;
    const directory = new OfficialRecipientDirectory({
      xBearerToken: "x-app-token",
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        // X answers 200 with an error for the user rather than a 404.
        if (url.endsWith("/by/username/nobody_zz9")) {
          return Response.json({ errors: [{ value: "nobody_zz9", detail: "Could not find user with username: [nobody_zz9].", title: "Not Found Error", resource_type: "user", parameter: "username", resource_id: "nobody_zz9", type: "https://api.twitter.com/2/problems/resource-not-found" }] });
        }
        if (url.endsWith("/by/username/odd")) return Response.json({ errors: [{ title: "Forbidden", resource_type: "user" }] });
        if (url.includes("api.x.com")) return Response.json({ data: { id: "2244994945", username: "XDevelopers" } });
        if (url.endsWith("/users/no-such-user-zz9")) return new Response("{}", { status: 404 });
        if (githubDown) return new Response("rate limited", { status: 403 });
        return Response.json({ id: 583231, login: "octocat" });
      },
    });
    await assert.rejects(directory.lookup("x", "nobody_zz9"), /X account was not found/);
    await assert.rejects(directory.lookup("x", "odd"), /X returned an invalid user identity/, "only X's own not-found answer means nobody holds the name");
    // X's lookups count against the operator's plan: the chat never spends them, preparation alone asks X.
    const beforeX = requests.length;
    assert.equal(await directory.exists("x", "nobody_zz9"), undefined);
    assert.equal(await directory.exists("x", "xdevelopers"), undefined);
    assert.equal(requests.length, beforeX);
    const start = Date.now();
    assert.equal(await directory.exists("github", "no-such-user-zz9", start), false);
    const asked = requests.length;
    assert.equal(await directory.exists("github", "@No-Such-User-zz9", start + 60_000), false);
    assert.equal(requests.length, asked, "an answer is kept, so a request typed again asks nobody");
    assert.equal(await directory.exists("github", "no-such-user-zz9", start + 5 * 60_000 + 1), false);
    assert.equal(requests.length, asked + 1, "and asked again after five minutes");
    // A refusal is not an answer and is never kept.
    assert.equal(await directory.exists("github", "octocat", start), undefined);
    githubDown = false;
    assert.equal(await directory.exists("github", "octocat", start), true);
    // A payment never reads the kept answer: preparing one looks the account up again.
    const before = requests.length;
    await directory.lookup("github", "octocat");
    assert.equal(requests.length, before + 1);
  });

  it("does not pretend arbitrary Telegram handles can be officially resolved", async () => {
    const directory = new OfficialRecipientDirectory();
    await assert.rejects(directory.lookup("telegram", "someone"), /Invite this person to link their account first/);
  });

  it("reports X lookup only when the app-only bearer token is configured", () => {
    const withoutX = new OfficialRecipientDirectory();
    assert.deepEqual(["github", "x", "telegram", "discord", "farcaster"].map((platform) => withoutX.supports(platform as never)), [true, false, false, false, true]);
    assert.equal(new OfficialRecipientDirectory({ xBearerToken: "x-app-token" }).supports("x"), true);
  });

  it("resolves a Farcaster name to the FID its latest fname-registry transfer points to", async () => {
    const requests: string[] = [];
    const registry: Record<string, Response | (() => Response)> = {
      dwr: () => Response.json({ transfer: { id: 3, username: "dwr", owner: "0x74232bf61e994655592747e20bdf6fa9b9476f79", from: 0, to: 3 } }),
      released: () => Response.json({ transfer: { id: 9, username: "released", from: 77, to: 0 } }),
      spoofed: () => Response.json({ transfer: { id: 10, username: "someone-else", from: 0, to: 44 } }),
      down: () => new Response("upstream", { status: 502 }),
    };
    const directory = new OfficialRecipientDirectory({
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url.toString());
        const entry = registry[url.searchParams.get("name") ?? ""];
        return entry ? (typeof entry === "function" ? entry() : entry) : Response.json({ error: "No transfer found" }, { status: 404 });
      },
    });

    assert.deepEqual(await directory.lookup("farcaster", "@DWR"), { platform: "farcaster", providerUserId: "3", username: "dwr" });
    assert.equal(requests[0], "https://fnames.farcaster.xyz/transfers/current?name=dwr");
    await assert.rejects(directory.lookup("farcaster", "nobody-here"), /Farcaster account was not found/);
    await assert.rejects(directory.lookup("farcaster", "released"), /Farcaster account was not found/, "a name transferred to FID 0 is unregistered");
    await assert.rejects(directory.lookup("farcaster", "spoofed"), /invalid user identity/, "the registry must answer for the requested name");
    await assert.rejects(directory.lookup("farcaster", "down"), /Farcaster could not look the name up just now/);
    await assert.rejects(directory.lookup("farcaster", "vitalik.eth"), /Invalid Farcaster username: \.eth names are ENS names/);
    await assert.rejects(directory.lookup("farcaster", "-dash-first"), /Invalid Farcaster username/);
    assert.equal(requests.length, 5, "malformed names never reach the registry");
  });

  it("names a refused, limited or unreachable lookup, and pauses a platform that refused this server on every instance", async () => {
    // A refused lookup is named, and the platform that refused is paused on every server instance through the shared
    // store; the chat then locks an X link to the name instead of the account.
    let now = 1_000_000;
    let xAnswer = 403;
    const asked: string[] = [];
    const store = new MemoryTransientStateStore();
    const fetch = async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url.includes("api.x.com")) return new Response(JSON.stringify({ title: "Client Forbidden", reason: "client-not-enrolled" }), { status: xAnswer });
      if (url.endsWith("/users/limited")) return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      if (url.endsWith("/users/badtoken")) return new Response("{}", { status: 401 });
      if (url.endsWith("/users/offline")) throw new TypeError("fetch failed");
      return new Response("{}", { status: 500 });
    };
    const directory = new OfficialRecipientDirectory({ xBearerToken: "x-app-token", fetch, stateStore: store, now: () => now });
    const other = new OfficialRecipientDirectory({ xBearerToken: "x-app-token", fetch, stateStore: store, now: () => now });

    await assert.rejects(directory.lookup("x", "jack"), (error) => error instanceof RecipientLookupUnavailableError && /^X is not answering account lookups for HaPaPay right now/.test(error.message));
    assert.equal(await directory.exists("x", "jack"), "unavailable", "X reports unavailable, so X links wait for the name");
    assert.equal(await other.exists("x", "someone"), "unavailable", "another server instance knows from the shared store");
    const before = asked.length;
    await assert.rejects(other.lookup("x", "jack"), /not answering account lookups/);
    assert.equal(asked.length, before, "X is not asked again during the pause");

    now += 10 * 60_000 + 1;
    xAnswer = 429;
    assert.equal(await directory.exists("x", "jack"), undefined, "after ten minutes X is offered again");
    await assert.rejects(directory.lookup("x", "jack"), /X is limiting account lookups right now\. Try again in a few minutes\.$/);
    assert.equal(await directory.exists("x", "jack"), undefined, "a rate limit pauses nothing");

    await assert.rejects(directory.lookup("github", "limited"), /GitHub is limiting account lookups right now/);
    await assert.rejects(directory.lookup("github", "offline"), /GitHub could not be reached just now\. Try again in a moment\.$/);
    await assert.rejects(directory.lookup("github", "elsewhere"), /GitHub could not look the account up just now/);
    await assert.rejects(directory.lookup("github", "badtoken"), /GitHub is not answering account lookups for HaPaPay right now/, "a configured token GitHub refuses pauses GitHub");
    assert.equal(await directory.exists("github", "octocat"), "unavailable");
  });

  it("says plainly when this server has no X key", async () => {
    const directory = new OfficialRecipientDirectory({ fetch: async () => new Response("{}", { status: 500 }) });
    await assert.rejects(directory.lookup("x", "jack"), (error) => error instanceof RecipientLookupUnavailableError && /^This server cannot look up X accounts/.test(error.message));
  });

  it("never waits on a lookup for good, and never shows an answer it cannot read", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const directory = new OfficialRecipientDirectory({
      xBearerToken: "x-app-token",
      fetch: async (_input, init) => {
        signals.push(init?.signal);
        return new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
      },
    });
    for (const platform of ["github", "x", "farcaster"] as const) {
      await assert.rejects(directory.lookup(platform, "someone"), (error) => error instanceof RecipientLookupUnavailableError && /could not look the account up just now\. Try again in a moment\.$/.test(error.message) && !/html|JSON|token/i.test(error.message), platform);
    }
    assert.equal(signals.length, 3);
    assert.ok(signals.every((signal) => signal instanceof AbortSignal), "every lookup gives up after a few seconds");
  });
});
