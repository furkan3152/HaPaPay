import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Address,
  type LocalAccount,
} from "viem";
import type { Platform } from "../../src/domain/payment-intent";

export async function createIdentityLinkAttestation(input: {
  attestor: LocalAccount;
  chainId: number;
  registry: Address;
  wallet: Address;
  platform: Platform;
  providerUserId: string;
  username: string;
  nonce: bigint;
  deadline: bigint;
}) {
  const platformHash = keccak256(stringToHex(input.platform.toLowerCase()));
  const providerUserIdHash = keccak256(stringToHex(input.providerUserId));
  const usernameHash = keccak256(stringToHex(input.username.trim().replace(/^@/, "").toLowerCase()));
  const request = {
    platformHash,
    providerUserIdHash,
    usernameHash,
    wallet: getAddress(input.wallet),
    deadline: input.deadline,
  };
  const attestationHash = keccak256(encodeAbiParameters(
    parseAbiParameters("uint256, address, address, bytes32, bytes32, bytes32, uint256, uint256"),
    [
      BigInt(input.chainId),
      getAddress(input.registry),
      request.wallet,
      platformHash,
      providerUserIdHash,
      usernameHash,
      input.nonce,
      input.deadline,
    ],
  ));
  const signature = await input.attestor.signMessage({ message: { raw: attestationHash } });
  return { request, attestationHash, signature };
}
