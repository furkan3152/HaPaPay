// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Pays an allowlisted Robinhood Chain token to a verified handle's wallet and takes the HaPaPay fee in
/// the same transaction: the recipient receives exactly `amount`, and the payer also pays `feeFor(payer, amount)`
/// (1% of the amount), split into a burn half for the burn vault and a treasury half.
/// @dev The payer approves this router for amount + fee. Every leg must move its exact amount or the whole payment
/// reverts, so fee-on-transfer tokens fail closed and an issuer pause or block bubbles up unchanged. Nothing is held
/// here between transactions. The vault escrow reads `feeFor`, `splitFee`, `burnVault` and `treasury` from here, so
/// direct payments and vault links always charge the same fee to the same places.
contract HaPaPayRouter {
    error NotOwner();
    error InvalidAddress();
    error InvalidToken();
    error InvalidAmount();
    error InvalidFee();
    error PassTokenFixed();
    error TransferFailed();
    error TransferAmountMismatch();
    error ReentrantCall();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PassUpdated(address indexed token, uint256 minimum, uint256 feeBps);
    event Paid(
        bytes32 indexed paymentRef,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 amount,
        uint256 fee,
        uint256 burnShare,
        uint256 treasuryShare
    );

    /// @notice The fee: 100 basis points (1%) of the amount, paid on top of it.
    uint256 public constant FEE_BPS = 100;
    /// @notice The burn vault's part of every fee: 5,000 basis points (half). The treasury gets the rest.
    uint256 public constant BURN_SHARE_BPS = 5_000;
    uint256 private constant BPS = 10_000;

    address public owner;
    address public burnVault;
    address public treasury;
    /// @notice The holder rate: holders of `passMinimum` of `passToken` pay `passFeeBps` instead of `FEE_BPS`.
    /// Off until the owner names a pass token; the token can be set only once.
    address public passToken;
    uint256 public passMinimum;
    uint256 public passFeeBps;
    bool private entered;

    constructor(address initialBurnVault, address initialTreasury) {
        if (initialBurnVault == address(0) || initialBurnVault.code.length == 0) revert InvalidAddress();
        if (initialTreasury == address(0)) revert InvalidAddress();
        owner = msg.sender;
        burnVault = initialBurnVault;
        treasury = initialTreasury;
        passFeeBps = FEE_BPS;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function securityRevision() public pure returns (uint256) {
        return 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Turns on the holder rate. The token is fixed once set; the minimum and rate may be retuned,
    /// and the rate can never exceed `FEE_BPS`.
    function setPass(address token, uint256 minimum, uint256 feeBps) external onlyOwner {
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        if (passToken != address(0) && token != passToken) revert PassTokenFixed();
        if (minimum == 0) revert InvalidAmount();
        if (feeBps > FEE_BPS) revert InvalidFee();
        passToken = token;
        passMinimum = minimum;
        passFeeBps = feeBps;
        emit PassUpdated(token, minimum, feeBps);
    }

    /// @notice The fee rate in basis points for this payer: the holder rate if they hold `passMinimum` of `passToken`,
    /// otherwise 1%.
    function feeBpsFor(address payer) public view returns (uint256 bps) {
        bps = FEE_BPS;
        address token = passToken;
        if (token == address(0) || passFeeBps >= FEE_BPS) return bps;
        (bool success, bytes memory result) = token.staticcall(abi.encodeWithSelector(0x70a08231, payer));
        if (success && result.length == 32 && abi.decode(result, (uint256)) >= passMinimum) bps = passFeeBps;
    }

    /// @notice The fee this payer pays on top of `amount`, rounded down.
    function feeFor(address payer, uint256 amount) public view returns (uint256) {
        return amount * feeBpsFor(payer) / BPS;
    }

    /// @notice How a fee is divided: the burn half (rounded down) and the treasury's remainder.
    function splitFee(uint256 fee) public pure returns (uint256 burnShare, uint256 treasuryShare) {
        burnShare = fee * BURN_SHARE_BPS / BPS;
        treasuryShare = fee - burnShare;
    }

    /// @notice Sends `amount` of `token` from the caller to `recipient` and the fee to the burn vault and treasury.
    /// @param paymentRef The draft this payment settles, echoed in `Paid` so the server can match the receipt.
    function pay(address token, address recipient, uint256 amount, bytes32 paymentRef)
        external
        nonReentrant
        returns (uint256 fee)
    {
        if (recipient == address(0) || recipient == msg.sender || recipient == address(this)) revert InvalidAddress();
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        if (amount == 0) revert InvalidAmount();
        fee = feeFor(msg.sender, amount);
        (uint256 burnShare, uint256 treasuryShare) = splitFee(fee);
        _pullExact(token, msg.sender, recipient, amount);
        _pullExact(token, msg.sender, burnVault, burnShare);
        _pullExact(token, msg.sender, treasury, treasuryShare);
        emit Paid(paymentRef, msg.sender, recipient, token, amount, fee, burnShare, treasuryShare);
    }

    /// @dev A leg to the payer's own address (the treasury paying) moves nothing, so it is skipped.
    function _pullExact(address token, address from, address to, uint256 amount) private {
        if (amount == 0 || from == to) return;
        uint256 balanceBefore = _balanceOf(token, to);
        (bool success, bytes memory result) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        _checkTokenCall(success, result);
        uint256 balanceAfter = _balanceOf(token, to);
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) revert TransferAmountMismatch();
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

    function _balanceOf(address token, address account) private view returns (uint256 balance) {
        (bool success, bytes memory result) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!success || result.length != 32) revert TransferFailed();
        balance = abi.decode(result, (uint256));
    }
}
