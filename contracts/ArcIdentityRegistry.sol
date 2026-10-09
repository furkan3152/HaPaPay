// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice HaPaPay's registry of identities verified by official social providers, each linked to one wallet.
/// @dev OAuth secrets and plaintext provider identifiers never enter the chain.
contract ArcIdentityRegistry {
    error NotOwner();
    error InvalidAddress();
    error AttestationExpired();
    error InvalidAttestation();
    error IdentityAlreadyLinked();
    error HandleAlreadyLinked();
    error NotIdentityOwner();

    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event IdentityLinked(
        address indexed wallet,
        bytes32 indexed platformHash,
        bytes32 indexed providerUserIdHash,
        bytes32 usernameHash
    );
    event IdentityUnlinked(
        address indexed wallet,
        bytes32 indexed platformHash,
        bytes32 indexed providerUserIdHash
    );

    uint256 private constant SECP256K1N_DIV_2 =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public owner;
    address public verifier;
    mapping(address wallet => uint256 nonce) public nonces;
    mapping(bytes32 identityKey => address wallet) private identityOwners;
    mapping(bytes32 handleKey => address wallet) private handleOwners;
    mapping(bytes32 identityKey => bytes32 handleKey) private identityHandles;

    struct LinkRequest {
        bytes32 platformHash;
        bytes32 providerUserIdHash;
        bytes32 usernameHash;
        address wallet;
        uint256 deadline;
    }

    constructor(address initialVerifier) {
        if (initialVerifier == address(0)) revert InvalidAddress();
        owner = msg.sender;
        verifier = initialVerifier;
    }

    function securityRevision() public pure returns (uint256) {
        return 2;
    }

    function setVerifier(address newVerifier) external {
        if (msg.sender != owner) revert NotOwner();
        if (newVerifier == address(0)) revert InvalidAddress();
        emit VerifierUpdated(verifier, newVerifier);
        verifier = newVerifier;
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert InvalidAddress();
        owner = newOwner;
    }

    function linkIdentity(LinkRequest calldata request, bytes calldata signature) external {
        if (request.wallet == address(0)) revert InvalidAddress();
        if (block.timestamp > request.deadline) revert AttestationExpired();

        bytes32 identityKey = keccak256(abi.encode(request.platformHash, request.providerUserIdHash));
        bytes32 handleKey = keccak256(abi.encode(request.platformHash, request.usernameHash));
        address identityOwner = identityOwners[identityKey];
        address handleOwner = handleOwners[handleKey];
        if (identityOwner != address(0) && identityOwner != request.wallet) revert IdentityAlreadyLinked();
        if (handleOwner != address(0) && (
            handleOwner != request.wallet || identityOwner != request.wallet || identityHandles[identityKey] != handleKey
        )) revert HandleAlreadyLinked();

        bytes32 attestation = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                request.wallet,
                request.platformHash,
                request.providerUserIdHash,
                request.usernameHash,
                nonces[request.wallet],
                request.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", attestation));
        if (_recover(digest, signature) != verifier) revert InvalidAttestation();
        unchecked { nonces[request.wallet]++; }

        bytes32 previousHandle = identityHandles[identityKey];
        if (previousHandle != bytes32(0) && previousHandle != handleKey && handleOwners[previousHandle] == request.wallet) {
            delete handleOwners[previousHandle];
        }
        identityOwners[identityKey] = request.wallet;
        handleOwners[handleKey] = request.wallet;
        identityHandles[identityKey] = handleKey;
        emit IdentityLinked(request.wallet, request.platformHash, request.providerUserIdHash, request.usernameHash);
    }

    function unlinkIdentity(bytes32 platformHash, bytes32 providerUserIdHash) external {
        bytes32 identityKey = keccak256(abi.encode(platformHash, providerUserIdHash));
        if (identityOwners[identityKey] != msg.sender) revert NotIdentityOwner();
        bytes32 handleKey = identityHandles[identityKey];
        delete identityOwners[identityKey];
        delete identityHandles[identityKey];
        if (handleOwners[handleKey] == msg.sender) delete handleOwners[handleKey];
        unchecked { nonces[msg.sender]++; }
        emit IdentityUnlinked(msg.sender, platformHash, providerUserIdHash);
    }

    function resolveProviderIdentity(bytes32 platformHash, bytes32 providerUserIdHash)
        external
        view
        returns (address)
    {
        return identityOwners[keccak256(abi.encode(platformHash, providerUserIdHash))];
    }

    function resolveHandle(bytes32 platformHash, bytes32 usernameHash) external view returns (address) {
        return handleOwners[keccak256(abi.encode(platformHash, usernameHash))];
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_DIV_2 || (v != 27 && v != 28)) return address(0);
        signer = ecrecover(digest, v, r, s);
    }
}
