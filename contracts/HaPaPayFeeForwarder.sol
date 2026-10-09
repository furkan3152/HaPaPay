// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Stands in for the burn vault on a chain where the burn token cannot be bought and burned on chain (Arc):
/// the fee router pays the burn half of each HaPaPay fee here, and `forward` sends it on to the treasury fixed at
/// deployment. Buying and burning with it is the operator's commitment; this contract does not enforce it.
/// @dev Anyone may call `forward`, and tokens can only ever go to the treasury. Each forward must move its exact
/// amount, so a fee-on-transfer token fails closed. Holds nothing but fees waiting for the next forward.
contract HaPaPayFeeForwarder {
    error InvalidAddress();
    error InvalidToken();
    error TransferFailed();
    error TransferAmountMismatch();
    error ReentrantCall();

    event Forwarded(address indexed token, address indexed treasury, uint256 amount);

    address public treasury;
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

    /// @notice Sends everything this contract holds of `token` to the treasury. Returns the amount forwarded.
    function forward(address token) external nonReentrant returns (uint256 amount) {
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        amount = _balanceOf(token, address(this));
        if (amount == 0) return 0;
        address to = treasury;
        uint256 balanceBefore = _balanceOf(token, to);
        (bool success, bytes memory result) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!success) {
            if (result.length != 0) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
            revert TransferFailed();
        }
        if (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool)))) revert TransferFailed();
        uint256 balanceAfter = _balanceOf(token, to);
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) revert TransferAmountMismatch();
        emit Forwarded(token, to, amount);
    }

    function _balanceOf(address token, address account) private view returns (uint256 balance) {
        (bool success, bytes memory result) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!success || result.length != 32) revert TransferFailed();
        balance = abi.decode(result, (uint256));
    }
}
