// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract AdversarialERC20 {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public fee;
    bool public returnFalse;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentrySucceeded;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function setFee(uint256 newFee) external {
        fee = newFee;
    }

    function setReturnFalse(bool enabled) external {
        returnFalse = enabled;
    }

    function configureReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
        reentrySucceeded = false;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        _move(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        uint256 permitted = allowance[sender][msg.sender];
        require(permitted >= amount, "allowance");
        allowance[sender][msg.sender] = permitted - amount;
        _move(sender, recipient, amount);
        if (reentryTarget != address(0)) {
            (reentrySucceeded,) = reentryTarget.call(reentryData);
        }
        return true;
    }

    function _move(address sender, address recipient, uint256 amount) private {
        require(balanceOf[sender] >= amount, "balance");
        uint256 received = amount - fee;
        balanceOf[sender] -= amount;
        balanceOf[recipient] += received;
    }
}

contract NoReturnERC20 {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address recipient, uint256 amount) external {
        _move(msg.sender, recipient, amount);
    }

    function transferFrom(address sender, address recipient, uint256 amount) external {
        uint256 permitted = allowance[sender][msg.sender];
        require(permitted >= amount, "allowance");
        allowance[sender][msg.sender] = permitted - amount;
        _move(sender, recipient, amount);
    }

    function _move(address sender, address recipient, uint256 amount) private {
        require(balanceOf[sender] >= amount, "balance");
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
    }
}
