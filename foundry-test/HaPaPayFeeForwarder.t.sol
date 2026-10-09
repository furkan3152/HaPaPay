// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HaPaPayFeeForwarder} from "../contracts/HaPaPayFeeForwarder.sol";
import {HaPaPayRouter} from "../contracts/HaPaPayRouter.sol";
import {MockStockToken} from "../tests/fixtures/MockStockToken.sol";
import {MockUSDC} from "../tests/fixtures/MockUSDC.sol";
import {AdversarialERC20, NoReturnERC20} from "../tests/fixtures/AdversarialERC20.sol";

interface ForwarderVm {
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

contract HaPaPayFeeForwarderTest {
    ForwarderVm private constant vm = ForwarderVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    HaPaPayFeeForwarder private forwarder;
    MockUSDC private usdc;
    address private treasury;
    address private stranger;

    function setUp() public {
        treasury = vm.addr(0x7EA5);
        stranger = vm.addr(0xBAD);
        forwarder = new HaPaPayFeeForwarder(treasury);
        usdc = new MockUSDC();
    }

    function test_ConstructorRecordsTheTreasuryAndRejectsBadAddresses() public {
        require(forwarder.treasury() == treasury, "treasury mismatch");
        require(forwarder.securityRevision() == 1, "revision mismatch");
        (bool deployed, bytes memory errorData) = address(this).call(abi.encodeCall(this.deployForwarder, (address(0))));
        require(!deployed && bytes4(errorData) == HaPaPayFeeForwarder.InvalidAddress.selector, "zero treasury accepted");
    }

    function deployForwarder(address keeper) external returns (address) {
        return address(new HaPaPayFeeForwarder(keeper));
    }

    function testFuzz_AnyoneForwardsTheWholeBalanceToTheTreasuryOnly(uint64 rawAmount) public {
        uint256 amount = uint256(rawAmount) + 1;
        usdc.mint(address(forwarder), amount);
        usdc.mint(treasury, 7);
        vm.prank(stranger);
        uint256 forwarded = forwarder.forward(address(usdc));
        require(forwarded == amount, "returned amount mismatch");
        require(usdc.balanceOf(treasury) == amount + 7, "treasury did not receive the exact balance");
        require(usdc.balanceOf(address(forwarder)) == 0 && usdc.balanceOf(stranger) == 0, "funds went elsewhere");
    }

    function test_AnEmptyForwardMovesNothing() public {
        vm.recordLogs();
        require(forwarder.forward(address(usdc)) == 0, "empty forward reported an amount");
        require(vm.getRecordedLogs().length == 0, "empty forward emitted an event");
    }

    function test_ForwardRejectsAddressesWithoutCode() public {
        _expectForwardRevert(address(0), HaPaPayFeeForwarder.InvalidToken.selector, "zero token accepted");
        _expectForwardRevert(vm.addr(0xE0A), HaPaPayFeeForwarder.InvalidToken.selector, "token without code accepted");
    }

    function test_FeeOnTransferAndFalseReturningTokensFailClosed() public {
        AdversarialERC20 adversarial = new AdversarialERC20();
        adversarial.mint(address(forwarder), 1_000);
        adversarial.setFee(1);
        _expectForwardRevert(address(adversarial), HaPaPayFeeForwarder.TransferAmountMismatch.selector, "fee-on-transfer forward accepted");
        adversarial.setFee(0);
        adversarial.setReturnFalse(true);
        _expectForwardRevert(address(adversarial), HaPaPayFeeForwarder.TransferFailed.selector, "false-returning forward accepted");
        require(adversarial.balanceOf(address(forwarder)) == 1_000, "a failed forward moved funds");
    }

    function test_TokensWithoutReturnValuesStillForwardExactly() public {
        NoReturnERC20 quiet = new NoReturnERC20();
        quiet.mint(address(forwarder), 1_000);
        require(forwarder.forward(address(quiet)) == 1_000 && quiet.balanceOf(treasury) == 1_000, "quiet token forward mismatch");
    }

    function test_TokenErrorsBubbleUpUnchanged() public {
        MockStockToken token = new MockStockToken();
        token.mint(address(forwarder), 1 ether);
        token.setPaused(true);
        _expectForwardRevert(address(token), MockStockToken.IsPaused.selector, "forward ignored an issuer pause");
    }

    function test_ForwardedEventCarriesTokenTreasuryAndAmount() public {
        usdc.mint(address(forwarder), 250);
        vm.recordLogs();
        forwarder.forward(address(usdc));
        ForwarderVm.Log[] memory logs = vm.getRecordedLogs();
        ForwarderVm.Log memory forwarded = logs[logs.length - 1];
        require(forwarded.emitter == address(forwarder), "event emitter mismatch");
        require(forwarded.topics[0] == keccak256("Forwarded(address,address,uint256)"), "event signature mismatch");
        require(address(uint160(uint256(forwarded.topics[1]))) == address(usdc), "event token mismatch");
        require(address(uint160(uint256(forwarded.topics[2]))) == treasury, "event treasury mismatch");
        require(abi.decode(forwarded.data, (uint256)) == 250, "event amount mismatch");
    }

    /// Behind the reviewed fee router, the forwarder takes the burn half, so the whole fee reaches the treasury.
    function testFuzz_BehindTheRouterTheWholeFeeReachesTheTreasury(uint64 rawAmount) public {
        uint256 amount = uint256(rawAmount) + 1;
        HaPaPayRouter router = new HaPaPayRouter(address(forwarder), treasury);
        address recipient = vm.addr(0xB0B);
        uint256 fee = amount / 100;
        usdc.mint(address(this), amount + fee);
        usdc.approve(address(router), amount + fee);
        router.pay(address(usdc), recipient, amount, keccak256("arc-payment"));
        require(usdc.balanceOf(recipient) == amount, "recipient did not get the exact amount");
        require(usdc.balanceOf(address(forwarder)) == fee / 2, "burn half did not reach the forwarder");
        forwarder.forward(address(usdc));
        require(usdc.balanceOf(treasury) == fee, "treasury did not end up with the whole fee");
        require(usdc.balanceOf(address(forwarder)) == 0 && usdc.balanceOf(address(router)) == 0, "funds left behind");
    }

    function _expectForwardRevert(address token, bytes4 selector, string memory reason) private {
        (bool forwarded, bytes memory errorData) = address(forwarder).call(abi.encodeCall(forwarder.forward, (token)));
        require(!forwarded && bytes4(errorData) == selector, reason);
    }
}
