import { useState } from "react";
import type { Hex } from "viem";
import { ProviderIcon } from "../components/ProviderIcon";
import { HYPE } from "../domain/elysium";
import { platformName, type Platform } from "../domain/payment-intent";
import { sendElysiumTransaction } from "../elysium-desk";
import { playCue, speak } from "../sound";
import { evmProvider } from "../wallet/wallet-bridge";
import { api, usd } from "./api";
import { navigate } from "./router";
import { useSession } from "./session";

export const PLATFORMS: Platform[] = ["x", "github", "farcaster", "telegram", "discord"];

export type PreparedCall = { network: string; chainId: string; to: string; value: string; data: Hex; gas: string; display: { amount: string; fee: string; total: string }; note: string };
export type Stage = { kind: "idle" } | { kind: "signing" } | { kind: "confirming"; hash: string; sentAt: number } | { kind: "error"; text: string };

/**
 * Signs a prepared ElysaPay call in the wallet and waits for the server to read its receipt, then opens the receipt
 * page with how long the payment took from signature to confirmed (Elysium makes a block about every 100 ms).
 */
export function usePayment() {
  const session = useSession();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  async function sign(prepared: PreparedCall, confirm: (hash: string) => Promise<{ status: string }>, spoken: string) {
    const view = session.network;
    let wallet = session.wallet;
    if (!wallet) wallet = await session.connect();
    const provider = evmProvider();
    if (!wallet || !provider || !view) return;
    setStage({ kind: "signing" });
    try {
      if (prepared.to.toLowerCase() !== view.contracts.router?.toLowerCase()) throw new Error("The prepared payment does not go to the ElysaPay router this network lists. Nothing was signed.");
      const hash = await sendElysiumTransaction(provider, wallet, view, { to: prepared.to, data: prepared.data, value: BigInt(prepared.value), gas: BigInt(prepared.gas) });
      const sentAt = performance.now();
      playCue("send");
      setStage({ kind: "confirming", hash, sentAt });
      let result = await confirm(hash);
      for (let attempt = 0; result.status === "pending" && attempt < 120; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt < 20 ? 250 : 1_000));
        result = await confirm(hash);
      }
      if (result.status !== "confirmed") throw new Error("The payment was sent but is not confirmed yet. It will show in your activity once it is.");
      const elapsed = Math.round(performance.now() - sentAt);
      playCue("success");
      speak(spoken);
      setStage({ kind: "idle" });
      navigate(`/r/${view.id}/${hash}?ms=${elapsed}&fresh=1`);
    } catch (error) {
      playCue("error");
      setStage({ kind: "error", text: error instanceof Error ? error.message.split("\n")[0] : "The payment did not go through." });
    }
  }
  return { stage, setStage, sign };
}

/** The HYPE a field means: typed in HYPE, or converted from dollars at Hyperliquid's live mid. */
export function useAmount(initial = "") {
  const { hype } = useSession();
  const [amount, setAmount] = useState(initial);
  const [inDollars, setInDollars] = useState(false);
  const value = Number(amount.replace(",", "."));
  const valid = amount.trim() !== "" && Number.isFinite(value) && value > 0;
  const hypeAmount = !valid ? "" : !inDollars ? amount.trim().replace(",", ".") : hype ? (value / hype.mid).toFixed(6).replace(/\.?0+$/, "") : "";
  const dollars = valid && hype ? (inDollars ? value : value * hype.mid) : undefined;
  return { amount, setAmount, inDollars, setInDollars, hypeAmount, dollars, mid: hype?.mid };
}

export function AmountField({ field, label = "Amount", big = false }: { field: ReturnType<typeof useAmount>; label?: string; big?: boolean }) {
  return <label className={`field ${big ? "field-big" : ""}`}>
    <span>{label}</span>
    <span className="amount-wrap">
      <input value={field.amount} onChange={(event) => field.setAmount(event.target.value)} inputMode="decimal" placeholder={field.inDollars ? "25" : "0.5"} autoComplete="off" />
      <button type="button" className="unit" onClick={() => field.setInDollars((value) => !value)} aria-label={`Amount in ${field.inDollars ? "dollars" : "HYPE"}; switch`}>{field.inDollars ? "USD" : HYPE.symbol}</button>
    </span>
    {field.hypeAmount && <small className="hint">{field.inDollars ? `≈ ${field.hypeAmount} HYPE at ${usd(field.mid ?? 0, 4)}` : field.dollars !== undefined ? `≈ ${usd(field.dollars)}` : ""}</small>}
  </label>;
}

export function PlatformPicker({ value, onChange, compact = false }: { value: Platform; onChange: (platform: Platform) => void; compact?: boolean }) {
  return <div className={`platforms ${compact ? "platforms-compact" : ""}`} role="radiogroup" aria-label="Platform">
    {PLATFORMS.map((platform) => <button key={platform} type="button" role="radio" aria-checked={value === platform} onClick={() => onChange(platform)} title={platformName(platform)}>
      <ProviderIcon provider={platform} />{!compact && <span>{platformName(platform)}</span>}
    </button>)}
  </div>;
}

/** What the payment state says under the form: signing, confirming (with the hash), or the refusal. */
export function StageLine({ stage }: { stage: Stage }) {
  if (stage.kind === "signing") return <p className="stage" role="status"><span className="spinner" />Confirm in your wallet…</p>;
  if (stage.kind === "confirming") return <p className="stage" role="status"><span className="spinner" />Sent. Waiting for Elysium to confirm…</p>;
  if (stage.kind === "error") return <p className="stage stage-error" role="alert">{stage.text}</p>;
  return null;
}

/** Why payments are closed on the chosen network, when they are. */
export function useOpen() {
  const session = useSession();
  const view = session.network;
  const open = Boolean(view?.enabled && view.contracts.router && !session.paused);
  return { open, reason: session.paused ?? view?.reason ?? (view ? undefined : "Reading Elysium…") };
}

export const prepare = <T,>(path: string, body: unknown) => api<T>(path, body);
