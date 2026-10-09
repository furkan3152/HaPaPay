// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Test stand-in for a Robinhood Stock Token: an 18-decimal ERC-20 whose transfers revert with the same
/// custom errors the Stock contract uses for an issuer pause, a compliance-list block, and a short balance.
/// Constants only, so its runtime code can be placed at an allowlisted address with anvil_setCode.
contract MockStockToken {
    string public constant name = "Tesla";
    string public constant symbol = "TSLA";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    bool public paused;

    event Transfer(address indexed sender, address indexed recipient, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error IsPaused();
    error Blocked(address account);
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _move(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[sender][msg.sender];
        if (permitted < amount) revert ERC20InsufficientAllowance(msg.sender, permitted, amount);
        allowance[sender][msg.sender] = permitted - amount;
        _move(sender, recipient, amount);
        return true;
    }

    function _move(address sender, address recipient, uint256 amount) private {
        if (paused) revert IsPaused();
        if (blocked[recipient]) revert Blocked(recipient);
        if (blocked[sender]) revert Blocked(sender);
        uint256 balance = balanceOf[sender];
        if (balance < amount) revert ERC20InsufficientBalance(sender, balance, amount);
        balanceOf[sender] = balance - amount;
        balanceOf[recipient] += amount;
        emit Transfer(sender, recipient, amount);
    }
}
