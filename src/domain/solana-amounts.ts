import { formatUnits, parseUnits } from "viem";

/**
 * HaPaPay's fee on Solana: 1% on top of each payment, rounded down per payment, all
 * of it to the treasury in the same transaction. There is no router contract and no burn share on Solana.
 */
export const SOLANA_FEE_BPS = 100n;

export function solanaFee(units: bigint) {
  return (units * SOLANA_FEE_BPS) / 10_000n;
}

/**
 * Token-2022's scaled UI amount (xStocks use it): wallets show `raw × multiplier`, and the issuer schedules a new
 * multiplier at a timestamp for dividends and splits. The numbers come from the mint account on chain.
 */
export type ScaledUiAmount = { multiplier: number; newMultiplier: number; newMultiplierEffectiveTimestamp: bigint };

/** A scheduled change this close to now refuses preparation: the amount could change between review and signing. */
export const MULTIPLIER_CHANGE_GUARD_SECONDS = 600n;

export function effectiveMultiplier(config: ScaledUiAmount | undefined, unixSeconds: bigint) {
  if (!config) return 1;
  return unixSeconds >= config.newMultiplierEffectiveTimestamp ? config.newMultiplier : config.multiplier;
}

/** Whether the multiplier changes within the guard window from now. */
export function multiplierChangesSoon(config: ScaledUiAmount | undefined, unixSeconds: bigint) {
  if (!config || config.newMultiplier === config.multiplier) return false;
  const at = config.newMultiplierEffectiveTimestamp;
  return at > unixSeconds && at <= unixSeconds + MULTIPLIER_CHANGE_GUARD_SECONDS;
}

function checkMultiplier(multiplier: number) {
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new Error("This token's balance multiplier cannot be read.");
}

/**
 * The raw units to transfer so a wallet shows `amount`: `amount ÷ multiplier`, rounded to the nearest unit as
 * Token-2022 converts it. Without a multiplier (or at 1) the amount is exact.
 */
export function uiAmountToUnits(amount: string, decimals: number, multiplier = 1) {
  const ui = parseUnits(amount, decimals);
  if (multiplier === 1) return ui;
  checkMultiplier(multiplier);
  if (ui > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("This amount is too large for a scaled token.");
  return BigInt(Math.round(Number(ui) / multiplier));
}

/** What a wallet shows for raw units: `units × multiplier`, rounded to the token's decimals. */
export function unitsToUiAmount(units: bigint, decimals: number, multiplier = 1) {
  if (multiplier === 1) return formatUnits(units, decimals);
  checkMultiplier(multiplier);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("This amount is too large for a scaled token.");
  return formatUnits(BigInt(Math.round(Number(units) * multiplier)), decimals);
}

/**
 * The amount a confirmed payment or vault link records for the `units` verified on chain: the reviewed amount when it
 * converts to exactly those units, else what a wallet shows for them. The browser's amount alone is never recorded
 * (audit, 2026-10-06: an amount sent beside smaller units inflated SP and invite rewards).
 */
export function recordedUiAmount(reviewed: string | undefined, units: bigint, decimals: number, multiplier = 1) {
  const fraction = reviewed?.split(".")[1] ?? "";
  if (reviewed !== undefined && /^\d+(?:\.\d+)?$/.test(reviewed) && fraction.length <= decimals) {
    try {
      if (uiAmountToUnits(reviewed, decimals, multiplier) === units) return reviewed;
    } catch {
      // An amount the multiplier cannot convert is replaced by the one the units show.
    }
  }
  return unitsToUiAmount(units, decimals, multiplier);
}

/**
 * A recorded row's amount as SP and invite rewards count it, bound to the units its confirm verified: the units as a
 * wallet shows them without a multiplier, or, for a scaled xStock, the recorded amount while it lies within a factor
 * of two of its units (xStock multipliers stay near 1). Undefined for a row that moved nothing. This also bounds rows
 * recorded before amounts were derived from units.
 */
export function countedUiAmount(record: { amount: string; units: string | bigint }, asset: { decimals: number; scaled?: boolean }) {
  const units = BigInt(record.units);
  if (units <= 0n) return undefined;
  const plain = formatUnits(units, asset.decimals);
  if (!asset.scaled) return plain;
  let shown: bigint;
  try {
    shown = parseUnits(record.amount, asset.decimals);
  } catch {
    return plain;
  }
  return shown <= units * 2n && shown * 2n >= units ? record.amount : plain;
}
