// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The fee schedule the escrow charges: the HaPaPay fee router.
interface IFeeRouter {
    function feeFor(address payer, uint256 amount) external view returns (uint256);
    function splitFee(uint256 fee) external pure returns (uint256 burnShare, uint256 treasuryShare);
    function burnVault() external view returns (address);
    function treasury() external view returns (address);
}

/// @notice Holds a Robinhood Chain token for a social account that has not joined HaPaPay yet.
/// @dev Same trust model as ArcClaimEscrow: the verifier signs a claim only after official OAuth proves the
/// immutable provider user ID. Each payment names its own ERC-20 and the claim attestation binds that token.
/// Stock Tokens keep their issuer controls, so an issuer pause or compliance-list block makes a claim or a
/// refund revert until it is lifted; nothing here can override the token.
/// The payer funds the amount plus the fee router's fee for them. A claim delivers exactly the amount and only
/// then pays the fee to the router's burn vault and treasury; a refund returns the amount and the fee.
contract StockClaimEscrow {
    error NotOwner();
    error InvalidAddress();
    error InvalidToken();
    error InvalidAmount();
    error InvalidExpiry();
    error PaymentAlreadyExists();
    error PaymentUnavailable();
    error ClaimExpired();
    error InvalidClaim();
    error NotPayer();
    error RefundNotReady();
    error TransferFailed();
    error TransferAmountMismatch();
    error ReentrantCall();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event PaymentCreated(
        bytes32 indexed paymentId,
        address indexed payer,
        bytes32 indexed identityKey,
        address token,
        uint256 amount,
        uint256 fee,
        uint256 expiry
    );
    event PaymentClaimed(
        bytes32 indexed paymentId, address indexed recipient, address indexed token, uint256 amount, uint256 fee
    );
    event PaymentRefunded(
        bytes32 indexed paymentId, address indexed payer, address indexed token, uint256 amount, uint256 fee
    );

    /// @notice A claim window longer than this is rejected, so a mistyped expiry cannot lock tokens for years.
    uint256 public constant MAX_CLAIM_WINDOW = 31 days;

    uint256 private constant SECP256K1N_DIV_2 =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct Payment {
        address payer;
        address token;
        bytes32 identityKey;
        uint256 amount;
        uint256 fee;
        uint256 expiry;
    }

    address public owner;
    address public verifier;
    address public feeRouter;
    mapping(bytes32 paymentId => Payment payment) public payments;
    mapping(bytes32 paymentId => bool funded) private fundedPaymentIds;
    bool private entered;

    constructor(address initialVerifier, address initialFeeRouter) {
        if (initialVerifier == address(0)) revert InvalidAddress();
        if (initialFeeRouter == address(0) || initialFeeRouter.code.length == 0) revert InvalidAddress();
        owner = msg.sender;
        verifier = initialVerifier;
        feeRouter = initialFeeRouter;
        emit OwnershipTransferred(address(0), msg.sender);
        emit VerifierUpdated(address(0), initialVerifier);
    }

    function securityRevision() public pure returns (uint256) {
        return 2;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
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
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function createPayment(
        bytes32 paymentId,
        address token,
        bytes32 platformHash,
        bytes32 providerUserIdHash,
        uint256 amount,
        uint256 expiry
    ) external nonReentrant {
        if (paymentId == bytes32(0) || fundedPaymentIds[paymentId]) revert PaymentAlreadyExists();
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_CLAIM_WINDOW) revert InvalidExpiry();
        bytes32 identityKey = keccak256(abi.encode(platformHash, providerUserIdHash));
        uint256 fee = IFeeRouter(feeRouter).feeFor(msg.sender, amount);
        uint256 total = amount + fee;
        fundedPaymentIds[paymentId] = true;
        payments[paymentId] = Payment(msg.sender, token, identityKey, amount, fee, expiry);
        uint256 balanceBefore = _balanceOf(token, address(this));
        _safeTransferFrom(token, msg.sender, address(this), total);
        uint256 balanceAfter = _balanceOf(token, address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != total) {
            revert TransferAmountMismatch();
        }
        emit PaymentCreated(paymentId, msg.sender, identityKey, token, amount, fee, expiry);
    }

    function claim(
        bytes32 paymentId,
        address recipient,
        uint256 claimDeadline,
        bytes calldata signature
    ) external nonReentrant {
        Payment memory payment = payments[paymentId];
        if (payment.payer == address(0)) revert PaymentUnavailable();
        if (recipient == address(0) || msg.sender != recipient) revert InvalidClaim();
        if (block.timestamp > payment.expiry || block.timestamp > claimDeadline) revert ClaimExpired();
        bytes32 attestation = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                paymentId,
                payment.identityKey,
                payment.token,
                recipient,
                payment.amount,
                payment.expiry,
                claimDeadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", attestation));
        if (_recover(digest, signature) != verifier) revert InvalidClaim();
        delete payments[paymentId];
        _safeTransferExact(payment.token, recipient, payment.amount);
        if (payment.fee != 0) {
            IFeeRouter router = IFeeRouter(feeRouter);
            (uint256 burnShare, uint256 treasuryShare) = router.splitFee(payment.fee);
            if (burnShare != 0) _safeTransferExact(payment.token, router.burnVault(), burnShare);
            if (treasuryShare != 0) _safeTransferExact(payment.token, router.treasury(), treasuryShare);
        }
        emit PaymentClaimed(paymentId, recipient, payment.token, payment.amount, payment.fee);
    }

    function refund(bytes32 paymentId) external nonReentrant {
        Payment memory payment = payments[paymentId];
        if (payment.payer == address(0)) revert PaymentUnavailable();
        if (msg.sender != payment.payer) revert NotPayer();
        if (block.timestamp <= payment.expiry) revert RefundNotReady();
        delete payments[paymentId];
        _safeTransferExact(payment.token, payment.payer, payment.amount + payment.fee);
        emit PaymentRefunded(paymentId, payment.payer, payment.token, payment.amount, payment.fee);
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool success, bytes memory result) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        _checkTokenCall(success, result);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory result) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        _checkTokenCall(success, result);
    }

    /// @dev A token revert is re-raised unchanged, so an issuer pause or block keeps its own error selector.
    function _checkTokenCall(bool success, bytes memory result) private pure {
        if (!success) {
            if (result.length != 0) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
            revert TransferFailed();
        }
        if (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeTransferExact(address token, address to, uint256 amount) private {
        uint256 balanceBefore = _balanceOf(token, to);
        _safeTransfer(token, to, amount);
        uint256 balanceAfter = _balanceOf(token, to);
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) {
            revert TransferAmountMismatch();
        }
    }

    function _balanceOf(address token, address account) private view returns (uint256 balance) {
        (bool success, bytes memory result) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!success || result.length != 32) revert TransferFailed();
        balance = abi.decode(result, (uint256));
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
