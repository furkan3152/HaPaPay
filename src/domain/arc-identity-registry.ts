import { parseAbi } from "viem";

/** The security revision the reviewed ArcIdentityRegistry reports. Any other value is refused. */
export const ARC_IDENTITY_REGISTRY_REVISION = 2n;

export const arcIdentityRegistryAbi = parseAbi([
  "constructor(address initialVerifier)",
  "struct LinkRequest { bytes32 platformHash; bytes32 providerUserIdHash; bytes32 usernameHash; address wallet; uint256 deadline; }",
  "function owner() view returns (address)",
  "function verifier() view returns (address)",
  "function nonces(address wallet) view returns (uint256)",
  "function securityRevision() pure returns (uint256)",
  "function setVerifier(address newVerifier)",
  "function transferOwnership(address newOwner)",
  "function linkIdentity(LinkRequest request, bytes signature)",
  "function unlinkIdentity(bytes32 platformHash, bytes32 providerUserIdHash)",
  "function resolveProviderIdentity(bytes32 platformHash, bytes32 providerUserIdHash) view returns (address)",
  "function resolveHandle(bytes32 platformHash, bytes32 usernameHash) view returns (address)",
  "event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier)",
  "event IdentityLinked(address indexed wallet, bytes32 indexed platformHash, bytes32 indexed providerUserIdHash, bytes32 usernameHash)",
  "event IdentityUnlinked(address indexed wallet, bytes32 indexed platformHash, bytes32 indexed providerUserIdHash)",
  "error NotOwner()",
  "error InvalidAddress()",
  "error AttestationExpired()",
  "error InvalidAttestation()",
  "error IdentityAlreadyLinked()",
  "error HandleAlreadyLinked()",
  "error NotIdentityOwner()",
]);
