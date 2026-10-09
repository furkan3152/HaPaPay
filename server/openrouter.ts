import { paymentReadingSchema } from "./chat-service.js";

const PLATFORMS = ["github", "telegram", "x", "discord", "farcaster", "unstated"];

export async function parseWithOpenRouter(message: string) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("OpenRouter request timed out"));
      controller.abort();
    }, 8_000);
  });

  try {
    // Race the complete response, including JSON consumption, against one deadline.
    return await Promise.race([requestIntent(message, apiKey, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestIntent(message: string, apiKey: string, signal: AbortSignal) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    signal,
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL ?? "http://localhost:5173",
      "X-OpenRouter-Title": "HaPaPay",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "Read one payment request for HaPaPay into JSON. Never claim to send, sign, or execute funds.",
            'Use kind "none" unless the message asks to send a stated amount of one asset to one or more social accounts now.',
            'Use kind "none" when it asks to receive or request money, says not to send, or asks to repeat or schedule a payment.',
            'asset: "USDC" for USDC or dollars, otherwise the token ticker exactly as written (NVDA, TSLA, USDG); "" when none is named.',
            "amount: the amount the message states, in digits (fifty is 50, yirmi beş is 25, beşer is 5); never convert currencies, add up or split.",
            "recipients: every account to pay, in order. Copy each handle as written, without the @ and without a suffix after an apostrophe (octocat'a is octocat),",
            'and use only a platform the message names for them; a Turkish ending on a platform (githubda, X\'teki) still names it; otherwise "unstated".',
            'sourcePlatform: the sender\'s own account only when the message says so ("from my GitHub", "GitHub hesabımdan"); otherwise "unstated".',
            'note: a message for the recipients that the request carries ("for dinner", "teşekkürler", "note: rent"), copied exactly as written; "" when there is none. Never write one yourself.',
            "Supported platforms: github, telegram, x (Twitter), discord, farcaster (Warpcast).",
          ].join(" "),
        },
        { role: "user", content: message },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "hapapay_payment_reading",
          strict: true,
          schema: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["send", "none"] },
              amount: { type: "string" },
              asset: { type: "string" },
              recipients: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    username: { type: "string" },
                    platform: { type: "string", enum: PLATFORMS },
                  },
                  required: ["username", "platform"],
                  additionalProperties: false,
                },
              },
              sourcePlatform: { type: "string", enum: PLATFORMS },
              note: { type: "string" },
            },
            required: ["kind", "amount", "asset", "recipients", "sourcePlatform", "note"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) throw new Error(`OpenRouter request failed (${response.status})`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no structured reading");
  return paymentReadingSchema.parse(JSON.parse(content));
}
