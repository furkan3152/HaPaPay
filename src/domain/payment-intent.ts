export type Platform = "github" | "telegram" | "x" | "discord" | "farcaster";

export const platformNames: Record<Platform, string> = {
  github: "GitHub", x: "X", telegram: "Telegram", discord: "Discord", farcaster: "Farcaster",
};

export function platformName(platform: string) {
  return platformNames[platform as Platform] ?? platform;
}

export type PaymentIntent = {
  kind: "send";
  amount: string;
  token: "USDC";
  recipient: { platform: Platform; username: string };
  sourcePlatform?: Platform;
  status: "draft";
};

export type SocialRecipient = {
  username?: string;
  recipientPlatform?: Platform;
  sourcePlatform?: Platform;
};

/**
 * One platform named in a request. `source` marks one written as where the payment comes from ("from GitHub",
 * "X'ten", "githubdan"), and `mine` one written as the sender's own account ("from my GitHub account", "GitHub
 * hesabımdan").
 */
export type PlatformMention = { index: number; end: number; platform: Platform; source: boolean; mine: boolean };

/**
 * "dc" and "tg", the short names people write for Discord and Telegram, name a platform only
 * where one is written: after "on", "via" or "from", with a Turkish ending ("dc'den", "tgde"), before "üzerinden" or
 * "hesabım", or right after an @handle ("@bob dc"). Anywhere else they are words: "the trip to DC" names no platform.
 */
function shortPlatform(name: string) {
  return `(?<=\\b(?:on|via|over|through|from|using)\\s+)${name}\\b|(?<=(?<![\\w.])@[a-z0-9_.-]+\\s+)${name}\\b|\\b${name}(?=['’]?(?:deki|daki|den|dan|ten|tan|de|da|te|ta|ye|ya)\\b|\\s+(?:üzerinden|uzerinden|üstünden|ustunden|hesab))`;
}

/** Platform names, and "dc" and "tg" where a platform is written. */
const platformAliases: Array<[RegExp, Platform]> = [
  [/github/i, "github"],
  [new RegExp(`telegram|${shortPlatform("tg")}`, "i"), "telegram"],
  [/(?:\bx\b|x\s+üzerindeki|twitter)/i, "x"],
  [new RegExp(`discord|${shortPlatform("dc")}`, "i"), "discord"],
  [/farcaster|warpcast/i, "farcaster"],
];
const PLATFORM_WORDS = "github|telegram|x|twitter|discord|farcaster|warpcast";
/** A platform written after a handle: "on X", "via GitHub", and "on dc" or "via tg", the only places the short names count. */
const PLATFORM_AFTER = `(?:(?:on|via|at|in)\\s+(?:${PLATFORM_WORDS})|(?:on|via)\\s+(?:dc|tg))\\b`;
/** A handle: letters, digits, "_", "." and "-", not ending in punctuation. */
const HANDLE = "[a-z0-9_](?:[a-z0-9_.-]{0,62}[a-z0-9_])?";
/** Letters beyond ASCII ("ü", "ş") never belong to a handle, so "lütfen" or "gönder" never yield one from their middle. */
const LATIN_LETTER = "\\u00C0-\\u024F";
const HANDLE_START = `(?<![\\w@$.${LATIN_LETTER}-])`;
const HANDLE_END = `(?![${LATIN_LETTER}])`;
/**
 * Where a request names its recipient without an @, in order: after "to" or a verb ("pay octocat", "to bob", "gönder
 * bob"), after a platform word ("GitHub user octocat"), before "on <platform>" ("bob on X"), before a Turkish dative or
 * naming suffix ("selin'e", "octocat adlı"), right before its platform, bare or with a Turkish locative ("octocat
 * githubda", "bob x'te"), right after one ("yolla x bob"), and last right after the amount ("5 usdc bob"). Everything
 * around the handle is a lookaround, so a match is the handle itself.
 */
