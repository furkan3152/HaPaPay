// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Test stand-in for USDG (Global Dollar): a six-decimal ERC-20 whose transfers revert with the custom errors of
/// Paxos' PaxosBaseAbstract and PaxosTokenV2 for a paused contract, a frozen address, and a short balance or allowance.
/// Constants only, so its runtime code can be placed at the allowlisted USDG address with anvil_setCode.
contract MockPaxosToken {
    string public constant name = "Global Dollar";
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public frozen;
    bool public paused;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ContractPaused();
    error AddressFrozen();
    error InsufficientFunds();
    error InsufficientAllowance();

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setFrozen(address account, bool value) external {
        frozen[account] = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (paused) revert ContractPaused();
        if (frozen[spender] || frozen[msg.sender]) revert AddressFrozen();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (paused) revert ContractPaused();
        if (frozen[to] || frozen[msg.sender]) revert AddressFrozen();
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (paused) revert ContractPaused();
        if (frozen[to] || frozen[from] || frozen[msg.sender]) revert AddressFrozen();
        uint256 permitted = allowance[from][msg.sender];
        if (value > permitted) revert InsufficientAllowance();
        allowance[from][msg.sender] = permitted - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        uint256 balance = balanceOf[from];
        if (value > balance) revert InsufficientFunds();
        balanceOf[from] = balance - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
