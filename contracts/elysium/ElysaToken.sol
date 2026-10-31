// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ElysaToken
/// @notice A capped ERC-20 that only its owner (the admin's own wallet) can mint. Minting can be paused and resumed,
/// and closed for good; holders can always transfer and burn their own tokens. Ownership moves in two steps.
/// @dev No transfer pause, no blacklist, no fee: once minted, tokens belong to their holders.
contract ElysaToken {
    error NotOwner();
    error NotPendingOwner();
    error InvalidAddress();
    error InvalidAmount();
    error CapExceeded();
    error MintingPaused();
    error MintingClosed();
    error InsufficientBalance();
    error InsufficientAllowance();
    error BatchTooLarge();

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MintingPausedSet(bool paused);
    event MintingClosedForever();
    event Minted(address indexed to, uint256 amount, bytes32 indexed memo);

    uint256 public constant MAX_BATCH = 200;

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public immutable cap;
    uint256 public totalSupply;
    address public owner;
    address public pendingOwner;
    bool public mintingPaused;
    bool public mintingClosed;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory tokenName, string memory tokenSymbol, uint256 maxSupply, address initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
        if (maxSupply == 0 || bytes(tokenName).length == 0 || bytes(tokenSymbol).length == 0) revert InvalidAmount();
        name = tokenName;
        symbol = tokenSymbol;
        cap = maxSupply;
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function securityRevision() public pure returns (uint256) {
        return 1;
    }

    // ---- ERC-20 ----

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert InvalidAddress();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function burn(uint256 value) external {
        uint256 balance = balanceOf[msg.sender];
        if (balance < value) revert InsufficientBalance();
        unchecked {
            balanceOf[msg.sender] = balance - value;
            totalSupply -= value;
        }
        emit Transfer(msg.sender, address(0), value);
    }

    // ---- Minting (owner only) ----

    function mint(address to, uint256 amount, bytes32 memo) external onlyOwner {
        _mint(to, amount, memo);
    }

    /// @notice Mints to up to 200 wallets in one transaction (an airdrop), with one memo for the whole batch.
    function mintBatch(address[] calldata recipients, uint256[] calldata amounts, bytes32 memo) external onlyOwner {
        uint256 count = recipients.length;
        if (count == 0 || count != amounts.length) revert InvalidAmount();
        if (count > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i = 0; i < count; i++) _mint(recipients[i], amounts[i], memo);
    }

    function setMintingPaused(bool paused) external onlyOwner {
        if (mintingClosed) revert MintingClosed();
        mintingPaused = paused;
        emit MintingPausedSet(paused);
    }

    /// @notice Closes minting forever. The supply can then only fall, through burns.
    function closeMinting() external onlyOwner {
        mintingClosed = true;
        emit MintingClosedForever();
    }

    // ---- Ownership (two steps) ----

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function _mint(address to, uint256 amount, bytes32 memo) private {
        if (mintingClosed) revert MintingClosed();
        if (mintingPaused) revert MintingPaused();
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (totalSupply + amount > cap) revert CapExceeded();
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
        emit Minted(to, amount, memo);
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert InvalidAddress();
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