const BARE_HANDLES = [
  new RegExp(`(?<=(?:^|[^\\w${LATIN_LETTER}])(?:to|pay|tip|give|send|gönder|gonder|yolla|öde|ode)\\s+)(${HANDLE})${HANDLE_END}`, "gi"),
  new RegExp(`(?<=\\b(?:${PLATFORM_WORDS})\\s+(?:user|account|handle|username|profile)\\s+)(${HANDLE})${HANDLE_END}`, "gi"),
  new RegExp(`${HANDLE_START}(${HANDLE})${HANDLE_END}(?=\\s+${PLATFORM_AFTER})`, "gi"),
  new RegExp(`${HANDLE_START}(${HANDLE})(?=['’]y?[ae](?![a-z${LATIN_LETTER}])|\\s+(?:adl[ıi]|isimli|kullan[ıi]c[ıi]s[ıi]na|hesab[ıi]na)(?![a-z]))`, "gi"),
  new RegExp(`${HANDLE_START}(${HANDLE})${HANDLE_END}(?=\\s+(?:${PLATFORM_WORDS})(?:['’]?(?:d[ae]|t[ae])(?:ki)?)?(?![\\w'’${LATIN_LETTER}]))`, "gi"),
  new RegExp(`(?<=(?:^|[^\\w${LATIN_LETTER}])(?:${PLATFORM_WORDS})(?:['’]?(?:d[ae]|t[ae])(?:ki)?)?\\s+)(${HANDLE})${HANDLE_END}(?![\\w'’])`, "gi"),
  new RegExp(`(?<=\\d\\s*(?:usdc|usdg|dollars?|dolar|bucks|\\$)\\s+)(${HANDLE})${HANDLE_END}(?![\\w'’])`, "gi"),
];
/** Words that follow "to", "pay" and the like without naming anyone: pronouns, verbs, assets, platforms. */
const NOT_HANDLES = new Set([
  "a", "an", "the", "me", "my", "myself", "you", "your", "him", "his", "her", "them", "their", "us", "our", "it", "its",
  "this", "that", "these", "those", "someone", "somebody", "anyone", "anybody", "everyone", "friend", "people",
  "please", "now", "today", "back", "over", "some", "all", "each", "and", "or", "on", "via", "to", "from", "for", "with",
  "user", "account", "handle", "username", "profile", "send", "pay", "tip", "give", "transfer", "move",
  "usdc", "usdg", "usd", "dollar", "dollars", "buck", "bucks", "money", "cash", "funds", "token", "tokens",
  "stock", "stocks", "share", "shares", "coin", "coins", "github", "telegram", "tg", "x", "twitter", "discord", "dc", "farcaster",
  "warpcast", "bana", "ona", "benim", "onun", "birine", "dolar", "gonder", "yolla", "ode", "lutfen", "tane", "adet",
  "hisse", "hissesi", "herkes", "herkese", "hemen", "acil", "simdi", "bugun", "yarin",
  "everybody", "followers", "friends", "thanks", "thank", "thx", "tell", "pls", "plz", "ok", "okay", "hey",
  "hi", "hello", "merhaba", "selam", "tomorrow", "later", "at", "atar", "atin", "atsana", "ver", "versene", "ile", "ve",
  "he", "she", "they", "we", "i", "is", "are", "was", "be", "because", "since", "then", "also", "too", "just", "both",
  // Words that join or leave out names: "bob plus alice", "bob as well as alice", "@bob and not @alice".
  "plus", "as", "well", "not", "but", "except", "excluding", "without", "nor",
  "family", "everyone's", "hepsine", "ikisine", "birine",
  "icin", "olarak", "kadar",
  // Words about a payment, and asset names, that follow an amount or a verb without naming anyone (audit, 2026-10-06:
  // "why did my 5 USDC payment fail" asked which platform @payment was on).
  "payment", "payments", "fee", "fees", "transaction", "transactions", "transfer", "request", "link", "wallet", "balance",
  "sol", "solana", "worth", "total",
  // Amounts in words: "send fifty dollars to …".
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty",
  "seventy", "eighty", "ninety", "hundred", "thousand", "half",
]);

/**
 * Whether a word written without an @ can be a handle: it has a letter, is not a common word, and is not the unit of
 * an amount ("5 usdg").
 */
export function isBareHandle(input: string, index: number, word: string, exclude: ReadonlySet<string> = new Set()) {
  const lower = word.toLowerCase();
  return /[a-z]/.test(lower) && !NOT_HANDLES.has(lower) && !exclude.has(lower) && !/\d\s*\$?\s*$/.test(input.slice(0, index))
    // "my brother", "the team", "this guy": a person described, not a handle (audit, 2026-10-06).
    && !/(?:^|[^\w@])(?:my|the|this|that|our|his|her|your|their|a|an)\s+$/i.test(input.slice(0, index))
    // A link's scheme or host ("https://…", "github.com/…") is never a handle.
    && !/^(?::\/\/|\/)/.test(input.slice(index + word.length));
}

