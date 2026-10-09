// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HaPaPayBurnVault} from "../contracts/HaPaPayBurnVault.sol";
import {MockStockToken} from "../tests/fixtures/MockStockToken.sol";
import {MockSwapTarget} from "../tests/fixtures/MockSwapTarget.sol";

interface VaultVm {
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

contract HaPaPayBurnVaultTest {
    VaultVm private constant vm = VaultVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    HaPaPayBurnVault private vault;
    MockStockToken private usdg;
    MockStockToken private burnToken;
    MockSwapTarget private dex;
    address private stranger;

    function setUp() public {
        vault = new HaPaPayBurnVault();
        usdg = new MockStockToken();
        burnToken = new MockStockToken();
        dex = new MockSwapTarget();
        stranger = vm.addr(0xBAD);
        usdg.mint(address(vault), 100 ether);
        burnToken.mint(address(dex), 1_000_000 ether);
    }

    function test_ConstructorRecordsTheOwnerAndTheBurnAddress() public {
        require(vault.owner() == address(this), "owner mismatch");
        require(vault.BURN_ADDRESS() == DEAD, "burn address mismatch");
        require(vault.burnToken() == address(0), "burn token set at deploy");
        require(vault.securityRevision() == 1, "revision mismatch");
    }

    function test_NothingLeavesBeforeTheBurnTokenIsSet() public {
        (bool swapped, bytes memory swapError) = address(vault).call(abi.encodeCall(vault.buyAndBurn, (
            address(usdg), 1 ether, address(dex), _swapCall(1 ether, 10 ether), 1
        )));
        require(!swapped && bytes4(swapError) == HaPaPayBurnVault.BurnTokenNotSet.selector, "swap before launch accepted");
        (bool burned, bytes memory burnError) = address(vault).call(abi.encodeCall(vault.burn, ()));
        require(!burned && bytes4(burnError) == HaPaPayBurnVault.BurnTokenNotSet.selector, "burn before launch accepted");
        require(usdg.balanceOf(address(vault)) == 100 ether, "fees moved before launch");
    }

    function test_BurnTokenIsSetOnceByTheOwner() public {
        vm.prank(stranger);
        (bool byStranger, bytes memory strangerError) = address(vault).call(abi.encodeCall(vault.setBurnToken, (address(burnToken))));
        require(!byStranger && bytes4(strangerError) == HaPaPayBurnVault.NotOwner.selector, "stranger set burn token");
        (bool withoutCode, bytes memory codeError) = address(vault).call(abi.encodeCall(vault.setBurnToken, (vm.addr(0xE0A))));
        require(!withoutCode && bytes4(codeError) == HaPaPayBurnVault.InvalidToken.selector, "account without code accepted");
        vault.setBurnToken(address(burnToken));
        require(vault.burnToken() == address(burnToken), "burn token not recorded");
        (bool again, bytes memory againError) = address(vault).call(abi.encodeCall(vault.setBurnToken, (address(usdg))));
        require(!again && bytes4(againError) == HaPaPayBurnVault.BurnTokenAlreadySet.selector, "burn token replaced");
    }

    function test_BuyAndBurnSwapsAndBurnsInOneTransaction() public {
        vault.setBurnToken(address(burnToken));
        burnToken.mint(address(vault), 7 ether); // the burn half of fees that were paid in the burn token
        vm.recordLogs();
        uint256 burned = vault.buyAndBurn(address(usdg), 40 ether, address(dex), _swapCall(40 ether, 4_000 ether), 3_900 ether);
        require(burned == 4_007 ether, "burned amount mismatch");
        require(burnToken.balanceOf(DEAD) == 4_007 ether && burnToken.balanceOf(address(vault)) == 0, "burn token not burned");
        require(usdg.balanceOf(address(vault)) == 60 ether && usdg.balanceOf(address(dex)) == 40 ether, "swap input mismatch");
        require(usdg.allowance(address(vault), address(dex)) == 0, "allowance left on the swap target");
        VaultVm.Log[] memory logs = vm.getRecordedLogs();
        bool swappedSeen;
        bool burnedSeen;
        for (uint256 index = 0; index < logs.length; index++) {
            if (logs[index].emitter != address(vault)) continue;
            if (logs[index].topics[0] == HaPaPayBurnVault.Swapped.selector) {
                (uint256 amountIn, uint256 burnTokenOut) = abi.decode(logs[index].data, (uint256, uint256));
                swappedSeen = amountIn == 40 ether && burnTokenOut == 4_000 ether;
            }
            if (logs[index].topics[0] == HaPaPayBurnVault.Burned.selector) {
                burnedSeen = abi.decode(logs[index].data, (uint256)) == 4_007 ether;
            }
        }
        require(swappedSeen && burnedSeen, "swap and burn events missing");
    }

    function test_ShortOutputRevertsAndKeepsTheFees() public {
        vault.setBurnToken(address(burnToken));
        (bool swapped, bytes memory errorData) = address(vault).call(abi.encodeCall(vault.buyAndBurn, (
            address(usdg), 40 ether, address(dex), _swapCall(40 ether, 100 ether), 3_900 ether
        )));
        require(!swapped && bytes4(errorData) == HaPaPayBurnVault.InsufficientOutput.selector, "short output accepted");
        dex.setSkim(stranger);
        (swapped, errorData) = address(vault).call(abi.encodeCall(vault.buyAndBurn, (
            address(usdg), 40 ether, address(dex), _swapCall(40 ether, 4_000 ether), 1
        )));
        require(!swapped && bytes4(errorData) == HaPaPayBurnVault.InsufficientOutput.selector, "output paid elsewhere accepted");
        require(usdg.balanceOf(address(vault)) == 100 ether && burnToken.balanceOf(stranger) == 0, "failed swap moved funds");
    }

    function test_SwapTargetCannotPullMoreThanAllowed() public {
        vault.setBurnToken(address(burnToken));
        dex.setGreedy(true);
        (bool swapped,) = address(vault).call(abi.encodeCall(vault.buyAndBurn, (
            address(usdg), 40 ether, address(dex), _swapCall(40 ether, 4_000 ether), 1
        )));
        require(!swapped, "greedy swap target pulled more than allowed");
        require(usdg.balanceOf(address(vault)) == 100 ether, "greedy swap moved funds");
    }

    function test_BuyAndBurnRejectsBadInputs() public {
        vault.setBurnToken(address(burnToken));
        bytes memory call_ = _swapCall(1 ether, 10 ether);
        _expectSwapRevert(address(burnToken), 1 ether, address(dex), call_, 1, HaPaPayBurnVault.InvalidToken.selector, "swapping burn token accepted");
        _expectSwapRevert(vm.addr(0xE0A), 1 ether, address(dex), call_, 1, HaPaPayBurnVault.InvalidToken.selector, "input without code accepted");
        _expectSwapRevert(address(usdg), 1 ether, address(usdg), call_, 1, HaPaPayBurnVault.InvalidTarget.selector, "input token as target accepted");
        _expectSwapRevert(address(usdg), 1 ether, address(burnToken), call_, 1, HaPaPayBurnVault.InvalidTarget.selector, "burn token as target accepted");
        _expectSwapRevert(address(usdg), 1 ether, address(vault), call_, 1, HaPaPayBurnVault.InvalidTarget.selector, "vault as target accepted");
        _expectSwapRevert(address(usdg), 1 ether, stranger, call_, 1, HaPaPayBurnVault.InvalidTarget.selector, "account without code as target accepted");
        _expectSwapRevert(address(usdg), 0, address(dex), call_, 1, HaPaPayBurnVault.InvalidAmount.selector, "zero input accepted");
        _expectSwapRevert(address(usdg), 1 ether, address(dex), call_, 0, HaPaPayBurnVault.InvalidAmount.selector, "zero minimum output accepted");
        _expectSwapRevert(address(usdg), 101 ether, address(dex), _swapCall(101 ether, 10 ether), 1, HaPaPayBurnVault.InsufficientBalance.selector, "swap above the balance accepted");
        vm.prank(stranger);
        (bool byStranger, bytes memory strangerError) = address(vault).call(abi.encodeCall(vault.buyAndBurn, (
            address(usdg), 1 ether, address(dex), call_, 1
        )));
        require(!byStranger && bytes4(strangerError) == HaPaPayBurnVault.NotOwner.selector, "stranger swapped");
    }

    function test_AnyoneCanBurnWhatTheVaultHolds() public {
        vault.setBurnToken(address(burnToken));
        burnToken.mint(address(vault), 12 ether);
        vm.prank(stranger);
        uint256 burned = vault.burn();
        require(burned == 12 ether && burnToken.balanceOf(DEAD) == 12 ether && burnToken.balanceOf(address(vault)) == 0, "burn mismatch");
        require(vault.burn() == 0, "empty burn should burn nothing");
    }

    function test_OwnershipMovesOnlyByTheOwner() public {
        vm.prank(stranger);
        (bool byStranger, bytes memory strangerError) = address(vault).call(abi.encodeCall(vault.transferOwnership, (stranger)));
        require(!byStranger && bytes4(strangerError) == HaPaPayBurnVault.NotOwner.selector, "stranger took ownership");
        (bool zero, bytes memory zeroError) = address(vault).call(abi.encodeCall(vault.transferOwnership, (address(0))));
        require(!zero && bytes4(zeroError) == HaPaPayBurnVault.InvalidAddress.selector, "zero owner accepted");
        vault.transferOwnership(stranger);
        require(vault.owner() == stranger, "ownership not moved");
    }

    function _swapCall(uint256 amountIn, uint256 amountOut) private view returns (bytes memory) {
        return abi.encodeCall(dex.swap, (address(usdg), amountIn, address(burnToken), amountOut));
    }

    function _expectSwapRevert(
        address tokenIn,
        uint256 amountIn,
        address target,
        bytes memory data,
        uint256 minOut,
        bytes4 selector,
        string memory reason
    ) private {
        (bool swapped, bytes memory errorData) = address(vault).call(abi.encodeCall(vault.buyAndBurn, (tokenIn, amountIn, target, data, minOut)));
        require(!swapped && bytes4(errorData) == selector, reason);
    }
}
