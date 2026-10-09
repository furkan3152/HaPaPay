import { encodeFunctionData, getAddress, keccak256, stringToHex, type Address, type Hex, type LocalAccount } from "viem";
import type { VerifiedSocialAccount } from "../../server/verified-identity-service";
import { createIdentityLinkAttestation } from "./identity-attestation";

const registryAbi = [{
  type: "function",
  name: "linkIdentity",
  stateMutability: "nonpayable",
  inputs: [
    {
      name: "request",
      type: "tuple",
      components: [
        { name: "platformHash", type: "bytes32" },
        { name: "providerUserIdHash", type: "bytes32" },
        { name: "usernameHash", type: "bytes32" },
        { name: "wallet", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { name: "signature", type: "bytes" },
  ],
  outputs: [],
}] as const;

const unlinkRegistryAbi = [{
  type: "function",
  name: "unlinkIdentity",
  stateMutability: "nonpayable",
  inputs: [
    { name: "platformHash", type: "bytes32" },
    { name: "providerUserIdHash", type: "bytes32" },
  ],
  outputs: [],
}] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Builds ArcIdentityRegistry link and unlink calls for the contract tests. The desk no longer writes identity records
 * on chain (verified links live in the database), but the registry stays part of the verified Arc contract set, so its
 * tests keep exercising the deployed bytecode with real attestations.
 */
export class IdentityRegistryLinkService {
  constructor(private readonly options: {
    chainId: number;
    registry: Address;
    attestor: LocalAccount;
    expectedVerifier?: Address;
    readNonce(wallet: Address): Promise<bigint>;
    readIdentityOwner?(platformHash: Hex, providerUserIdHash: Hex): Promise<Address>;
    now?: () => Date;
  }) {
    if (options.expectedVerifier && getAddress(options.expectedVerifier) !== getAddress(options.attestor.address)) {
      throw new Error("Identity attestor does not match the registry verifier.");
    }
  }

  async prepare(inputWallet: string, account: VerifiedSocialAccount) {
    const wallet = getAddress(inputWallet);
    const nonce = await this.options.readNonce(wallet);
    const deadline = BigInt(Math.floor((this.options.now?.() ?? new Date()).getTime() / 1000) + 10 * 60);
    const attestation = await createIdentityLinkAttestation({
      attestor: this.options.attestor,
      chainId: this.options.chainId,
      registry: this.options.registry,
      wallet,
      platform: account.platform,
      providerUserId: account.providerUserId,
      username: account.username,
      nonce,
      deadline,
    });
    return {
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      transaction: {
        from: wallet,
        to: getAddress(this.options.registry),
        data: encodeFunctionData({
          abi: registryAbi,
          functionName: "linkIdentity",
          args: [attestation.request, attestation.signature],
        }),
        value: "0x0" as const,
      },
    };
  }

  /**
   * Which of the wallet's verified accounts Arc's identity registry records for that wallet, read from chain. An account
   * recorded for another wallet (an older link that was never removed on chain) is reported as not recorded here.
   */
  async recorded(inputWallet: string, accounts: VerifiedSocialAccount[]) {
    if (!this.options.readIdentityOwner) throw new Error("Registry identity lookup is not configured.");
    const wallet = getAddress(inputWallet);
    return Promise.all(accounts.map(async (account) => {
      const owner = await this.options.readIdentityOwner!(
        keccak256(stringToHex(account.platform.toLowerCase())),
        keccak256(stringToHex(account.providerUserId)),
      );
      return { platform: account.platform, recorded: getAddress(owner) === wallet };
    }));
  }

  async prepareUnlink(inputWallet: string, account: VerifiedSocialAccount) {
    if (!this.options.readIdentityOwner) throw new Error("Registry identity lookup is not configured.");
    const wallet = getAddress(inputWallet);
    const platformHash = keccak256(stringToHex(account.platform.toLowerCase()));
    const providerUserIdHash = keccak256(stringToHex(account.providerUserId));
    const owner = getAddress(await this.options.readIdentityOwner(platformHash, providerUserIdHash));
    if (owner === ZERO_ADDRESS) return { registered: false as const };
    if (owner !== wallet) throw new Error("Arc registry identity belongs to another wallet.");
    return {
      registered: true as const,
      transaction: {
        from: wallet,
        to: getAddress(this.options.registry),
        data: encodeFunctionData({
          abi: unlinkRegistryAbi,
          functionName: "unlinkIdentity",
          args: [platformHash, providerUserIdHash],
        }),
        value: "0x0" as const,
      },
    };
  }
}
