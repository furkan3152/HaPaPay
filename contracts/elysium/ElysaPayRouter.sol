// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ElysaPayRouter
/// @notice Pays verified social handles on Elysium. The payer sends the amount plus a 1% fee added on top: the
/// recipient always receives exactly the amount written and the fee goes to the treasury fixed at deployment.
/// Native HYPE (Elysium's gas token) and any plain ERC-20 are supported. The router never holds funds between calls.
/// @dev There is no owner and no upgrade path. The fee rate is a constant. Every transfer must move its exact amount,
/// so fee-on-transfer or rebasing tokens fail closed.
contract ElysaPayRouter {
    error InvalidAddress();
    error InvalidAmount();
    error InvalidValue();
    error NoteTooLong();
    error BatchTooLarge();
    error TransferFailed();
    error TransferAmountMismatch();
    error ReentrantCall();

    /// @notice One payment. `token` is address(0) for native HYPE.
    event Paid(address indexed payer, address indexed recipient, address indexed token, uint256 amount, uint256 fee, bytes note);

    uint256 public constant FEE_BPS = 100;
    uint256 public constant MAX_NOTE_BYTES = 160;
    uint256 public constant MAX_BATCH = 10;

    address public immutable treasury;
    bool private entered;

    constructor(address initialTreasury) {
        if (initialTreasury == address(0) || initialTreasury == address(this)) revert InvalidAddress();
        treasury = initialTreasury;
    }

    function securityRevision() public pure returns (uint256) {
        return 1;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    /// @notice The fee on `amount`, rounded up so a payment never escapes it.
    function feeFor(uint256 amount) public pure returns (uint256) {
        return (amount * FEE_BPS + 9_999) / 10_000;
    }

    /// @notice Pays `amount` HYPE to `recipient`; `msg.value` must be exactly the amount plus its fee.
    function payNative(address recipient, uint256 amount, bytes calldata note) external payable nonReentrant {
        _check(recipient, amount, note);
        uint256 fee = feeFor(amount);
        if (msg.value != amount + fee) revert InvalidValue();
        _sendNative(recipient, amount);
        _sendNative(treasury, fee);
        emit Paid(msg.sender, recipient, address(0), amount, fee, note);
    }

    /// @notice Pays several people in HYPE in one transaction, each with their own fee; one note for all.
    function payNativeBatch(address[] calldata recipients, uint256[] calldata amounts, bytes calldata note) external payable nonReentrant {
        uint256 count = recipients.length;
        if (count == 0 || count != amounts.length) revert InvalidAmount();
        if (count > MAX_BATCH) revert BatchTooLarge();
        uint256 total;
        uint256 fees;
        for (uint256 i = 0; i < count; i++) {
            _check(recipients[i], amounts[i], note);
            total += amounts[i];
            fees += feeFor(amounts[i]);
        }
        if (msg.value != total + fees) revert InvalidValue();
        for (uint256 i = 0; i < count; i++) {
            uint256 fee = feeFor(amounts[i]);
            _sendNative(recipients[i], amounts[i]);
            emit Paid(msg.sender, recipients[i], address(0), amounts[i], fee, note);
        }
        _sendNative(treasury, fees);
    }

    /// @notice Pays `amount` of an ERC-20 to `recipient` from an allowance of at least the amount plus its fee.
    function payToken(address token, address recipient, uint256 amount, bytes calldata note) external nonReentrant {
        if (token == address(0) || token.code.length == 0) revert InvalidAddress();
        _check(recipient, amount, note);
        uint256 fee = feeFor(amount);
        _pull(token, recipient, amount);
        _pull(token, treasury, fee);
        emit Paid(msg.sender, recipient, token, amount, fee, note);
    }

    function _check(address recipient, uint256 amount, bytes calldata note) private view {
        if (recipient == address(0) || recipient == address(this)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (note.length > MAX_NOTE_BYTES) revert NoteTooLong();
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _pull(address token, address to, uint256 amount) private {
        uint256 before = _balanceOf(token, to);
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, to, amount));
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) revert TransferFailed();
        if (_balanceOf(token, to) - before != amount) revert TransferAmountMismatch();
    }

    function _balanceOf(address token, address owner) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, owner));
        if (!ok || data.length != 32) revert TransferFailed();
        return abi.decode(data, (uint256));
    }

    receive() external payable {
        revert InvalidValue();
    }
}
