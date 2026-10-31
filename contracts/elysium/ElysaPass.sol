// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

/// @title ElysaPass
/// @notice The Elysian Pass: an ERC-721 membership pass that only its owner (the admin's own wallet) mints, one at a
/// time or as an airdrop. A pass can be made soulbound at deployment, in which case it never moves after mint; the
/// holder can still burn it. Supply is capped, minting can be paused or closed forever, and the metadata base URI
/// can be frozen. Ownership moves in two steps.
contract ElysaPass {
    error NotOwner();
    error NotPendingOwner();
    error InvalidAddress();
    error InvalidAmount();
    error CapExceeded();
    error MintingPaused();
    error MintingClosed();
    error MetadataFrozen();
    error Soulbound();
    error NotAuthorized();
    error NonexistentToken();
    error UnsafeRecipient();
    error BatchTooLarge();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MintingPausedSet(bool paused);
    event MintingClosedForever();
    event BaseURISet(string baseURI);
    event MetadataFrozenForever();
    event PassMinted(address indexed to, uint256 indexed tokenId, uint8 tier);

    uint256 public constant MAX_BATCH = 100;

    string public name;
    string public symbol;
    uint256 public immutable maxSupply;
    bool public immutable soulbound;
    uint256 public totalMinted;
    uint256 public totalSupply;
    address public owner;
    address public pendingOwner;
    bool public mintingPaused;
    bool public mintingClosed;
    bool public metadataFrozen;
    string private baseURI;

    mapping(uint256 => address) private owners;
    mapping(address => uint256) private balances;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    /// @notice The tier a pass was minted with (for example 1 Genesis, 2 Builder, 3 Trader).
    mapping(uint256 => uint8) public tierOf;

    constructor(string memory passName, string memory passSymbol, uint256 cap, bool isSoulbound, string memory initialBaseURI, address initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
        if (cap == 0 || bytes(passName).length == 0 || bytes(passSymbol).length == 0) revert InvalidAmount();
        name = passName;
        symbol = passSymbol;
        maxSupply = cap;
        soulbound = isSoulbound;
        baseURI = initialBaseURI;
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

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }

    function balanceOf(address holder) external view returns (uint256) {
        if (holder == address(0)) revert InvalidAddress();
        return balances[holder];
    }

    function ownerOf(uint256 tokenId) public view returns (address holder) {
        holder = owners[tokenId];
        if (holder == address(0)) revert NonexistentToken();
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return string(abi.encodePacked(baseURI, _toString(tokenId)));
    }

    // ---- Transfers ----

    function approve(address spender, uint256 tokenId) external {
        if (soulbound) revert Soulbound();
        address holder = ownerOf(tokenId);
        if (msg.sender != holder && !isApprovedForAll[holder][msg.sender]) revert NotAuthorized();
        getApproved[tokenId] = spender;
        emit Approval(holder, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (soulbound) revert Soulbound();
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (soulbound) revert Soulbound();
        address holder = ownerOf(tokenId);
        if (holder != from) revert NotAuthorized();
        if (to == address(0)) revert InvalidAddress();
        if (msg.sender != holder && !isApprovedForAll[holder][msg.sender] && getApproved[tokenId] != msg.sender) revert NotAuthorized();
        delete getApproved[tokenId];
        unchecked {
            balances[from] -= 1;
            balances[to] += 1;
        }
        owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        _checkReceiver(from, to, tokenId, data);
    }

    /// @notice The holder burns their own pass (also when it is soulbound).
    function burn(uint256 tokenId) external {
        address holder = ownerOf(tokenId);
        if (msg.sender != holder) revert NotAuthorized();
        delete getApproved[tokenId];
        delete owners[tokenId];
        delete tierOf[tokenId];
        unchecked {
            balances[holder] -= 1;
            totalSupply -= 1;
        }
        emit Transfer(holder, address(0), tokenId);
    }

    // ---- Minting (owner only) ----

    function mint(address to, uint8 tier) external onlyOwner returns (uint256 tokenId) {
        tokenId = _mint(to, tier);
    }

    function mintBatch(address[] calldata recipients, uint8 tier) external onlyOwner {
        uint256 count = recipients.length;
        if (count == 0) revert InvalidAmount();
        if (count > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i = 0; i < count; i++) _mint(recipients[i], tier);
    }

    function setMintingPaused(bool paused) external onlyOwner {
        if (mintingClosed) revert MintingClosed();
        mintingPaused = paused;
        emit MintingPausedSet(paused);
    }

    function closeMinting() external onlyOwner {
        mintingClosed = true;
        emit MintingClosedForever();
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        if (metadataFrozen) revert MetadataFrozen();
        baseURI = newBaseURI;
        emit BaseURISet(newBaseURI);
    }

    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozenForever();
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

    function _mint(address to, uint8 tier) private returns (uint256 tokenId) {
        if (mintingClosed) revert MintingClosed();
        if (mintingPaused) revert MintingPaused();
        if (to == address(0)) revert InvalidAddress();
        if (totalMinted >= maxSupply) revert CapExceeded();
        tokenId = ++totalMinted;
        unchecked {
            totalSupply += 1;
            balances[to] += 1;
        }
        owners[tokenId] = to;
        tierOf[tokenId] = tier;
        emit Transfer(address(0), to, tokenId);
        emit PassMinted(to, tokenId, tier);
    }

    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 answer) {
            if (answer != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
        } catch {
            revert UnsafeRecipient();
        }
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 temp = value; temp != 0; temp /= 10) digits++;
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
