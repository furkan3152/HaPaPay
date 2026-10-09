// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StockClaimEscrow} from "../contracts/StockClaimEscrow.sol";
import {HaPaPayRouter} from "../contracts/HaPaPayRouter.sol";
import {HaPaPayBurnVault} from "../contracts/HaPaPayBurnVault.sol";
import {MockStockToken} from "../tests/fixtures/MockStockToken.sol";
import {AdversarialERC20, NoReturnERC20} from "../tests/fixtures/AdversarialERC20.sol";

interface StockVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function addr(uint256 privateKey) external returns (address);
    function assume(bool condition) external;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
}

contract StockEscrowHandler {
    StockVm private constant vm = StockVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant VERIFIER_KEY = 0xA11CE;
    StockClaimEscrow public immutable escrow;
    HaPaPayRouter private immutable router;
    MockStockToken[2] private tokens;
    uint256[2] private expected;
    bool public recreationAccepted;
    bytes32[] private fundedIds;
    mapping(bytes32 => bool) private everFunded;

    constructor(StockClaimEscrow escrow_, HaPaPayRouter router_, MockStockToken first, MockStockToken second) {
        escrow = escrow_;
        router = router_;
        tokens[0] = first;
        tokens[1] = second;
        first.approve(address(escrow_), type(uint256).max);
        second.approve(address(escrow_), type(uint256).max);
    }

    function token(uint256 index) external view returns (MockStockToken) {
        return tokens[index];
    }

    function expectedBalance(uint256 index) external view returns (uint256) {
        return expected[index];
    }

    function create(uint96 rawAmount, uint48 rawDuration, bytes32 rawPaymentId, bool second) external {
        uint256 index = second ? 1 : 0;
        uint256 amount = uint256(rawAmount) % 1e24 + 1;
        uint256 duration = uint256(rawDuration) % 31 days + 1;
        bytes32 paymentId = rawPaymentId == bytes32(0)
            ? keccak256(abi.encode(rawAmount, rawDuration, fundedIds.length))
            : rawPaymentId;
        if (everFunded[paymentId]) return;
        uint256 total = amount + router.feeFor(address(this), amount);
        tokens[index].mint(address(this), total);
        escrow.createPayment(paymentId, address(tokens[index]), keccak256("x"), keccak256("stateful-stock"), amount, block.timestamp + duration);
        everFunded[paymentId] = true;
        fundedIds.push(paymentId);
        expected[index] += total;
    }

    function settle(uint256 rawIndex, bool preferClaim) external {
        if (fundedIds.length == 0) return;
        bytes32 paymentId = fundedIds[rawIndex % fundedIds.length];
        (address payer, address paymentToken, bytes32 identityKey, uint256 amount, uint256 fee, uint256 expiry) = escrow.payments(paymentId);
        if (payer == address(0)) return;
        if (preferClaim && block.timestamp <= expiry) {
            escrow.claim(paymentId, address(this), expiry, _signature(paymentId, identityKey, paymentToken, amount, expiry));
        } else if (block.timestamp > expiry) {
            escrow.refund(paymentId);
        } else {
            return;
        }
        // A claim pays the fee out to the burn vault and treasury and a refund returns it, so either way it leaves.
        expected[paymentToken == address(tokens[0]) ? 0 : 1] -= amount + fee;
    }

    function _signature(bytes32 paymentId, bytes32 identityKey, address paymentToken, uint256 amount, uint256 expiry)
        private
        returns (bytes memory)
    {
        bytes32 attestation = keccak256(abi.encode(
            block.chainid, address(escrow), paymentId, identityKey, paymentToken, address(this), amount, expiry, expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", attestation));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VERIFIER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function advance(uint48 rawDuration) external {
        vm.warp(block.timestamp + uint256(rawDuration) % 2 days + 1);
    }

    function recreate(uint256 rawIndex, uint96 rawAmount, bool second) external {
        if (fundedIds.length == 0) return;
        bytes32 paymentId = fundedIds[rawIndex % fundedIds.length];
        uint256 index = second ? 1 : 0;
        uint256 amount = uint256(rawAmount) % 1e24 + 1;
        tokens[index].mint(address(this), amount + router.feeFor(address(this), amount));
        (bool accepted,) = address(escrow).call(abi.encodeCall(escrow.createPayment, (
            paymentId, address(tokens[index]), keccak256("x"), keccak256("stateful-stock"), amount, block.timestamp + 1 days
        )));
        if (accepted) recreationAccepted = true;
    }
}

contract StockClaimEscrowTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    StockVm private constant vm = StockVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant VERIFIER_KEY = 0xA11CE;
    uint256 private constant SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    bytes32 private constant PLATFORM = keccak256("github");
    bytes32 private constant PROVIDER = keccak256("424242");

    MockStockToken private tsla;
    MockStockToken private nvda;
    HaPaPayBurnVault private burnVault;
    HaPaPayRouter private router;
    StockClaimEscrow private escrow;
    StockEscrowHandler private handler;
    address private verifier;
    address private recipient;
    address private treasury;

    function setUp() public {
        verifier = vm.addr(VERIFIER_KEY);
        recipient = vm.addr(0xB0B);
        treasury = vm.addr(0x7EA5);
        tsla = new MockStockToken();
        nvda = new MockStockToken();
        burnVault = new HaPaPayBurnVault();
        router = new HaPaPayRouter(address(burnVault), treasury);
        escrow = new StockClaimEscrow(verifier, address(router));
        handler = new StockEscrowHandler(escrow, router, new MockStockToken(), new MockStockToken());
    }

    function test_ConstructorRecordsOwnerVerifierAndRevision() public {
        require(escrow.owner() == address(this), "owner mismatch");
        require(escrow.verifier() == verifier, "verifier mismatch");
        require(escrow.feeRouter() == address(router), "fee router mismatch");
        require(escrow.securityRevision() == 2, "revision mismatch");
        require(escrow.MAX_CLAIM_WINDOW() == 31 days, "claim window mismatch");
        (bool deployed, bytes memory errorData) = address(this).call(abi.encodeCall(this.deployEscrow, (address(0), address(router))));
        require(!deployed && bytes4(errorData) == StockClaimEscrow.InvalidAddress.selector, "zero verifier accepted");
        (deployed, errorData) = address(this).call(abi.encodeCall(this.deployEscrow, (verifier, address(0))));
        require(!deployed && bytes4(errorData) == StockClaimEscrow.InvalidAddress.selector, "zero fee router accepted");
        (deployed, errorData) = address(this).call(abi.encodeCall(this.deployEscrow, (verifier, vm.addr(0xE0A))));
        require(!deployed && bytes4(errorData) == StockClaimEscrow.InvalidAddress.selector, "fee router without code accepted");
    }

    function deployEscrow(address initialVerifier, address initialRouter) external returns (address) {
        return address(new StockClaimEscrow(initialVerifier, initialRouter));
    }

    function testFuzz_CreatePaymentPreservesExactSolvency(uint96 rawAmount, uint48 rawDuration, bytes32 rawPaymentId) public {
        uint256 amount = uint256(rawAmount) % 1e24 + 1;
        uint256 duration = uint256(rawDuration) % 31 days + 1;
        bytes32 paymentId = rawPaymentId == bytes32(0) ? keccak256("nonzero-payment") : rawPaymentId;
        _fund(tsla, paymentId, amount, block.timestamp + duration);

        (address payer, address token, bytes32 identityKey, uint256 recordedAmount, uint256 fee, uint256 expiry) = escrow.payments(paymentId);
        require(payer == address(this), "payer mismatch");
        require(token == address(tsla), "token mismatch");
        require(identityKey == keccak256(abi.encode(PLATFORM, PROVIDER)), "identity mismatch");
        require(recordedAmount == amount, "amount mismatch");
        require(fee == amount / 100, "fee is not 1% rounded down");
        require(expiry == block.timestamp + duration, "expiry mismatch");
        require(tsla.balanceOf(address(escrow)) == amount + fee, "escrow undercollateralized");
        require(tsla.balanceOf(address(this)) == 0, "payer kept tokens");
    }

    function testFuzz_ClaimSignatureBindsTokenEscrowAndChain(uint96 rawAmount, bytes32 rawPaymentId) public {
        uint256 amount = uint256(rawAmount) % 1e24 + 1;
        bytes32 paymentId = rawPaymentId == bytes32(0) ? keccak256("claim-payment") : rawPaymentId;
        uint256 expiry = block.timestamp + 1 days;
        StockClaimEscrow otherEscrow = new StockClaimEscrow(verifier, address(router));
        uint256 fee = router.feeFor(address(this), amount);
        _fund(tsla, paymentId, amount, expiry);
        tsla.mint(address(this), amount + fee);
        tsla.approve(address(otherEscrow), amount + fee);
        otherEscrow.createPayment(paymentId, address(tsla), PLATFORM, PROVIDER, amount, expiry);
        bytes32 identityKey = keccak256(abi.encode(PLATFORM, PROVIDER));

        bytes memory otherToken = _claimSignature(address(escrow), paymentId, identityKey, address(nvda), recipient, amount, expiry, expiry, block.chainid);
        _expectClaimRevert(escrow, paymentId, expiry, otherToken, StockClaimEscrow.InvalidClaim.selector, "token-swapped signature accepted");
        bytes memory signature = _claimSignature(address(escrow), paymentId, identityKey, address(tsla), recipient, amount, expiry, expiry, block.chainid);
        _expectClaimRevert(otherEscrow, paymentId, expiry, signature, StockClaimEscrow.InvalidClaim.selector, "cross-escrow signature accepted");
        bytes memory wrongChain = _claimSignature(address(escrow), paymentId, identityKey, address(tsla), recipient, amount, expiry, expiry, block.chainid + 1);
        _expectClaimRevert(escrow, paymentId, expiry, wrongChain, StockClaimEscrow.InvalidClaim.selector, "wrong-chain signature accepted");
        bytes memory wrongAmount = _claimSignature(address(escrow), paymentId, identityKey, address(tsla), recipient, amount + 1, expiry, expiry, block.chainid);
        _expectClaimRevert(escrow, paymentId, expiry, wrongAmount, StockClaimEscrow.InvalidClaim.selector, "wrong-amount signature accepted");

        vm.prank(recipient);
        escrow.claim(paymentId, recipient, expiry, signature);
        require(tsla.balanceOf(recipient) == amount, "claim amount mismatch");
        require(tsla.balanceOf(address(escrow)) == 0, "escrow kept claimed tokens");
        require(tsla.balanceOf(address(burnVault)) == fee / 2 && tsla.balanceOf(treasury) == fee - fee / 2, "fee split mismatch");
        _expectClaimRevert(escrow, paymentId, expiry, signature, StockClaimEscrow.PaymentUnavailable.selector, "claim replay accepted");
        require(tsla.balanceOf(address(otherEscrow)) == amount + fee, "other escrow drained");
    }

    function test_ClaimMustBeSentByTheAttestedRecipient() public {
        bytes32 paymentId = keccak256("sender-bound");
        uint256 expiry = block.timestamp + 1 days;
        _fund(tsla, paymentId, 3 ether, expiry);
        bytes memory signature = _signedClaim(paymentId, tsla, 3 ether, expiry, expiry);
        (bool relayed, bytes memory errorData) = address(escrow).call(abi.encodeCall(escrow.claim, (paymentId, recipient, expiry, signature)));
        require(!relayed && bytes4(errorData) == StockClaimEscrow.InvalidClaim.selector, "third party relayed claim");
        vm.prank(recipient);
        (bool zeroRecipient, bytes memory zeroError) = address(escrow).call(abi.encodeCall(escrow.claim, (paymentId, address(0), expiry, signature)));
        require(!zeroRecipient && bytes4(zeroError) == StockClaimEscrow.InvalidClaim.selector, "zero recipient accepted");
        vm.prank(recipient);
        escrow.claim(paymentId, recipient, expiry, signature);
        require(tsla.balanceOf(recipient) == 3 ether, "claim not delivered");
    }

    function test_ClaimRejectsMalleableShortAndWrongVersionSignatures() public {
        bytes32 paymentId = keccak256("malleable");
        uint256 expiry = block.timestamp + 1 days;
        _fund(tsla, paymentId, 1 ether, expiry);
        bytes32 attestation = keccak256(abi.encode(
            block.chainid, address(escrow), paymentId, keccak256(abi.encode(PLATFORM, PROVIDER)), address(tsla), recipient, uint256(1 ether), expiry, expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", attestation));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VERIFIER_KEY, digest);
        bytes memory highS = abi.encodePacked(r, bytes32(SECP256K1N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        require(ecrecover(digest, v == 27 ? 28 : 27, r, bytes32(SECP256K1N - uint256(s))) == verifier, "fixture is not a valid twin");
        _expectClaimRevert(escrow, paymentId, expiry, highS, StockClaimEscrow.InvalidClaim.selector, "high-s twin accepted");
        _expectClaimRevert(escrow, paymentId, expiry, abi.encodePacked(r, s), StockClaimEscrow.InvalidClaim.selector, "64-byte signature accepted");
        _expectClaimRevert(escrow, paymentId, expiry, abi.encodePacked(r, s, v - 27), StockClaimEscrow.InvalidClaim.selector, "v below 27 accepted");
        vm.prank(recipient);
        escrow.claim(paymentId, recipient, expiry, abi.encodePacked(r, s, v));
    }

    function test_ClaimAndRefundWindowsMeetWithoutOverlap() public {
        bytes32 paymentId = keccak256("window");
        uint256 expiry = block.timestamp + 2 days;
        _fund(tsla, paymentId, 5 ether, expiry);
        bytes memory early = _signedClaim(paymentId, tsla, 5 ether, expiry, block.timestamp + 1 hours);
        vm.warp(block.timestamp + 1 hours + 1);
        _expectClaimRevert(escrow, paymentId, block.timestamp - 1, early, StockClaimEscrow.ClaimExpired.selector, "stale claim deadline accepted");

        vm.warp(expiry);
        (bool refundedAtExpiry, bytes memory refundError) = address(escrow).call(abi.encodeCall(escrow.refund, (paymentId)));
        require(!refundedAtExpiry && bytes4(refundError) == StockClaimEscrow.RefundNotReady.selector, "refund open at expiry");
        uint256 snapshotTime = block.timestamp;
        vm.warp(expiry + 1);
        bytes memory late = _signedClaim(paymentId, tsla, 5 ether, expiry, expiry + 1 hours);
        _expectClaimRevert(escrow, paymentId, expiry + 1 hours, late, StockClaimEscrow.ClaimExpired.selector, "claim open after expiry");

        vm.warp(snapshotTime);
        bytes memory lastMoment = _signedClaim(paymentId, tsla, 5 ether, expiry, expiry);
        vm.prank(recipient);
        escrow.claim(paymentId, recipient, expiry, lastMoment);
        require(tsla.balanceOf(recipient) == 5 ether, "claim at expiry failed");
    }

    function test_RefundGoesOnlyToThePayerAfterExpiry() public {
        bytes32 paymentId = keccak256("refund");
        uint256 expiry = block.timestamp + 1 days;
        _fund(tsla, paymentId, 7 ether, expiry);
        (bool early, bytes memory earlyError) = address(escrow).call(abi.encodeCall(escrow.refund, (paymentId)));
        require(!early && bytes4(earlyError) == StockClaimEscrow.RefundNotReady.selector, "early refund accepted");
        vm.warp(expiry + 1);
        vm.prank(recipient);
        (bool stranger, bytes memory strangerError) = address(escrow).call(abi.encodeCall(escrow.refund, (paymentId)));
        require(!stranger && bytes4(strangerError) == StockClaimEscrow.NotPayer.selector, "stranger refund accepted");
        escrow.refund(paymentId);
        require(tsla.balanceOf(address(this)) == 7.07 ether, "refund did not return the amount and the fee");
        (bool twice, bytes memory twiceError) = address(escrow).call(abi.encodeCall(escrow.refund, (paymentId)));
        require(!twice && bytes4(twiceError) == StockClaimEscrow.PaymentUnavailable.selector, "double refund accepted");
        (bool missing, bytes memory missingError) = address(escrow).call(abi.encodeCall(escrow.refund, (keccak256("never-funded"))));
        require(!missing && bytes4(missingError) == StockClaimEscrow.PaymentUnavailable.selector, "missing payment refunded");
    }

    function test_CreatePaymentRejectsInvalidInputs() public {
        tsla.mint(address(this), 10 ether);
        tsla.approve(address(escrow), 10 ether);
        uint256 expiry = block.timestamp + 1 days;
        _expectCreateRevert(bytes32(0), address(tsla), 1 ether, expiry, StockClaimEscrow.PaymentAlreadyExists.selector, "zero payment ID accepted");
        _expectCreateRevert(keccak256("a"), address(0), 1 ether, expiry, StockClaimEscrow.InvalidToken.selector, "zero token accepted");
        _expectCreateRevert(keccak256("a"), vm.addr(0xE0A), 1 ether, expiry, StockClaimEscrow.InvalidToken.selector, "account without code accepted as token");
        _expectCreateRevert(keccak256("a"), address(tsla), 0, expiry, StockClaimEscrow.InvalidAmount.selector, "zero amount accepted");
        _expectCreateRevert(keccak256("a"), address(tsla), 1 ether, block.timestamp, StockClaimEscrow.InvalidExpiry.selector, "expiry now accepted");
        _expectCreateRevert(keccak256("a"), address(tsla), 1 ether, block.timestamp + 31 days + 1, StockClaimEscrow.InvalidExpiry.selector, "window over 31 days accepted");
        escrow.createPayment(keccak256("a"), address(tsla), PLATFORM, PROVIDER, 1 ether, block.timestamp + 31 days);
        require(tsla.balanceOf(address(escrow)) == 1.01 ether, "31-day payment not funded with its fee");
    }

    function test_IssuerPauseAndBlocksBubbleUpAndKeepThePaymentFunded() public {
        bytes32 paymentId = keccak256("issuer-controls");
        uint256 expiry = block.timestamp + 1 days;
        tsla.setBlocked(address(this), true);
        tsla.mint(address(this), 4.04 ether);
        tsla.approve(address(escrow), 4.04 ether);
        (bool blockedFunding, bytes memory fundingError) = address(escrow).call(abi.encodeCall(escrow.createPayment, (
            paymentId, address(tsla), PLATFORM, PROVIDER, 4 ether, expiry
        )));
        require(!blockedFunding && keccak256(fundingError) == keccak256(abi.encodeWithSelector(MockStockToken.Blocked.selector, address(this))), "blocked payer funded");
        tsla.setBlocked(address(this), false);
        escrow.createPayment(paymentId, address(tsla), PLATFORM, PROVIDER, 4 ether, expiry);

        bytes memory signature = _signedClaim(paymentId, tsla, 4 ether, expiry, expiry);
        tsla.setPaused(true);
        _expectClaimRevert(escrow, paymentId, expiry, signature, MockStockToken.IsPaused.selector, "claim ignored issuer pause");
        tsla.setPaused(false);
        tsla.setBlocked(recipient, true);
        vm.prank(recipient);
        (bool blockedClaim, bytes memory claimError) = address(escrow).call(abi.encodeCall(escrow.claim, (paymentId, recipient, expiry, signature)));
        require(!blockedClaim && keccak256(claimError) == keccak256(abi.encodeWithSelector(MockStockToken.Blocked.selector, recipient)), "claim ignored recipient block");
        (address payer,,, uint256 amount, uint256 fee,) = escrow.payments(paymentId);
        require(payer == address(this) && amount == 4 ether && fee == 0.04 ether && tsla.balanceOf(address(escrow)) == 4.04 ether, "failed claim released the payment");

        vm.warp(expiry + 1);
        tsla.setPaused(true);
        (bool pausedRefund, bytes memory refundError) = address(escrow).call(abi.encodeCall(escrow.refund, (paymentId)));
        require(!pausedRefund && bytes4(refundError) == MockStockToken.IsPaused.selector, "refund ignored issuer pause");
        tsla.setPaused(false);
        escrow.refund(paymentId);
        require(tsla.balanceOf(address(this)) == 4.04 ether, "refund after unpause failed");
    }

    function test_ClaimedAndRefundedIdsCannotBeFundedAgain() public {
        bytes32 claimed = keccak256("claimed-tombstone");
        bytes32 refunded = keccak256("refunded-tombstone");
        uint256 expiry = block.timestamp + 1 days;
        _fund(tsla, claimed, 1 ether, expiry);
        _fund(nvda, refunded, 2 ether, block.timestamp + 1);
        bytes memory signature = _signedClaim(claimed, tsla, 1 ether, expiry, expiry);
        vm.prank(recipient);
        escrow.claim(claimed, recipient, expiry, signature);
        vm.warp(block.timestamp + 2);
        escrow.refund(refunded);

        nvda.mint(address(this), 2 ether);
        nvda.approve(address(escrow), 2 ether);
        _expectCreateRevert(claimed, address(nvda), 1 ether, block.timestamp + 1 days, StockClaimEscrow.PaymentAlreadyExists.selector, "claimed ID refunded under another token");
        _expectCreateRevert(refunded, address(nvda), 2 ether, block.timestamp + 1 days, StockClaimEscrow.PaymentAlreadyExists.selector, "refunded ID recreated");
        _expectClaimRevert(escrow, claimed, expiry, signature, StockClaimEscrow.PaymentUnavailable.selector, "signature replayed after tombstone");
    }

    function test_PaymentsInDifferentTokensStayIsolated() public {
        uint256 expiry = block.timestamp + 1 days;
        _fund(tsla, keccak256("tsla"), 2 ether, expiry);
        _fund(nvda, keccak256("nvda"), 9 ether, expiry);
        bytes memory signature = _signedClaim(keccak256("tsla"), tsla, 2 ether, expiry, expiry);
        vm.prank(recipient);
        escrow.claim(keccak256("tsla"), recipient, expiry, signature);
        require(tsla.balanceOf(recipient) == 2 ether && nvda.balanceOf(recipient) == 0, "claim crossed tokens");
        require(tsla.balanceOf(address(escrow)) == 0 && nvda.balanceOf(address(escrow)) == 9.09 ether, "other token balance moved");
    }

    function test_FeeOnTransferAndFalseReturningTokensAreRejected() public {
        AdversarialERC20 adversarial = new AdversarialERC20();
        adversarial.mint(address(this), 10);
        adversarial.approve(address(escrow), 10);
        adversarial.setFee(1);
        _expectCreateRevert(keccak256("fee"), address(adversarial), 5, block.timestamp + 1 days, StockClaimEscrow.TransferAmountMismatch.selector, "fee-on-transfer funding accepted");
        adversarial.setFee(0);
        adversarial.setReturnFalse(true);
        _expectCreateRevert(keccak256("false"), address(adversarial), 5, block.timestamp + 1 days, StockClaimEscrow.TransferFailed.selector, "false-returning funding accepted");
        (address payer,,,,,) = escrow.payments(keccak256("fee"));
        require(payer == address(0) && adversarial.balanceOf(address(escrow)) == 0, "rejected funding left state");
    }

    function test_TokensWithoutReturnValuesStillSettleExactly() public {
        NoReturnERC20 quiet = new NoReturnERC20();
        quiet.mint(address(this), 6);
        quiet.approve(address(escrow), 6);
        uint256 expiry = block.timestamp + 1 days;
        escrow.createPayment(keccak256("quiet"), address(quiet), PLATFORM, PROVIDER, 6, expiry);
        bytes32 attestation = keccak256(abi.encode(
            block.chainid, address(escrow), keccak256("quiet"), keccak256(abi.encode(PLATFORM, PROVIDER)), address(quiet), recipient, uint256(6), expiry, expiry
        ));
        vm.prank(recipient);
        escrow.claim(keccak256("quiet"), recipient, expiry, _sign(attestation));
        require(quiet.balanceOf(recipient) == 6, "quiet token claim failed");
    }

    function test_TokenCallbackCannotClaimDuringFunding() public {
        AdversarialERC20 adversarial = new AdversarialERC20();
        adversarial.mint(address(this), 10);
        adversarial.approve(address(escrow), 10);
        uint256 expiry = block.timestamp + 1 days;
        escrow.createPayment(keccak256("open"), address(adversarial), PLATFORM, PROVIDER, 5, expiry);
        // The token itself is the attested recipient, so this nested claim would succeed if funding were reentrant.
        bytes memory signature = _claimSignature(
            address(escrow), keccak256("open"), keccak256(abi.encode(PLATFORM, PROVIDER)), address(adversarial), address(adversarial), 5, expiry, expiry, block.chainid
        );
        adversarial.configureReentry(address(escrow), abi.encodeCall(escrow.claim, (keccak256("open"), address(adversarial), expiry, signature)));
        escrow.createPayment(keccak256("outer"), address(adversarial), PLATFORM, PROVIDER, 3, expiry);
        require(!adversarial.reentrySucceeded(), "reentrant claim succeeded");
        (address open,,,,,) = escrow.payments(keccak256("open"));
        require(open == address(this), "open payment released during funding");
        require(adversarial.balanceOf(address(escrow)) == 8, "escrow balance mismatch");
    }

    function test_OwnerControlsRotateTheVerifierAndRejectStrangers() public {
        bytes32 paymentId = keccak256("rotation");
        uint256 expiry = block.timestamp + 1 days;
        _fund(tsla, paymentId, 1 ether, expiry);
        bytes memory oldSignature = _signedClaim(paymentId, tsla, 1 ether, expiry, expiry);
        address nextVerifier = vm.addr(0xD00D);

        vm.prank(recipient);
        (bool strangerVerifier, bytes memory verifierError) = address(escrow).call(abi.encodeCall(escrow.setVerifier, (nextVerifier)));
        require(!strangerVerifier && bytes4(verifierError) == StockClaimEscrow.NotOwner.selector, "stranger rotated verifier");
        vm.prank(recipient);
        (bool strangerOwner, bytes memory ownerError) = address(escrow).call(abi.encodeCall(escrow.transferOwnership, (recipient)));
        require(!strangerOwner && bytes4(ownerError) == StockClaimEscrow.NotOwner.selector, "stranger took ownership");
        (bool zeroVerifier, bytes memory zeroError) = address(escrow).call(abi.encodeCall(escrow.setVerifier, (address(0))));
        require(!zeroVerifier && bytes4(zeroError) == StockClaimEscrow.InvalidAddress.selector, "zero verifier accepted");
        (bool zeroOwner, bytes memory zeroOwnerError) = address(escrow).call(abi.encodeCall(escrow.transferOwnership, (address(0))));
        require(!zeroOwner && bytes4(zeroOwnerError) == StockClaimEscrow.InvalidAddress.selector, "zero owner accepted");

        vm.recordLogs();
        escrow.setVerifier(nextVerifier);
        escrow.transferOwnership(recipient);
        StockVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2, "control events missing");
        require(logs[0].topics[0] == StockClaimEscrow.VerifierUpdated.selector && logs[0].topics[1] == bytes32(uint256(uint160(verifier))) && logs[0].topics[2] == bytes32(uint256(uint160(nextVerifier))), "verifier event mismatch");
        require(logs[1].topics[0] == StockClaimEscrow.OwnershipTransferred.selector && logs[1].topics[1] == bytes32(uint256(uint160(address(this)))) && logs[1].topics[2] == bytes32(uint256(uint160(recipient))), "ownership event mismatch");
        require(escrow.owner() == recipient && escrow.verifier() == nextVerifier, "controls not updated");
        _expectClaimRevert(escrow, paymentId, expiry, oldSignature, StockClaimEscrow.InvalidClaim.selector, "retired verifier signature accepted");
        (bool formerOwner,) = address(escrow).call(abi.encodeCall(escrow.setVerifier, (verifier)));
        require(!formerOwner, "former owner kept control");
    }

    function test_EventsCarryTheFieldsTheServerVerifies() public {
        bytes32 paymentId = keccak256("events");
        uint256 expiry = block.timestamp + 1 days;
        tsla.mint(address(this), 3.03 ether);
        tsla.approve(address(escrow), 3.03 ether);
        vm.recordLogs();
        escrow.createPayment(paymentId, address(tsla), PLATFORM, PROVIDER, 3 ether, expiry);
        StockVm.Log[] memory created = vm.getRecordedLogs();
        StockVm.Log memory event_ = created[created.length - 1];
        require(event_.emitter == address(escrow) && event_.topics[0] == StockClaimEscrow.PaymentCreated.selector, "created event missing");
        require(event_.topics[1] == paymentId && event_.topics[2] == bytes32(uint256(uint160(address(this)))) && event_.topics[3] == keccak256(abi.encode(PLATFORM, PROVIDER)), "created topics mismatch");
        (address token, uint256 amount, uint256 fee, uint256 recordedExpiry) = abi.decode(event_.data, (address, uint256, uint256, uint256));
        require(token == address(tsla) && amount == 3 ether && fee == 0.03 ether && recordedExpiry == expiry, "created data mismatch");

        bytes memory signature = _signedClaim(paymentId, tsla, 3 ether, expiry, expiry);
        vm.recordLogs();
        vm.prank(recipient);
        escrow.claim(paymentId, recipient, expiry, signature);
        StockVm.Log[] memory claimed = vm.getRecordedLogs();
        event_ = claimed[claimed.length - 1];
        require(event_.topics[0] == StockClaimEscrow.PaymentClaimed.selector && event_.topics[1] == paymentId && event_.topics[2] == bytes32(uint256(uint160(recipient))) && event_.topics[3] == bytes32(uint256(uint160(address(tsla)))), "claimed topics mismatch");
        (uint256 claimedAmount, uint256 claimedFee) = abi.decode(event_.data, (uint256, uint256));
        require(claimedAmount == 3 ether && claimedFee == 0.03 ether, "claimed amount or fee mismatch");
    }

    function test_ClaimDeliversTheAmountAndOnlyThenPaysTheFeeSplit() public {
        bytes32 paymentId = keccak256("fee-split");
        uint256 expiry = block.timestamp + 1 days;
        _fund(tsla, paymentId, 100 ether, expiry);
        require(tsla.balanceOf(address(escrow)) == 101 ether, "fee not held with the amount");
        require(tsla.balanceOf(address(burnVault)) == 0 && tsla.balanceOf(treasury) == 0, "fee paid before the claim");
        bytes memory signature = _signedClaim(paymentId, tsla, 100 ether, expiry, expiry);
        vm.prank(recipient);
        escrow.claim(paymentId, recipient, expiry, signature);
        require(tsla.balanceOf(recipient) == 100 ether, "recipient did not get the exact amount");
        require(tsla.balanceOf(address(burnVault)) == 0.5 ether, "burn half missing");
        require(tsla.balanceOf(treasury) == 0.5 ether, "treasury half missing");
        require(tsla.balanceOf(address(escrow)) == 0, "escrow kept part of the fee");
    }

    function test_RefundReturnsTheAmountAndTheFee() public {
        bytes32 paymentId = keccak256("fee-refund");
        uint256 expiry = block.timestamp + 1 days;
        _fund(tsla, paymentId, 50 ether, expiry);
        vm.warp(expiry + 1);
        vm.recordLogs();
        escrow.refund(paymentId);
        StockVm.Log[] memory refunded = vm.getRecordedLogs();
        StockVm.Log memory event_ = refunded[refunded.length - 1];
        require(event_.topics[0] == StockClaimEscrow.PaymentRefunded.selector && event_.topics[1] == paymentId, "refund event missing");
        (uint256 amount, uint256 fee) = abi.decode(event_.data, (uint256, uint256));
        require(amount == 50 ether && fee == 0.5 ether, "refund event amount or fee mismatch");
        require(tsla.balanceOf(address(this)) == 50.5 ether, "fee not refunded");
        require(tsla.balanceOf(address(burnVault)) == 0 && tsla.balanceOf(treasury) == 0, "fee charged on a refund");
    }

    function test_PassHoldersFundAtTheRouterPassRate() public {
        MockStockToken passToken = new MockStockToken();
        router.setPass(address(passToken), 100_000 ether, 50);
        bytes32 regular = keccak256("regular-rate");
        _fund(tsla, regular, 10 ether, block.timestamp + 1 days);
        (,,,, uint256 regularFee,) = escrow.payments(regular);
        require(regularFee == 0.1 ether, "regular rate changed");
        passToken.mint(address(this), 100_000 ether);
        bytes32 holder = keccak256("pass-rate");
        _fund(tsla, holder, 10 ether, block.timestamp + 1 days);
        (,,,, uint256 holderFee,) = escrow.payments(holder);
        require(holderFee == 0.05 ether, "pass rate not applied");
    }

    function invariant_EscrowHoldsExactlyTheOpenPaymentsPerToken() public view {
        require(!handler.recreationAccepted(), "stateful funded payment ID recreated");
        require(handler.token(0).balanceOf(address(escrow)) == handler.expectedBalance(0), "first token solvency violated");
        require(handler.token(1).balanceOf(address(escrow)) == handler.expectedBalance(1), "second token solvency violated");
    }

    function test_HandlerSettlementAndRecreationReachOuterInvariant() public {
        handler.create(10, 100, keccak256("handler-first"), false);
        handler.create(20, 100, keccak256("handler-second"), true);
        handler.settle(0, true);
        handler.advance(200);
        handler.settle(1, false);
        require(handler.expectedBalance(0) == 0 && handler.expectedBalance(1) == 0, "handler did not settle funded IDs");
        handler.recreate(0, 10, true);
        invariant_EscrowHoldsExactlyTheOpenPaymentsPerToken();
    }

    // Forge calls these selectors when building the invariant target set. Keeping
    // them here avoids a forge-std dependency while targeting only the handler.
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetArtifactSelectors() public pure returns (FuzzArtifactSelector[] memory values) {}
    function targetArtifacts() public pure returns (string[] memory values) {}
    function excludeArtifacts() public pure returns (string[] memory values) {}
    function targetSenders() public pure returns (address[] memory values) {}
    function excludeSenders() public pure returns (address[] memory values) {}
    function excludeContracts() public pure returns (address[] memory values) {}
    function targetInterfaces() public pure returns (FuzzInterface[] memory values) {}
    function targetSelectors() public pure returns (FuzzSelector[] memory values) {}
    function excludeSelectors() public pure returns (FuzzSelector[] memory values) {}

    function _fund(MockStockToken token, bytes32 paymentId, uint256 amount, uint256 expiry) private {
        uint256 total = amount + router.feeFor(address(this), amount);
        token.mint(address(this), total);
        token.approve(address(escrow), total);
        escrow.createPayment(paymentId, address(token), PLATFORM, PROVIDER, amount, expiry);
    }

    function _expectCreateRevert(bytes32 paymentId, address token, uint256 amount, uint256 expiry, bytes4 selector, string memory reason) private {
        (bool accepted, bytes memory errorData) = address(escrow).call(abi.encodeCall(escrow.createPayment, (
            paymentId, token, PLATFORM, PROVIDER, amount, expiry
        )));
        require(!accepted && bytes4(errorData) == selector, reason);
    }

    function _expectClaimRevert(
        StockClaimEscrow target,
        bytes32 paymentId,
        uint256 claimDeadline,
        bytes memory signature,
        bytes4 selector,
        string memory reason
    ) private {
        vm.prank(recipient);
        (bool accepted, bytes memory errorData) = address(target).call(abi.encodeCall(target.claim, (paymentId, recipient, claimDeadline, signature)));
        require(!accepted && bytes4(errorData) == selector, reason);
    }

    function _signedClaim(bytes32 paymentId, MockStockToken token, uint256 amount, uint256 expiry, uint256 claimDeadline)
        private returns (bytes memory)
    {
        return _claimSignature(address(escrow), paymentId, keccak256(abi.encode(PLATFORM, PROVIDER)), address(token), recipient, amount, expiry, claimDeadline, block.chainid);
    }

    function _claimSignature(
        address targetEscrow,
        bytes32 paymentId,
        bytes32 identityKey,
        address token,
        address claimant,
        uint256 amount,
        uint256 expiry,
        uint256 claimDeadline,
        uint256 chainId
    ) private returns (bytes memory) {
        return _sign(keccak256(abi.encode(
            chainId, targetEscrow, paymentId, identityKey, token, claimant, amount, expiry, claimDeadline
        )));
    }

    function _sign(bytes32 attestation) private returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", attestation));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VERIFIER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }
}