const PROFILE_HOSTS: Record<string, string> = { "github.com": "GitHub", "x.com": "X", "twitter.com": "X", "warpcast.com": "Farcaster", "farcaster.xyz": "Farcaster" };
const PROFILE_LINK = /(?<![\w@.-])(?:https?:\/\/)?(?:www\.)?(github\.com|x\.com|twitter\.com|warpcast\.com|farcaster\.xyz)\/@?([a-z0-9_](?:[a-z0-9_.-]{0,62}[a-z0-9_])?)\/?(?![\w/.-])/gi;

/**
 * A profile link written for a recipient, as the handle and platform it names: "https://github.com/torvalds" is
 * "@torvalds on GitHub", "x.com/jack" "@jack on X" (audit, 2026-10-06: the link's "https" was read as the handle).
 */
export function profileLinksAsHandles(input: string) {
  return input.replace(PROFILE_LINK, (_link, host: string, username: string) => `@${username} on ${PROFILE_HOSTS[host.toLowerCase()]}`);
}

function findHandle(input: string, exclude: ReadonlySet<string>) {
  const tagged = new RegExp(`(?<![\\w.])@(${HANDLE})${HANDLE_END}`, "i").exec(input);
  if (tagged) return { username: tagged[1], index: tagged.index, end: tagged.index + tagged[0].length };
  for (const pattern of BARE_HANDLES) {
    for (const match of input.matchAll(pattern)) {
      const index = match.index;
      const end = index + match[0].length;
      // "bob@example.com" is an email address, not a handle.
      if (isBareHandle(input, index, match[1], exclude) && input[end] !== "@") return { username: match[1], index, end };
    }
  }
  return undefined;
}

/**
 * Every platform a request names outside the recipient's handle, in order, each marked when it is written as where the
 * payment comes from ("from GitHub", "X'ten") or as the sender's own account ("from my GitHub account", "GitHub
 * hesabımdan").
 */
