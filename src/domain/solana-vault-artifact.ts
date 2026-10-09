/**
 * The Solana vault program build the operator page deploys and the server accepts, made by
 * `npx tsx scripts/build-solana-vault.ts` from programs/hapapay-vault. The page refuses a download that does not
 * match, and the server registers a program only when its deployed code has exactly these bytes.
 */
export const SOLANA_VAULT_ARTIFACT = {
  path: "/solana/hapapay_vault.so",
  size: 111616,
  sha256: "aa58067c323482ac65a5725fc889cc577048de510204783ecb8c45476b6e6b64",
} as const;
