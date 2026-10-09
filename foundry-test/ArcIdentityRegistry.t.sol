// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcIdentityRegistry} from "../contracts/ArcIdentityRegistry.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function assume(bool condition) external;
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

/// The Arc identity registry the operator deploys on Arc. Arc vault links use the reviewed StockClaimEscrow, whose
/// cases run in StockClaimEscrow.t.sol.
contract ArcIdentityRegistryTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant VERIFIER_KEY = 0xA11CE;

    address private verifier;

    function setUp() public {
        verifier = vm.addr(VERIFIER_KEY);
    }

    function testFuzz_RegistryAttestationCannotCrossRegistryOrReplay(
        bytes32 providerUserIdHash,
        bytes32 usernameHash,
        bytes32 walletSeed,
        uint32 rawDuration
    ) public {
        address wallet = address(uint160(uint256(keccak256(abi.encode(walletSeed, "wallet")))));
        vm.assume(wallet != address(0));
        uint256 deadline = block.timestamp + uint256(rawDuration) % 1 days + 1;
        ArcIdentityRegistry registry = new ArcIdentityRegistry(verifier);
        ArcIdentityRegistry otherRegistry = new ArcIdentityRegistry(verifier);
        ArcIdentityRegistry.LinkRequest memory request = ArcIdentityRegistry.LinkRequest({
            platformHash: keccak256("github"),
            providerUserIdHash: providerUserIdHash,
            usernameHash: usernameHash,
            wallet: wallet,
            deadline: deadline
        });
        bytes32 attestation = keccak256(abi.encode(
            block.chainid,
            address(registry),
            wallet,
            request.platformHash,
            request.providerUserIdHash,
            request.usernameHash,
            uint256(0),
            deadline
        ));
        bytes memory signature = _sign(attestation);

        (bool crossRegistryAccepted,) = address(otherRegistry).call(
            abi.encodeCall(otherRegistry.linkIdentity, (request, signature))
        );
        require(!crossRegistryAccepted, "cross-registry attestation accepted");
        registry.linkIdentity(request, signature);
        (bool replayAccepted,) = address(registry).call(
            abi.encodeCall(registry.linkIdentity, (request, signature))
        );
        require(!replayAccepted, "registry replay accepted");
        require(registry.nonces(wallet) == 1, "nonce mismatch");
    }

    function test_UnlinkInvalidatesPendingAttestationAndIsolatesNonce() public {
        ArcIdentityRegistry registry = new ArcIdentityRegistry(verifier);
        address wallet = vm.addr(0xBEEF);
        bytes32 platform = keccak256("github");
        bytes32 provider = keccak256("provider-one");
        uint256 deadline = block.timestamp + 1 days;
        {
            ArcIdentityRegistry.LinkRequest memory request = ArcIdentityRegistry.LinkRequest(platform, provider, keccak256("handle-one"), wallet, deadline);
            registry.linkIdentity(request, _registrySignature(address(registry), request, 0));
        }
        ArcIdentityRegistry.LinkRequest memory pending = ArcIdentityRegistry.LinkRequest(platform, provider, keccak256("handle-two"), wallet, deadline);
        (bool strangerUnlinked,) = address(registry).call(abi.encodeCall(registry.unlinkIdentity, (platform, provider)));
        require(!strangerUnlinked && registry.nonces(wallet) == 1, "failed unlink consumed nonce");
        bytes memory stale = _registrySignature(address(registry), pending, 1);
        vm.prank(wallet);
        registry.unlinkIdentity(platform, provider);
        require(registry.nonces(wallet) == 2, "unlink did not consume nonce");
        require(registry.nonces(vm.addr(0xCAFE)) == 0, "other wallet nonce changed");
        (bool staleAccepted,) = address(registry).call(abi.encodeCall(registry.linkIdentity, (pending, stale)));
        require(!staleAccepted, "pending attestation survived unlink");
        registry.linkIdentity(pending, _registrySignature(address(registry), pending, 2));
    }

    function test_SameWalletDistinctProviderCannotOccupyExistingHandle() public {
        ArcIdentityRegistry registry = new ArcIdentityRegistry(verifier);
        address wallet = vm.addr(0xBEEF);
        bytes32 platform = keccak256("github");
        bytes32 handle = keccak256("shared-handle");
        uint256 deadline = block.timestamp + 1 days;
        ArcIdentityRegistry.LinkRequest memory first = ArcIdentityRegistry.LinkRequest(platform, keccak256("provider-one"), handle, wallet, deadline);
        ArcIdentityRegistry.LinkRequest memory second = ArcIdentityRegistry.LinkRequest(platform, keccak256("provider-two"), handle, wallet, deadline);
        registry.linkIdentity(first, _registrySignature(address(registry), first, 0));
        (bool accepted, bytes memory errorData) = address(registry).call(abi.encodeCall(registry.linkIdentity, (
            second, _registrySignature(address(registry), second, 1)
        )));
        require(!accepted && bytes4(errorData) == ArcIdentityRegistry.HandleAlreadyLinked.selector, "same-wallet handle collision accepted");
    }

    function test_RenameCollisionPreservesFirstHandleAndReleasesPreviousHandle() public {
        ArcIdentityRegistry registry = new ArcIdentityRegistry(verifier);
        address wallet = vm.addr(0xBEEF);
        bytes32 platform = keccak256("github");
        bytes32 firstHandle = keccak256("first-handle");
        bytes32 secondHandle = keccak256("second-handle");
        uint256 deadline = block.timestamp + 1 days;
        {
            ArcIdentityRegistry.LinkRequest memory first = ArcIdentityRegistry.LinkRequest(platform, keccak256("provider-one"), firstHandle, wallet, deadline);
            ArcIdentityRegistry.LinkRequest memory second = ArcIdentityRegistry.LinkRequest(platform, keccak256("provider-two"), secondHandle, wallet, deadline);
            registry.linkIdentity(first, _registrySignature(address(registry), first, 0));
            registry.linkIdentity(second, _registrySignature(address(registry), second, 1));
        }
        {
            ArcIdentityRegistry.LinkRequest memory collidingRename = ArcIdentityRegistry.LinkRequest(platform, keccak256("provider-one"), secondHandle, wallet, deadline);
            (bool renamed, bytes memory errorData) = address(registry).call(abi.encodeCall(registry.linkIdentity, (
                collidingRename, _registrySignature(address(registry), collidingRename, 2)
            )));
            require(!renamed && bytes4(errorData) == ArcIdentityRegistry.HandleAlreadyLinked.selector, "rename stole same-wallet handle");
        }
        require(registry.resolveHandle(platform, firstHandle) == wallet, "original handle lost");
        {
            ArcIdentityRegistry.LinkRequest memory first = ArcIdentityRegistry.LinkRequest(platform, keccak256("provider-one"), firstHandle, wallet, deadline);
            registry.linkIdentity(first, _registrySignature(address(registry), first, 2));
            ArcIdentityRegistry.LinkRequest memory released = ArcIdentityRegistry.LinkRequest(platform, keccak256("provider-two"), keccak256("third-handle"), wallet, deadline);
            registry.linkIdentity(released, _registrySignature(address(registry), released, 3));
        }
        require(registry.resolveHandle(platform, secondHandle) == address(0), "old handle not released");
        {
            ArcIdentityRegistry.LinkRequest memory acquisition = ArcIdentityRegistry.LinkRequest(platform, keccak256("provider-three"), secondHandle, wallet, deadline);
            registry.linkIdentity(acquisition, _registrySignature(address(registry), acquisition, 4));
            require(registry.resolveProviderIdentity(platform, acquisition.providerUserIdHash) == wallet, "released handle not acquired");
        }
    }

    function _sign(bytes32 attestation) private returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", attestation));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VERIFIER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _registrySignature(address registry, ArcIdentityRegistry.LinkRequest memory request, uint256 nonce)
        private returns (bytes memory)
    {
        return _sign(keccak256(abi.encode(
            block.chainid, registry, request.wallet, request.platformHash, request.providerUserIdHash,
            request.usernameHash, nonce, request.deadline
        )));
    }
}
