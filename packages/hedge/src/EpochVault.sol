// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {OutcomeToken} from "./OutcomeToken.sol";

/**
 * Cover on a published price index, held as a pair of outcome tokens.
 *
 * A market is one (series, epoch) with a strike and a cap. Deposit collateral
 * and you get equal amounts of HIGH and LOW; at settlement they split the
 * deposit according to how far the published index overshot the strike.
 *
 *   payout(HIGH) = clamp((value - strike) / (cap - strike), 0, 1)
 *   payout(LOW)  = 1 - payout(HIGH)
 *
 * A capped call spread rather than a binary, because cover should scale with
 * the damage: a household hit by fourteen percent and one hit by six should
 * not be paid the same. Capping it is what makes the whole thing prepayable —
 * the most either side can ever owe is already sitting in this contract.
 *
 * WHAT THIS CONTRACT PROMISES. For every market,
 *
 *     collateral[id] == HIGH.totalSupply() == LOW.totalSupply()
 *
 * holds after every external call. There is no margin, no liquidation and no
 * path by which the vault owes more than it holds. Prior art for the split and
 * merge mechanics is Gnosis' Conditional Tokens Framework (2019); what is new
 * here is the index underneath and the freeze that protects its publication.
 *
 * Gnosis CTF is also where the naming comes from, deliberately, so that anyone
 * who has seen conditional tokens before recognises the shape immediately.
 */
