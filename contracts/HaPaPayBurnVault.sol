// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Collects the burn half of every HaPaPay fee and can only turn it into the burn token, which is burned.
/// @dev Fees arrive as plain ERC-20 transfers from the fee router and the vault escrow. Before the owner names
/// the burn token (once) nothing can leave. After that the only ways out are `buyAndBurn`, which swaps a held
/// token through a call the owner chooses and must deliver at least `minBurnTokenOut` of the burn token, and
/// `burn`, and both send every unit of the burn token the vault holds to the dead address in the same transaction.
/// The owner is trusted to pick fair swaps: a swap target is any contract the owner names.
contract HaPaPayBurnVault {
    error NotOwner();
    error InvalidAddress();
    error InvalidToken();
    error InvalidTarget();
    error InvalidAmount();
    error BurnTokenAlreadySet();
    error BurnTokenNotSet();
    error InsufficientBalance();
    error InsufficientOutput();
    error OverSpent();
    error TransferFailed();
    error TransferAmountMismatch();
    error ReentrantCall();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event BurnTokenSet(address indexed token);
    event Swapped(address indexed tokenIn, uint256 amountIn, address indexed target, uint256 burnTokenOut);
    event Burned(address indexed token, uint256 amount);

    /// @notice Where burned tokens go: an address nobody holds a key for.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public owner;
    address public burnToken;
    bool private entered;

    constructor() {
        owner = msg.sender;
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

    /// @notice Names the token the vault buys and burns. It can never be changed afterwards.
    function setBurnToken(address token) external onlyOwner {
        if (burnToken != address(0)) revert BurnTokenAlreadySet();
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        burnToken = token;
        emit BurnTokenSet(token);
    }

    /// @notice Swaps up to `amountIn` of a held token into the burn token through `target` and burns all of it held.
    /// @param data The call the swap target runs, for example a DEX router's exact-input swap paying this vault.
    function buyAndBurn(
        address tokenIn,
        uint256 amountIn,
        address target,
        bytes calldata data,
        uint256 minBurnTokenOut
    ) external onlyOwner nonReentrant returns (uint256 burned) {
        address token = burnToken;
        if (token == address(0)) revert BurnTokenNotSet();
        if (tokenIn == token || tokenIn.code.length == 0) revert InvalidToken();
        if (target == tokenIn || target == token || target == address(this) || target.code.length == 0) {
            revert InvalidTarget();
        }
        if (amountIn == 0 || minBurnTokenOut == 0) revert InvalidAmount();
        uint256 outBefore = _balanceOf(token, address(this));
        uint256 spent = _swap(tokenIn, amountIn, target, data);
        uint256 outAfter = _balanceOf(token, address(this));
        uint256 gained = outAfter > outBefore ? outAfter - outBefore : 0;
        if (gained < minBurnTokenOut) revert InsufficientOutput();
        emit Swapped(tokenIn, spent, target, gained);
        burned = _burnAll(token);
    }

    /// @dev Lets `target` pull at most `amountIn` of `tokenIn` for one call, then takes the allowance back.
    function _swap(address tokenIn, uint256 amountIn, address target, bytes calldata data) private returns (uint256 spent) {
        uint256 inBefore = _balanceOf(tokenIn, address(this));
        if (inBefore < amountIn) revert InsufficientBalance();
        _approve(tokenIn, target, amountIn);
        (bool success, bytes memory result) = target.call(data);
        if (!success) {
            if (result.length != 0) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
            revert TransferFailed();
        }
        _approve(tokenIn, target, 0);
        uint256 inAfter = _balanceOf(tokenIn, address(this));
        spent = inBefore > inAfter ? inBefore - inAfter : 0;
        if (spent > amountIn) revert OverSpent();
    }

    /// @notice Burns all of the burn token the vault holds, for example the burn half of fees paid in it. Anyone may call.
    function burn() external nonReentrant returns (uint256 burned) {
        address token = burnToken;
        if (token == address(0)) revert BurnTokenNotSet();
        burned = _burnAll(token);
    }

    function _burnAll(address token) private returns (uint256 amount) {
        amount = _balanceOf(token, address(this));
        if (amount == 0) return 0;
        uint256 balanceBefore = _balanceOf(token, BURN_ADDRESS);
        (bool success, bytes memory result) = token.call(abi.encodeWithSelector(0xa9059cbb, BURN_ADDRESS, amount));
        _checkTokenCall(success, result);
        uint256 balanceAfter = _balanceOf(token, BURN_ADDRESS);
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) revert TransferAmountMismatch();
        emit Burned(token, amount);
    }

    /// @dev Some tokens refuse to change a non-zero allowance, so the allowance is cleared first.
    function _approve(address token, address spender, uint256 amount) private {
        if (amount != 0) {
            (bool cleared, bytes memory clearResult) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, 0));
            _checkTokenCall(cleared, clearResult);
        }
        (bool success, bytes memory result) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
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

    function _balanceOf(address token, address account) private view returns (uint256 balance) {
        (bool success, bytes memory result) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!success || result.length != 32) revert TransferFailed();
        balance = abi.decode(result, (uint256));
    }
}
