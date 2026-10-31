// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ElysaPayRouter} from "../contracts/elysium/ElysaPayRouter.sol";
import {ElysaToken} from "../contracts/elysium/ElysaToken.sol";
import {ElysaPass} from "../contracts/elysium/ElysaPass.sol";
import {MockUSDC} from "../tests/fixtures/MockUSDC.sol";

interface ElysiumVm {
    function prank(address sender) external;
    function deal(address who, uint256 amount) external;
    function expectRevert(bytes4 selector) external;
}

contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

contract Reentrant {
    ElysaPayRouter private router;
    constructor(ElysaPayRouter target) {
        router = target;
    }
    receive() external payable {
        router.payNative{value: 101}(address(0xBEEF), 100, "");
    }
}

contract ElysiumTest {
    ElysiumVm private constant vm = ElysiumVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant TREASURY = address(0x7EA5);
    address private constant ADMIN = address(0xAD);
    address private constant PAYER = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA201);

    ElysaPayRouter private router;
    ElysaToken private token;
    ElysaPass private pass;

    function setUp() public {
        router = new ElysaPayRouter(TREASURY);
        token = new ElysaToken("Elysa", "ELYSA", 1_000_000 ether, ADMIN);
        pass = new ElysaPass("Elysian Pass", "EPASS", 3, true, "https://elysapay.xyz/pass/", ADMIN);
        vm.deal(PAYER, 100 ether);
    }

    // ---- Router ----

    function testFeeRoundsUp() public view {
        require(router.feeFor(100) == 1, "1%");
        require(router.feeFor(1) == 1, "min fee");
        require(router.feeFor(1 ether) == 0.01 ether, "1% of 1");
    }

    function testPayNativeSendsExactAmounts() public {
        vm.prank(PAYER);
        router.payNative{value: 1.01 ether}(BOB, 1 ether, "rent");
        require(BOB.balance == 1 ether, "recipient amount");
        require(TREASURY.balance == 0.01 ether, "fee");
        require(address(router).balance == 0, "holds nothing");
    }

    function testPayNativeRejectsWrongValue() public {
        vm.prank(PAYER);
        vm.expectRevert(ElysaPayRouter.InvalidValue.selector);
        router.payNative{value: 1 ether}(BOB, 1 ether, "");
    }

    function testPayNativeRejectsLongNote() public {
        bytes memory note = new bytes(161);
        vm.prank(PAYER);
        vm.expectRevert(ElysaPayRouter.NoteTooLong.selector);
        router.payNative{value: 1.01 ether}(BOB, 1 ether, note);
    }

    function testPayNativeFailsClosedOnRejectingRecipient() public {
        Rejecter rejecter = new Rejecter();
        vm.prank(PAYER);
        vm.expectRevert(ElysaPayRouter.TransferFailed.selector);
        router.payNative{value: 1.01 ether}(address(rejecter), 1 ether, "");
    }

    function testReentryIsBlocked() public {
        Reentrant attacker = new Reentrant(router);
        vm.deal(address(attacker), 1 ether);
        vm.prank(PAYER);
        vm.expectRevert(ElysaPayRouter.TransferFailed.selector);
        router.payNative{value: 1.01 ether}(address(attacker), 1 ether, "");
    }

    function testBatch() public {
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        to[0] = BOB;
        to[1] = CAROL;
        amounts[0] = 1 ether;
        amounts[1] = 2 ether;
        vm.prank(PAYER);
        router.payNativeBatch{value: 3.03 ether}(to, amounts, "team");
        require(BOB.balance == 1 ether && CAROL.balance == 2 ether, "amounts");
        require(TREASURY.balance == 0.03 ether, "fees");
    }

    function testDirectSendIsRefused() public {
        vm.prank(PAYER);
        (bool ok,) = address(router).call{value: 1}("");
        require(!ok, "receive must revert");
    }

    function testPayToken() public {
        MockUSDC usdc = new MockUSDC();
        usdc.mint(PAYER, 101_000_000);
        vm.prank(PAYER);
        usdc.approve(address(router), 101_000_000);
        vm.prank(PAYER);
        router.payToken(address(usdc), BOB, 100_000_000, "");
        require(usdc.balanceOf(BOB) == 100_000_000, "amount");
        require(usdc.balanceOf(TREASURY) == 1_000_000, "fee");
    }

    function testFuzzNativeFee(uint96 amount) public {
        if (amount == 0) return;
        uint256 fee = router.feeFor(amount);
        vm.deal(PAYER, uint256(amount) + fee);
        vm.prank(PAYER);
        router.payNative{value: uint256(amount) + fee}(BOB, amount, "");
        require(BOB.balance == amount, "amount");
        require(TREASURY.balance == fee, "fee");
        require(fee * 10_000 >= uint256(amount) * 100, "fee never below 1%");
    }

    // ---- Token ----

    function testOnlyOwnerMints() public {
        vm.prank(PAYER);
        vm.expectRevert(ElysaToken.NotOwner.selector);
        token.mint(PAYER, 1, bytes32(0));
        vm.prank(ADMIN);
        token.mint(BOB, 5 ether, "genesis");
        require(token.balanceOf(BOB) == 5 ether && token.totalSupply() == 5 ether, "minted");
    }

    function testCapPauseClose() public {
        vm.prank(ADMIN);
        vm.expectRevert(ElysaToken.CapExceeded.selector);
        token.mint(BOB, 1_000_001 ether, bytes32(0));
        vm.prank(ADMIN);
        token.setMintingPaused(true);
        vm.prank(ADMIN);
        vm.expectRevert(ElysaToken.MintingPaused.selector);
        token.mint(BOB, 1, bytes32(0));
        vm.prank(ADMIN);
        token.closeMinting();
        vm.prank(ADMIN);
        vm.expectRevert(ElysaToken.MintingClosed.selector);
        token.setMintingPaused(false);
    }

    function testTokenBatchAndTransfer() public {
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        to[0] = BOB;
        to[1] = CAROL;
        amounts[0] = 1 ether;
        amounts[1] = 2 ether;
        vm.prank(ADMIN);
        token.mintBatch(to, amounts, "drop");
        vm.prank(CAROL);
        token.transfer(BOB, 1 ether);
        require(token.balanceOf(BOB) == 2 ether && token.balanceOf(CAROL) == 1 ether, "balances");
        vm.prank(BOB);
        token.burn(2 ether);
        require(token.totalSupply() == 1 ether, "burned");
    }

    function testTwoStepOwnership() public {
        vm.prank(ADMIN);
        token.transferOwnership(BOB);
        require(token.owner() == ADMIN, "still admin");
        vm.prank(CAROL);
        vm.expectRevert(ElysaToken.NotPendingOwner.selector);
        token.acceptOwnership();
        vm.prank(BOB);
        token.acceptOwnership();
        require(token.owner() == BOB, "moved");
    }

    // ---- Pass ----

    function testPassMintSoulboundAndCap() public {
        vm.prank(ADMIN);
        uint256 id = pass.mint(BOB, 1);
        require(id == 1 && pass.ownerOf(1) == BOB && pass.tierOf(1) == 1, "minted");
        vm.prank(BOB);
        vm.expectRevert(ElysaPass.Soulbound.selector);
        pass.transferFrom(BOB, CAROL, 1);
        address[] memory to = new address[](2);
        to[0] = CAROL;
        to[1] = PAYER;
        vm.prank(ADMIN);
        pass.mintBatch(to, 2);
        vm.prank(ADMIN);
        vm.expectRevert(ElysaPass.CapExceeded.selector);
        pass.mint(BOB, 1);
        vm.prank(BOB);
        pass.burn(1);
        require(pass.totalSupply() == 2 && pass.totalMinted() == 3, "supply");
    }

    function testPassMetadataFreeze() public {
        vm.prank(ADMIN);
        pass.mint(BOB, 3);
        require(keccak256(bytes(pass.tokenURI(1))) == keccak256("https://elysapay.xyz/pass/1"), "uri");
        vm.prank(ADMIN);
        pass.freezeMetadata();
        vm.prank(ADMIN);
        vm.expectRevert(ElysaPass.MetadataFrozen.selector);
        pass.setBaseURI("x");
    }

    function testTransferablePass() public {
        ElysaPass open = new ElysaPass("Open", "OPEN", 10, false, "", ADMIN);
        vm.prank(ADMIN);
        open.mint(BOB, 1);
        vm.prank(BOB);
        open.transferFrom(BOB, CAROL, 1);
        require(open.ownerOf(1) == CAROL, "moved");
    }
}