contract EpochVault {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error MarketExists();
    error NoMarket();
    error BadStrike();
    error ZeroAmount();
    error ZeroAddress();
    error AlreadySettled();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event MarketCreated(
        bytes32 indexed marketId,
        bytes32 indexed seriesId,
        uint64 indexed epoch,
        int256 strikeBps,
        int256 capBps,
        address high,
        address low
    );
    event Split(bytes32 indexed marketId, address indexed who, uint256 amount);
    event Merge(bytes32 indexed marketId, address indexed who, uint256 burned, uint256 returned);

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    struct Market {
        bytes32 seriesId;
        uint64 epoch;
        /// @dev Basis points of index change. Signed: deflation is representable.
        int256 strikeBps;
        int256 capBps;
        address high;
        address low;
        /// @dev Collateral held for this market alone. Markets never share.
        uint256 collateral;
        /// @dev Set at settlement. WAD; the share of collateral HIGH receives.
        uint256 payoutHighWad;
        bool settled;
        bool voided;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The token every market in this vault is denominated in.
    IERC20 public immutable collateralToken;

    /// @notice Clone target for outcome tokens. Never initialised itself.
    address public immutable outcomeImplementation;

    uint8 internal immutable _outcomeDecimals;

    mapping(bytes32 => Market) internal _markets;

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(address collateralToken_) {
        if (collateralToken_ == address(0)) revert ZeroAddress();
        collateralToken = IERC20(collateralToken_);

        // Outcome tokens carry the collateral's decimals so that one unit of
        // HIGH redeems for at most one unit of collateral. See OutcomeToken.
        _outcomeDecimals = IERC20Metadata(collateralToken_).decimals();

        outcomeImplementation = address(new OutcomeToken());
    }

    /*//////////////////////////////////////////////////////////////
                              MARKET CREATION
    //////////////////////////////////////////////////////////////*/

    /**
     * Deterministic, so the same (series, epoch, strike, cap) is one market
     * everywhere and two callers cannot create parallel books on it.
     */
    function marketId(bytes32 seriesId, uint64 epoch, int256 strikeBps, int256 capBps)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(seriesId, epoch, strikeBps, capBps));
    }

    function createMarket(bytes32 seriesId, uint64 epoch, int256 strikeBps, int256 capBps)
        external
        returns (bytes32 id)
    {
        // A cap at or below the strike makes the payoff either a divide by
        // zero or an inverted spread. Both are silent if unchecked here and
        // extremely loud at settlement.
        if (capBps <= strikeBps) revert BadStrike();

        id = marketId(seriesId, epoch, strikeBps, capBps);
        Market storage m = _markets[id];
        if (m.high != address(0)) revert MarketExists();

        // Salted with the market id so the outcome addresses are predictable
        // before creation — the pool key, and therefore the ENS record, can be
        // computed by anyone without waiting for the transaction to land.
        address high = Clones.cloneDeterministic(outcomeImplementation, keccak256(abi.encode(id, "HIGH")));
        address low = Clones.cloneDeterministic(outcomeImplementation, keccak256(abi.encode(id, "LOW")));

        OutcomeToken(high).initialize(address(this), "Halo Cover HIGH", "hHIGH", _outcomeDecimals);
        OutcomeToken(low).initialize(address(this), "Halo Cover LOW", "hLOW", _outcomeDecimals);

        m.seriesId = seriesId;
        m.epoch = epoch;
        m.strikeBps = strikeBps;
        m.capBps = capBps;
        m.high = high;
        m.low = low;

        emit MarketCreated(id, seriesId, epoch, strikeBps, capBps, high, low);
    }

    /*//////////////////////////////////////////////////////////////
                                SPLIT / MERGE
    //////////////////////////////////////////////////////////////*/

    /**
     * Collateral in, one of each outcome out.
     *
     * WHY THE BALANCE IS MEASURED RATHER THAN ASSUMED. The amount minted is
     * the amount this contract actually received, not the amount the caller
     * asked to send. On Celo and Kaia the dollar stablecoins are bridged and
     * upgradeable, and a bridge that starts taking a fee on transfer would,
     * under the obvious implementation, mint more outcome tokens than there is
     * collateral behind them. That is not a rounding error — it is the moment
     * the vault becomes insolvent, and it happens on the first deposit after
     * the upgrade with no warning.
     *
     * Measuring the delta costs one extra balanceOf and makes the invariant
     * true by construction instead of true by assumption about a token we do
     * not control.
     */
    function split(bytes32 id, uint256 amount) external returns (uint256 minted) {
        if (amount == 0) revert ZeroAmount();
        Market storage m = _markets[id];
        if (m.high == address(0)) revert NoMarket();
        if (m.settled || m.voided) revert AlreadySettled();

        uint256 before = collateralToken.balanceOf(address(this));
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        minted = collateralToken.balanceOf(address(this)) - before;
        if (minted == 0) revert ZeroAmount();

        m.collateral += minted;
        OutcomeToken(m.high).mint(msg.sender, minted);
        OutcomeToken(m.low).mint(msg.sender, minted);

        emit Split(id, msg.sender, minted);
    }

    /**
     * The inverse, available any time before settlement.
     *
     * Burning both halves is the only way back out before the index is known,
     * which is what keeps the two supplies equal without the vault having to
     * track who holds what.
     *
     * The caller receives whatever leaves this contract, so a fee-on-transfer
     * collateral costs the withdrawer rather than the market. Burning the full
     * `amount` against a short receipt is correct: the shortfall is the token's
     * fee, not collateral that belongs to anyone still in the market.
     */
    function merge(bytes32 id, uint256 amount) external returns (uint256 returned) {
        if (amount == 0) revert ZeroAmount();
        Market storage m = _markets[id];
        if (m.high == address(0)) revert NoMarket();
        if (m.settled || m.voided) revert AlreadySettled();

        OutcomeToken(m.high).burn(msg.sender, amount);
        OutcomeToken(m.low).burn(msg.sender, amount);
        m.collateral -= amount;

        uint256 before = collateralToken.balanceOf(address(this));
        collateralToken.safeTransfer(msg.sender, amount);
        returned = before - collateralToken.balanceOf(address(this));

        emit Merge(id, msg.sender, amount, returned);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    function markets(bytes32 id) external view returns (Market memory) {
        return _markets[id];
    }

    function outcomes(bytes32 id) external view returns (address high, address low) {
        Market storage m = _markets[id];
        if (m.high == address(0)) revert NoMarket();
        return (m.high, m.low);
    }

    /// @notice Collateral held against a single market, never pooled across them.
    function collateralOf(bytes32 id) external view returns (uint256) {
        return _markets[id].collateral;
    }
}
