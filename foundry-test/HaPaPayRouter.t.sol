// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HaPaPayRouter} from "../contracts/HaPaPayRouter.sol";
import {HaPaPayBurnVault} from "../contracts/HaPaPayBurnVault.sol";
import {MockStockToken} from "../tests/fixtures/MockStockToken.sol";
import {AdversarialERC20, NoReturnERC20} from "../tests/fixtures/AdversarialERC20.sol";

interface RouterVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function addr(uint256 privateKey) external returns (address);
    function prank(address sender) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
}

contract HaPaPayRouterTest {
    RouterVm private constant vm = RouterVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant REF = keccak256("draft-1");

    MockStockToken private usdg;
    HaPaPayBurnVault private burnVault;
    HaPaPayRouter private router;
    address private treasury;
    address private recipient;

    function setUp() public {
        usdg = new MockStockToken();
        burnVault = new HaPaPayBurnVault();
        treasury = vm.addr(0x7EA5);
        recipient = vm.addr(0xB0B);
        router = new HaPaPayRouter(address(burnVault), treasury);
    }

    function test_ConstructorRecordsTheFeeScheduleAndRejectsBadAddresses() public {
        require(router.owner() == address(this), "owner mismatch");
        require(router.burnVault() == address(burnVault) && router.treasury() == treasury, "fee recipients mismatch");
        require(router.FEE_BPS() == 100 && router.BURN_SHARE_BPS() == 5_000, "fee schedule mismatch");
        require(router.passToken() == address(0) && router.passFeeBps() == 100 && router.passMinimum() == 0, "pass not off");
        require(router.securityRevision() == 1, "revision mismatch");
        _expectDeployRevert(address(0), treasury, "zero burn vault accepted");
        _expectDeployRevert(vm.addr(0xE0A), treasury, "burn vault without code accepted");
        _expectDeployRevert(address(burnVault), address(0), "zero treasury accepted");
    }

    function deployRouter(address vault, address keeper) external returns (address) {
        return address(new HaPaPayRouter(vault, keeper));
    }

    function testFuzz_PayDeliversTheExactAmountAndSplitsTheFee(uint96 rawAmount) public {
        uint256 amount = uint256(rawAmount) % 1e30 + 1;
        uint256 fee = amount / 100;
        _mintAndApprove(usdg, amount + fee);
        uint256 returned = router.pay(address(usdg), recipient, amount, REF);
        require(returned == fee, "returned fee mismatch");
        require(usdg.balanceOf(recipient) == amount, "recipient did not get the exact amount");
        require(usdg.balanceOf(address(burnVault)) == fee / 2, "burn half mismatch");
        require(usdg.balanceOf(treasury) == fee - fee / 2, "treasury half mismatch");
        require(usdg.balanceOf(address(this)) == 0 && usdg.balanceOf(address(router)) == 0, "funds left behind");
    }

    function test_FeeRoundsDownAndTinyPaymentsPayNone() public {
        require(router.feeFor(address(this), 99) == 0, "fee charged below 100 units");
        require(router.feeFor(address(this), 100) == 1, "1% of 100 units");
        require(router.feeFor(address(this), 25e6) == 25e4, "1% of 25 USDG");
        (uint256 burnShare, uint256 treasuryShare) = router.splitFee(3);
        require(burnShare == 1 && treasuryShare == 2, "odd fee split");
        _mintAndApprove(usdg, 99);
        router.pay(address(usdg), recipient, 99, REF);
        require(usdg.balanceOf(recipient) == 99 && usdg.balanceOf(treasury) == 0, "tiny payment mismatch");
    }

    function test_PayRejectsBadRecipientsAmountsAndTokens() public {
        _mintAndApprove(usdg, 10 ether);
        _expectPayRevert(address(usdg), address(0), 1 ether, HaPaPayRouter.InvalidAddress.selector, "zero recipient accepted");
        _expectPayRevert(address(usdg), address(this), 1 ether, HaPaPayRouter.InvalidAddress.selector, "payment to self accepted");
        _expectPayRevert(address(usdg), address(router), 1 ether, HaPaPayRouter.InvalidAddress.selector, "payment to the router accepted");
        _expectPayRevert(address(usdg), recipient, 0, HaPaPayRouter.InvalidAmount.selector, "zero amount accepted");
        _expectPayRevert(address(0), recipient, 1 ether, HaPaPayRouter.InvalidToken.selector, "zero token accepted");
        _expectPayRevert(vm.addr(0xE0A), recipient, 1 ether, HaPaPayRouter.InvalidToken.selector, "token without code accepted");
    }

    function test_ShortAllowanceRevertsTheWholePayment() public {
        usdg.mint(address(this), 2 ether);
        usdg.approve(address(router), 1 ether);
        (bool paid,) = address(router).call(abi.encodeCall(router.pay, (address(usdg), recipient, 1 ether, REF)));
        require(!paid, "payment without allowance for the fee accepted");
        require(usdg.balanceOf(recipient) == 0 && usdg.balanceOf(address(this)) == 2 ether, "partial payment left state");
    }

    function test_FeeOnTransferAndFalseReturningTokensFailClosed() public {
        AdversarialERC20 adversarial = new AdversarialERC20();
        adversarial.mint(address(this), 1_000);
        adversarial.approve(address(router), 1_000);
        adversarial.setFee(1);
        _expectPayRevert(address(adversarial), recipient, 500, HaPaPayRouter.TransferAmountMismatch.selector, "fee-on-transfer payment accepted");
        adversarial.setFee(0);
        adversarial.setReturnFalse(true);
        _expectPayRevert(address(adversarial), recipient, 500, HaPaPayRouter.TransferFailed.selector, "false-returning payment accepted");
    }

    function test_TokensWithoutReturnValuesStillPayExactly() public {
        NoReturnERC20 quiet = new NoReturnERC20();
        quiet.mint(address(this), 1_010);
        quiet.approve(address(router), 1_010);
        router.pay(address(quiet), recipient, 1_000, REF);
        require(quiet.balanceOf(recipient) == 1_000 && quiet.balanceOf(address(burnVault)) == 5 && quiet.balanceOf(treasury) == 5, "quiet token payment mismatch");
    }

    function test_IssuerPauseAndBlocksBubbleUp() public {
        _mintAndApprove(usdg, 10.1 ether);
        usdg.setPaused(true);
        _expectPayRevert(address(usdg), recipient, 10 ether, MockStockToken.IsPaused.selector, "payment ignored issuer pause");
        usdg.setPaused(false);
        usdg.setBlocked(recipient, true);
        (bool paid, bytes memory errorData) = address(router).call(abi.encodeCall(router.pay, (address(usdg), recipient, 10 ether, REF)));
        require(!paid && keccak256(errorData) == keccak256(abi.encodeWithSelector(MockStockToken.Blocked.selector, recipient)), "payment ignored a blocked recipient");
    }

    function test_TheTreasuryPayingKeepsItsOwnShare() public {
        usdg.mint(treasury, 100.5 ether);
        vm.prank(treasury);
        usdg.approve(address(router), 101 ether);
        vm.prank(treasury);
        router.pay(address(usdg), recipient, 100 ether, REF);
        require(usdg.balanceOf(recipient) == 100 ether && usdg.balanceOf(address(burnVault)) == 0.5 ether, "treasury payment mismatch");
        require(usdg.balanceOf(treasury) == 0, "treasury share not kept by the paying treasury");
    }

    function test_ReentrantPaymentIsBlocked() public {
        AdversarialERC20 adversarial = new AdversarialERC20();
        adversarial.mint(address(this), 10_000);
        adversarial.approve(address(router), 10_000);
        adversarial.configureReentry(address(router), abi.encodeCall(router.pay, (address(adversarial), recipient, 1_000, REF)));
        router.pay(address(adversarial), recipient, 1_000, REF);
        require(!adversarial.reentrySucceeded(), "reentrant payment succeeded");
        require(adversarial.balanceOf(recipient) == 1_000, "outer payment mismatch");
    }

    function test_PaidEventCarriesWhatTheServerVerifies() public {
        _mintAndApprove(usdg, 25.25 ether);
        vm.recordLogs();
        router.pay(address(usdg), recipient, 25 ether, REF);
        RouterVm.Log[] memory logs = vm.getRecordedLogs();
        RouterVm.Log memory paid = logs[logs.length - 1];
        require(paid.emitter == address(router) && paid.topics[0] == HaPaPayRouter.Paid.selector, "paid event missing");
        require(paid.topics[1] == REF && paid.topics[2] == bytes32(uint256(uint160(address(this)))) && paid.topics[3] == bytes32(uint256(uint160(recipient))), "paid topics mismatch");
        (address token, uint256 amount, uint256 fee, uint256 burnShare, uint256 treasuryShare) = abi.decode(paid.data, (address, uint256, uint256, uint256, uint256));
        require(token == address(usdg) && amount == 25 ether && fee == 0.25 ether && burnShare == 0.125 ether && treasuryShare == 0.125 ether, "paid data mismatch");
        require(logs.length == 4, "expected three transfers and the paid event");
    }

    function test_PassRateAppliesOnlyToHoldersOnceSet() public {
        MockStockToken passToken = new MockStockToken();
        address holder = vm.addr(0xC0DE);
        passToken.mint(holder, 100_000 ether);
        require(router.feeFor(holder, 100 ether) == 1 ether, "discount before the pass is set");

        vm.prank(recipient);
        (bool stranger, bytes memory strangerError) = address(router).call(abi.encodeCall(router.setPass, (address(passToken), 100_000 ether, 50)));
        require(!stranger && bytes4(strangerError) == HaPaPayRouter.NotOwner.selector, "stranger set the pass");
        _expectSetPassRevert(address(passToken), 100_000 ether, 101, HaPaPayRouter.InvalidFee.selector, "pass rate above 1% accepted");
        _expectSetPassRevert(address(passToken), 0, 50, HaPaPayRouter.InvalidAmount.selector, "zero pass minimum accepted");
        _expectSetPassRevert(vm.addr(0xE0A), 100_000 ether, 50, HaPaPayRouter.InvalidToken.selector, "pass token without code accepted");

        router.setPass(address(passToken), 100_000 ether, 50);
        require(router.feeFor(holder, 100 ether) == 0.5 ether, "holder not at the pass rate");
        require(router.feeFor(address(this), 100 ether) == 1 ether, "non-holder discounted");
        passToken.mint(address(this), 99_999 ether);
        require(router.feeFor(address(this), 100 ether) == 1 ether, "below the minimum discounted");

        router.setPass(address(passToken), 50_000 ether, 0);
        require(router.feeFor(address(this), 100 ether) == 0, "retuned pass not applied");
        _expectSetPassRevert(address(new MockStockToken()), 1 ether, 50, HaPaPayRouter.PassTokenFixed.selector, "pass token replaced");
    }

    function test_OwnershipMovesOnlyByTheOwner() public {
        vm.prank(recipient);
        (bool stranger, bytes memory strangerError) = address(router).call(abi.encodeCall(router.transferOwnership, (recipient)));
        require(!stranger && bytes4(strangerError) == HaPaPayRouter.NotOwner.selector, "stranger took ownership");
        (bool zero, bytes memory zeroError) = address(router).call(abi.encodeCall(router.transferOwnership, (address(0))));
        require(!zero && bytes4(zeroError) == HaPaPayRouter.InvalidAddress.selector, "zero owner accepted");
        router.transferOwnership(recipient);
        require(router.owner() == recipient, "ownership not moved");
    }

    function _mintAndApprove(MockStockToken token, uint256 amount) private {
        token.mint(address(this), amount);
        token.approve(address(router), amount);
    }

    function _expectDeployRevert(address vault, address keeper, string memory reason) private {
        (bool deployed, bytes memory errorData) = address(this).call(abi.encodeCall(this.deployRouter, (vault, keeper)));
        require(!deployed && bytes4(errorData) == HaPaPayRouter.InvalidAddress.selector, reason);
    }

    function _expectPayRevert(address token, address to, uint256 amount, bytes4 selector, string memory reason) private {
        (bool paid, bytes memory errorData) = address(router).call(abi.encodeCall(router.pay, (token, to, amount, REF)));
        require(!paid && bytes4(errorData) == selector, reason);
    }

    function _expectSetPassRevert(address token, uint256 minimum, uint256 feeBps, bytes4 selector, string memory reason) private {
        (bool set, bytes memory errorData) = address(router).call(abi.encodeCall(router.setPass, (token, minimum, feeBps)));
        require(!set && bytes4(errorData) == selector, reason);
    }
}
