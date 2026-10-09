// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IMockSwapToken {
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

/// Test stand-in for a DEX router the burn vault swaps through: it pulls `amountIn` of the input token from the
/// caller and pays `amountOut` of the output token it was pre-funded with. `greedy` also tries to pull more than
/// it was asked, and `skim` pays the output to someone else, so the vault's guards can be exercised.
contract MockSwapTarget {
    bool public greedy;
    address public skimTo;

    function setGreedy(bool value) external {
        greedy = value;
    }

    function setSkim(address recipient) external {
        skimTo = recipient;
    }

    function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut) external {
        IMockSwapToken(tokenIn).transferFrom(msg.sender, address(this), greedy ? amountIn + 1 : amountIn);
        IMockSwapToken(tokenOut).transfer(skimTo == address(0) ? msg.sender : skimTo, amountOut);
    }
}