export function platformMentions(input: string, handle?: { index: number; end: number }): PlatformMention[] {
  return platformAliases.flatMap(([pattern, platform]) =>
    Array.from(input.matchAll(new RegExp(pattern.source, "gi")), (match) => {
      const end = match.index + match[0].length;
      const before = input.slice(0, match.index);
      const after = input.slice(end);
      const mine = /\bfrom\s+my\s+(?:own\s+)?$/i.test(before) || /(?:^|[^\w])benim\s+$/i.test(before) || /^['’]?\s*hesab[ıi]mdan/i.test(after);
      const source = mine || /\bfrom\s+$/i.test(before) || /^['’]?(?:dan|den|tan|ten)(?![a-zçğıöşü])/i.test(after);
      return { index: match.index, end, platform, source, mine };
    }))
    .filter(({ index, end }) => !handle || end <= handle.index || index >= handle.end)
    .sort((a, b) => a.index - b.index);
}

/**
 * The mentions that can name where the recipient is: every one not written as where the payment comes from, or, when
 * the request names no such platform, the one platform written as where it comes from without saying it is the
 * sender's own ("@jack'e x'ten 10 dolar yolla", "octocat'a githubdan", "dc'den @ali'ye"): a payment goes to an account
 * on a platform, and that is the only one the request names, so none of those asks which platform. "From my GitHub
 * account" and "GitHub hesabımdan" stay the sender's.
 */
export function recipientPlatformMentions(mentions: readonly PlatformMention[]) {
  const named = mentions.filter(({ source }) => !source);
  if (named.length) return named;
  const written = mentions.filter(({ source, mine }) => source && !mine);
  return new Set(written.map(({ platform }) => platform)).size === 1 ? written : [];
}

/**
 * Finds who receives a payment, the platform they are on, and the sender's own account when the request names one.
 * The recipient is the first @handle, or else a handle written without the @ in a common phrasing; `exclude` lists
 * words that cannot be it, such as the ticker being sent. Their platform is the one named right after the handle
 * ("on X"), else the nearest one before it ("X'teki @selin"), else the only platform the request names. Asset-agnostic.
 */
export function parseSocialRecipient(input: string, exclude: Iterable<string> = []): SocialRecipient {
  const handle = findHandle(input, new Set(Array.from(exclude, (word) => word.toLowerCase())));
  if (!handle) return {};
  const mentions = platformMentions(input, handle);
  const named = recipientPlatformMentions(mentions);
  const recipientPlatform = (
    named.find(({ index }) => index >= handle.end && /^(?:on|via|at|in)?$/i.test(input.slice(handle.end, index).trim()))
    ?? named.filter(({ end }) => end <= handle.index).at(-1)
    ?? (new Set(named.map(({ platform }) => platform)).size === 1 ? named[0] : undefined)
  )?.platform;
  const sourcePlatform = mentions.find(({ source, platform }) => source && platform !== recipientPlatform)?.platform;
  return { username: handle.username, recipientPlatform, sourcePlatform };
}

/** One person a request pays: their handle, where the request writes it, and the platform written for them. */
export type NamedRecipient = { username: string; index: number; end: number; platform?: Platform };

const TAGGED_HANDLES = new RegExp(`(?<![\\w.])@(${HANDLE})${HANDLE_END}`, "gi");
/** Handles without the @ in a list, which ends with "and", "&", "ve" or "ile": "alice, bob and carol". */
const BARE_LIST = `${HANDLE}(?:\\s*,\\s*${HANDLE})*\\s*,?\\s*(?:&|\\band(?:\\s+also)?\\b|\\bplus\\b|\\bas\\s+well\\s+as\\b|\\bve\\b|\\bile\\b)\\s*${HANDLE}`;
/** Handles separated by commas only, where the list plainly ends: before "on X", an amount, or the end. */
const COMMA_LIST = `${HANDLE}(?:\\s*,\\s*${HANDLE})+(?=\\s*(?:$|[.!?;]|\\s${PLATFORM_AFTER}|\\s\\d))`;
/** A list right after "to" or a verb: "to alice, bob and carol", "pay both bob and alice", "to bob, alice on X". */
const BARE_LIST_AFTER_VERB = new RegExp(
  `(?<=(?:^|[^\\w${LATIN_LETTER}])(?:to|pay|tip|give|send|gönder|gonder|yolla|öde|ode)\\s+(?:both\\s+|each\\s+of\\s+)?)(${BARE_LIST}|${COMMA_LIST})${HANDLE_END}(?![\\w'’])`,
  "gi",
);
/** A Turkish list whose last handle carries the dative ending: "alice, bob ve carol'a". */
const BARE_LIST_DATIVE = new RegExp(`${HANDLE_START}(${BARE_LIST})(?=['’]y?[ae](?![a-z${LATIN_LETTER}]))`, "gi");
/** A platform written right after a handle, for that handle: "@a on X", "@a (GitHub)", "@a'ya X'te". */
const ATTACHED_AFTER = /^(?:['’][a-zçğıöşü]*)?\s*(?:\(|on\s+|via\s+|at\s+|in\s+)?$/i;
/** A platform written right before a handle, for that handle: "X'teki @a", "GitHub user @a". */
const ATTACHED_BEFORE = /^(?:['’]?(?:d[ae]|t[ae])(?:ki)?)?\s*(?:user\s+|account\s+|kullan[ıi]c[ıi]s[ıi]\s+)?$/i;

/**
 * Everyone a request pays, in order: every @handle it writes, or else a list of handles written without the @ ("to
 * alice, bob and carol", "alice, bob ve carol'a"), or else the one handle `parseSocialRecipient` finds. Each gets
 * the platform written right after it ("@a on X, @b on GitHub") or right
 * before it ("X'teki @a"); when the request names one platform for everyone ("@a @b @c on X", "X'te @a ve @b'ye"),
 * that one goes to every handle without its own. The same handle twice on one platform counts once; on two
 * platforms it is two accounts. The sender's own account ("from my GitHub") is never a recipient's.
 */
export function parseSocialRecipients(input: string, exclude: Iterable<string> = []): { recipients: NamedRecipient[]; sourcePlatform?: Platform } {
  const excluded = new Set(Array.from(exclude, (word) => word.toLowerCase()));
  let found: NamedRecipient[] = Array.from(input.matchAll(TAGGED_HANDLES), (match) => ({ username: match[1], index: match.index, end: match.index + match[0].length }))
    .filter(({ end }) => input[end] !== "@")
    // "… from @alice" and "@alice'den" name who sends, not who receives (audit, 2026-10-06).
    .filter(({ index, end }) => !/\bfrom\s+(?:my\s+)?$/i.test(input.slice(0, index)) && !/^['’](?:dan|den|tan|ten)(?![a-zçğıöşü])/i.test(input.slice(end)))
    // "…, don't send to @alice", "not @alice", "except @alice": named to be left out (audit, 2026-10-06).
    .filter(({ index }) => !leftOut(input, index));
  if (found.length) found = withJoinedNames(input, found, excluded);
  if (!found.length) {
    for (const pattern of [BARE_LIST_AFTER_VERB, BARE_LIST_DATIVE]) {
      for (const match of input.matchAll(pattern)) {
        const names = Array.from(match[1].matchAll(new RegExp(HANDLE, "gi")), (name) => ({ username: name[0], index: match.index + name.index, end: match.index + name.index + name[0].length }))
          .filter(({ username }) => !/^(?:and|also|plus|as|well|ve|ile)$/i.test(username));
        if (names.length > 1 && names.every(({ username, index }) => isBareHandle(input, index, username, excluded))) {
          found = names;
          break;
        }
      }
      if (found.length) break;
    }
  }
  if (!found.length) {
    const single = findHandle(input, excluded);
    if (single) found = [single];
  }
  const recipients = found.map((handle) => ({ ...handle }));
  const mentions = platformMentions(input).filter(({ index, end }) => !found.some((handle) => index < handle.end && end > handle.index));
  const named = recipientPlatformMentions(mentions);
  for (const [position, recipient] of recipients.entries()) {
    const next = recipients[position + 1];
    const previous = recipients[position - 1];
    const after = named.find(({ index }) => index >= recipient.end && (!next || index < next.index) && ATTACHED_AFTER.test(input.slice(recipient.end, index)));
    const before = named.filter(({ end }) => end <= recipient.index && (!previous || end > previous.end) && ATTACHED_BEFORE.test(input.slice(end, recipient.index))).at(-1);
    recipient.platform = (after ?? before)?.platform;
  }
  const platforms = new Set(named.map(({ platform }) => platform));
  if (platforms.size === 1) {
    const [shared] = platforms;
    for (const recipient of recipients) recipient.platform ??= shared;
  }
  // The same handle on the same platform is one person; on two platforms it is two accounts.
  const seen = new Set<string>();
  const distinct = recipients.filter(({ username, platform }) => {
    const key = `${username.toLowerCase()}:${platform ?? ""}`;
    return !seen.has(key) && Boolean(seen.add(key));
  });
  const claimed = new Set(distinct.map(({ platform }) => platform));
  const sourcePlatform = mentions.find(({ source, platform }) => source && !claimed.has(platform))?.platform;
  return { recipients: distinct.map(({ username, index, end, platform }) => ({ username: username.toLowerCase(), index, end, ...(platform ? { platform } : {}) })), ...(sourcePlatform ? { sourcePlatform } : {}) };
}

const JOINED = `(?:\\s*,\\s*(?:and\\s+|&\\s*)?|\\s*&\\s*|\\s+(?:and(?:\\s+also)?|plus|as\\s+well\\s+as|ve|ile)\\s+)`;
const JOINED_AFTER = new RegExp(`^(${JOINED})(@?)(${HANDLE})${HANDLE_END}(?![\\w@])`, "i");
const JOINED_BEFORE = new RegExp(`(?:^|[^\\w@.${LATIN_LETTER}-])(${HANDLE})(\\s+(?:and|plus|ve|ile)\\s+|\\s*&\\s*)$`, "i");
const SENDER_ENDING = /^['’](?:dan|den|tan|ten)(?![a-zçğıöşü])/i;
/** Where a name joined before an @handle can stand: first, after "to" or a verb that sends, a platform, or an amount. */
const NAME_POSITION = new RegExp(`(?:^|(?:^|[^\\w${LATIN_LETTER}])(?:(?:to|pay|tip|give|send|gönder|gonder|yolla|öde|ode)(?:\\s+(?:both|each\\s+of))?|(?:${PLATFORM_WORDS})(?:['’]?(?:d[ae]|t[ae])(?:ki)?)?)\\s+|\\d\\s*(?:usdc|usdg|dollars?|dolar|bucks|\\$)\\s+)$`, "i");
/**
 * The people a request leaves out, as the list right after the words that do: "don't send to @alice", "not to @alice",
 * "but not @bob", "except @alice and @carol", "without @dave".
 */
const LEAVES_OUT = new RegExp(
  `(?:\\b(?:don['’]?t|do\\s+not|dont|never)\\s+(?:\\w+\\s+){0,2}?(?:send|pay|transfer|tip|give)(?:\\s+(?:it|anything|any|money|them))?\\s+(?:to\\s+)?|\\bnot\\s+(?:to\\s+)?(?=@)|\\bnot\\s+to\\s+|\\bexcept(?:\\s+for)?\\s+|\\bexcluding\\s+|\\bwithout\\s+)`
    + `(@?${HANDLE}(?:\\s*(?:,|\\band\\b|\\bor\\b|\\bnor\\b|&)\\s*@?${HANDLE})*)`,
  "gi",
);

/** Whether the handle at `index` is one a request leaves out. */
function leftOut(input: string, index: number) {
  for (const match of input.matchAll(LEAVES_OUT)) {
    const start = match.index + match[0].length - match[1].length;
    if (index >= start && index < start + match[1].length) return true;
  }
  return false;
}

/**
 * The names a list joins to @handles without their own @: "@alice and bob", "@a, bob and dave", "bob ve @alice",
 * "@bob plus alice". A list joined by commas alone is read only when a word ("and", "plus", "ve") joins it too, so a
 * closing ", lunch" is never a person (audit, 2026-10-06: "send 5 USDC to @alice and bob" paid @alice alone).
 */
function withJoinedNames(input: string, tagged: NamedRecipient[], excluded: ReadonlySet<string>) {
  const all = [...tagged];
  const taken = (index: number) => all.some((handle) => index >= handle.index && index < handle.end);
  for (const handle of tagged) {
    const chain: NamedRecipient[] = [];
    let joinedByWord = false;
    let at = handle.end;
    for (let step = 0; step < 10; step++) {
      const next = JOINED_AFTER.exec(input.slice(at));
      if (!next) break;
      const [whole, joiner, tag, name] = next;
      const index = at + whole.length - name.length;
      if (!tag) {
        if (!isBareHandle(input, index, name, excluded) || SENDER_ENDING.test(input.slice(index + name.length))) break;
        if (!taken(index)) chain.push({ username: name, index, end: index + name.length });
      }
      if (joiner.trim() !== ",") joinedByWord = true;
      at += whole.length;
    }
    if (joinedByWord) all.push(...chain);
    const previous = JOINED_BEFORE.exec(input.slice(0, handle.index));
    if (previous) {
      const index = previous.index + previous[0].length - previous[1].length - previous[2].length;
      // Only where a recipient stands: "for coffee and @alice" names no @coffee (audit, 2026-10-06).
      if (!taken(index) && NAME_POSITION.test(input.slice(0, index)) && isBareHandle(input, index, previous[1], excluded)) all.push({ username: previous[1], index, end: index + previous[1].length });
    }
  }
  return all.sort((left, right) => left.index - right.index);
}

export function parsePaymentIntent(input: string): PaymentIntent {
  const stated = statedUsdcAmounts(input);
  const amount = stated.length === 1 && stated[0].readings.length === 1 ? stated[0].readings[0] : undefined;
  const { username, recipientPlatform, sourcePlatform } = parseSocialRecipient(input);

  if (!amount || !username || !recipientPlatform) {
    throw new Error("A payment needs an amount, USDC, and a platform handle.");
  }

  return {
    kind: "send",
    amount,
    token: "USDC",
    recipient: { platform: recipientPlatform, username: username.toLowerCase() },
    sourcePlatform,
    status: "draft",
  };
}

/** "007.50" becomes "7.5". */
export function canonicalAmount(value: string) {
  const [whole, fraction = ""] = value.split(".");
  const digits = whole.replace(/^0+(?=\d)/, "");
  const decimals = fraction.replace(/0+$/, "");
  return decimals ? `${digits}.${decimals}` : digits;
}

/**
 * Every way a number written in digits reads, canonical: "." or "," as the decimal mark or as thousands separators
 * ("8,75" and "8.75" are 8.75, "1,000.50" and "1.000,50" are 1000.5, "1.000.000" is a million). One mark followed by
 * exactly three digits ("1,000", "2.500") reads both ways, unless the whole part is 0 ("0,500" is a half). A
 * malformed number ("1.2.3") has no reading.
 */
export function numberReadings(token: string): string[] {
  const groups = token.split(/[.,]/);
  const marks = token.replace(/\d+/g, "");
  if (!marks) return [canonicalAmount(token)];
  const readings = new Set<string>();
  // The last mark as the decimal point, any earlier ones as thousands separators.
  if (marks.length === 1 || (new Set(marks.slice(0, -1)).size === 1 && marks.at(-1) !== marks[0] && groups.slice(1, -1).every((group) => group.length === 3))) {
    readings.add(canonicalAmount(`${groups.slice(0, -1).join("")}.${groups.at(-1)}`));
  }
  // Every mark as a thousands separator. A run of thousands never starts at zero.
  if (new Set(marks).size === 1 && groups.slice(1).every((group) => group.length === 3) && /[1-9]/.test(groups[0])) {
    readings.add(canonicalAmount(groups.join("")));
  }
  return [...readings];
}

/**
 * Everyday English and Turkish words, and number words, that are also stock tickers: written in lowercase they mean
 * the word, so only capitals, a cashtag or the stock's own symbol name it, on Solana and on Robinhood Chain (audit,
 * 2026-10-06: "send @bob 20 now" became 20 NOWx, "1 coin" COINx, and "twenty five USDC" read "five" as Five Below).
 */
export const EVERYDAY_TICKER_WORDS: ReadonlySet<string> = new Set([
  "all", "ally", "amp", "app", "are", "arm", "ball", "ben", "bio", "bot", "bro", "bros", "car", "cat", "coin", "cube",
  "dal", "dar", "dash", "deck", "dis", "doc", "dow", "elf", "exe", "exp", "fast", "fix", "five", "form", "gap", "gen",
  "hal", "halo", "has", "hum", "hut", "ice", "jan", "key", "keys", "kim", "lad", "len", "line", "lite", "low", "luv",
  "mar", "mas", "met", "mod", "moo", "mos", "net", "nov", "now", "onto", "open", "owl", "path", "peg", "pen", "pep",
  "pins", "pool", "reg", "sail", "sats", "snow", "son", "stag", "tap", "team", "tol", "tru", "ups", "well", "wen",
  "yum",
]);

const NUMBER_WORDS = new Map(Object.entries({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  sıfır: 0, sifir: 0, bir: 1, iki: 2, üç: 3, uc: 3, dört: 4, dort: 4, beş: 5, bes: 5, altı: 6, alti: 6, yedi: 7,
  sekiz: 8, dokuz: 9, on: 10, yirmi: 20, otuz: 30, kırk: 40, kirk: 40, elli: 50, altmış: 60, altmis: 60,
  yetmiş: 70, yetmis: 70, seksen: 80, doksan: 90,
  // Turkish distributive numbers, "one each", "five each": the amount each person gets.
  birer: 1, ikişer: 2, ikiser: 2, üçer: 3, ucer: 3, dörder: 4, dorder: 4, beşer: 5, beser: 5, altışar: 6, altisar: 6,
  yedişer: 7, yediser: 7, sekizer: 8, dokuzar: 9, onar: 10, yirmişer: 20, yirmiser: 20, otuzar: 30, kırkar: 40, kirkar: 40,
  ellişer: 50, elliser: 50, altmışar: 60, altmisar: 60, yetmişer: 70, yetmiser: 70, seksener: 80, doksanar: 90,
}));
const NUMBER_SCALES = new Map(Object.entries({ hundred: 100, thousand: 1000, yüz: 100, yuz: 100, bin: 1000 }));
const WORD = "[a-zçğıöşü]+";

/** Whole numbers written in words ("fifty", "yirmi beş"). A lone "on" is the English word, not the Turkish ten. */
export function numberWords(message: string) {
  const values: number[] = [];
  let total = 0, current = 0, words = 0, onlyOn = true;
  const flush = () => {
    if (words && !onlyOn) values.push(total + current);
    total = current = words = 0;
    onlyOn = true;
  };
  for (const word of message.toLowerCase().split(/[^a-zçğıöşü]+/)) {
    const unit = NUMBER_WORDS.get(word);
    const scale = NUMBER_SCALES.get(word);
    if (unit !== undefined) current += unit;
    else if (scale === 100) current = (current || 1) * 100;
    else if (scale !== undefined) {
      total += (current || 1) * scale;
      current = 0;
    } else if (word === "and" && words) continue;
    else {
      flush();
      continue;
    }
    words++;
    if (word !== "on") onlyOn = false;
  }
  flush();
  return values;
}

/**
 * The number that the words right before `index` spell: 25 for "twenty five" (or "twenty-five") in "twenty five USDC",
 * and digits times a scale word, 5000 for "5 thousand" or "5 bin", 2500 for "2,5 bin". Digits before any other
 * number word, or digits that read two ways, spell nothing (audit, 2026-10-06: "5 bin" read as 1000 and "twenty-five"
 * as 5).
 */
export function numberWordsBefore(input: string, index: number): number | undefined {
  // Hyphens between number words are spaces; every character keeps its place.
  const head = input.slice(0, index).replace(/(?<=[a-zçğıöşü])-(?=[a-zçğıöşü])/gi, " ");
  const runMatch = new RegExp(`((?:${WORD}[ \\t]+)+)$`, "i").exec(head);
  const run = runMatch?.[1];
  if (!run || !runMatch) return undefined;
  const words = run.toLowerCase().trim().split(/\s+/);
  let start = words.length;
  while (start > 0 && (NUMBER_WORDS.has(words[start - 1]) || NUMBER_SCALES.has(words[start - 1]) || (words[start - 1] === "and" && start < words.length))) start--;
  while (words[start] === "and") start++;
  if (start >= words.length) return undefined;
  const digits = start === 0 ? /(?<![\w.,])(\d+(?:[.,]\d+)*)[ \t]*$/.exec(head.slice(0, runMatch.index))?.[1] : undefined;
  if (digits) {
    const scale = words.length - start === 1 ? NUMBER_SCALES.get(words[start]) : undefined;
    const readings = numberReadings(digits);
    if (!scale || readings.length !== 1) return undefined;
    const [whole, fraction = ""] = readings[0].split(".");
    const value = (BigInt(whole + fraction) * BigInt(scale)).toString().padStart(fraction.length + 1, "0");
    return Number(fraction ? `${value.slice(0, -fraction.length)}.${value.slice(-fraction.length)}` : value);
  }
  const values = numberWords(words.slice(start).join(" "));
  return values.length === 1 ? values[0] : undefined;
}

/** An amount as a request writes it, where it starts, and every way it reads. */
export type StatedAmount = { text: string; index: number; readings: string[] };

const DIGITS = "\\d+(?:[.,]\\d+)*";
/** A Turkish distributive ending on digits, "1'er", "5'şer": the amount each person gets. */
export const DISTRIBUTIVE_ENDING = "(?:['’](?:er|ar|şer|şar|ser|sar))";
/** Words that mean USDC: "USDC", "dollars", "dolar" with its Turkish endings, "usd", "bucks". */
const USDC_WORDS = "(?:usdc|dollars?|dolar(?:[ıi]|l[ıi]k)?|usd|bucks)(?![a-z0-9])";
const USDC_DIGITS = new RegExp(`(?<![\\w.,])(${DIGITS})${DISTRIBUTIVE_ENDING}?\\s*(?:\\$|${USDC_WORDS})|\\$\\s*(${DIGITS})`, "gi");
const USDC_WORD = new RegExp(`(?<![a-z0-9])${USDC_WORDS}`, "gi");

/**
 * The USDC amounts a request states: digits right before "USDC" or "dollars" or after "$" ("5 USDC", "$5", "5 dolar"),
 * else whole numbers in words right before those words ("twenty five USDC", "beş dolar"). Each distinct amount comes
 * back once, in order, so a request that names two amounts is told apart from one that names one.
 */
export function statedUsdcAmounts(input: string): StatedAmount[] {
  const byIndex = new Map<number, StatedAmount>();
  for (const match of input.matchAll(USDC_DIGITS)) {
    const text = match[1] ?? match[2];
    const index = match.index + match[0].indexOf(text);
    byIndex.set(index, { text, index, readings: numberReadings(text) });
  }
  if (!byIndex.size) {
    for (const match of input.matchAll(USDC_WORD)) {
      const value = numberWordsBefore(input, match.index);
      if (value !== undefined) byIndex.set(match.index, { text: String(value), index: match.index, readings: [String(value)] });
    }
  }
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}
