// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {HaloIndexOracle, IOpenInterest} from "./HaloIndexOracle.sol";
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
contract EpochVault is IOpenInterest {
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
    error NotSettled();
    error NothingToRedeem();
    error Frozen();

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
    event Settled(bytes32 indexed marketId, int256 valueBps, uint256 payoutHighWad);
    event VoidSettled(bytes32 indexed marketId);
    event Redeemed(bytes32 indexed marketId, address indexed who, uint256 high, uint256 low, uint256 paid);

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

    /// @notice One WAD. Payout ratios live in [0, WAD].
    uint256 internal constant WAD = 1e18;

    /// @notice The token every market in this vault is denominated in.
    IERC20 public immutable collateralToken;

    /// @notice Where settlement values come from. Never trusted before finalisation.
    HaloIndexOracle public immutable oracle;

    /// @notice Clone target for outcome tokens. Never initialised itself.
    address public immutable outcomeImplementation;

    uint8 internal immutable _outcomeDecimals;

    mapping(bytes32 => Market) internal _markets;

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(address collateralToken_, address oracle_) {
        if (collateralToken_ == address(0) || oracle_ == address(0)) revert ZeroAddress();
        collateralToken = IERC20(collateralToken_);
        oracle = HaloIndexOracle(oracle_);

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
                                  THE FREEZE
    //////////////////////////////////////////////////////////////*/

    /**
     * Whether this market is inside the window where nobody may reprice it.
     *
     * The window opens when the epoch closes — not when a value is published.
     * By publication time whoever computed the index has known it for hours,
     * and that gap is exactly when they can take the other side of a book
     * that cannot see what they see.
     *
     * It closes when the oracle reaches a terminal state, whether that is a
     * finalised value or a void. Until then the position set is fixed.
     *
     * WHY THE VAULT AND NOT JUST THE POOL. Freezing swaps alone moves the
     * front-run rather than stopping it: anyone who can still mint a complete
     * set can take the side they want at par and redeem into the answer. The
     * pool hook and this check are the same rule applied at both doors.
     */
    function isFrozen(bytes32 id) public view returns (bool) {
        Market storage m = _markets[id];
        if (m.high == address(0)) return false;

        uint64 freezeAt = oracle.freezeAt(m.seriesId, m.epoch);
        if (freezeAt == 0 || block.timestamp < freezeAt) return false;

        HaloIndexOracle.Status s = oracle.statusOf(m.seriesId, m.epoch);
        return s != HaloIndexOracle.Status.Finalized && s != HaloIndexOracle.Status.Voided;
    }

    modifier notFrozen(bytes32 id) {
        if (isFrozen(id)) revert Frozen();
        _;
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
    function split(bytes32 id, uint256 amount) external notFrozen(id) returns (uint256 minted) {
        if (amount == 0) revert ZeroAmount();
        Market storage m = _markets[id];
        if (m.high == address(0)) revert NoMarket();
        if (m.settled || m.voided) revert AlreadySettled();

        uint256 before = collateralToken.balanceOf(address(this));
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        minted = collateralToken.balanceOf(address(this)) - before;
        if (minted == 0) revert ZeroAmount();

        m.collateral += minted;
        _openInterest[m.seriesId][m.epoch] += minted;
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
    function merge(bytes32 id, uint256 amount) external notFrozen(id) returns (uint256 returned) {
        if (amount == 0) revert ZeroAmount();
        Market storage m = _markets[id];
        if (m.high == address(0)) revert NoMarket();
        if (m.settled || m.voided) revert AlreadySettled();

        OutcomeToken(m.high).burn(msg.sender, amount);
        OutcomeToken(m.low).burn(msg.sender, amount);
        m.collateral -= amount;
        _openInterest[m.seriesId][m.epoch] -= amount;

        uint256 before = collateralToken.balanceOf(address(this));
        collateralToken.safeTransfer(msg.sender, amount);
        returned = before - collateralToken.balanceOf(address(this));

        emit Merge(id, msg.sender, amount, returned);
    }

    /*//////////////////////////////////////////////////////////////
                           SETTLEMENT AND REDEMPTION
    //////////////////////////////////////////////////////////////*/

    /**
     * Freeze the payoff ratio against the finalised index.
     *
     * Permissionless, because it reads a value that has already survived the
     * oracle's challenge window — there is nothing left to decide and no
     * reason to make holders wait on anyone in particular to press it.
     *
     *   p = clamp((value - strike) / (cap - strike), 0, 1)
     *
     * `oracle.read` reverts unless the epoch is Finalized, so this cannot run
     * on a value that is merely published, or on one that lost a dispute.
     */
    function settle(bytes32 id) external {
        Market storage m = _markets[id];
        if (m.high == address(0)) revert NoMarket();
        if (m.settled || m.voided) revert AlreadySettled();

        int256 value = oracle.read(m.seriesId, m.epoch);

        uint256 p;
        if (value <= m.strikeBps) {
            p = 0;
        } else if (value >= m.capBps) {
            p = WAD;
        } else {
            // Both differences are positive here and cap > strike was enforced
            // at creation, so neither the cast nor the division can surprise.
            p = (uint256(value - m.strikeBps) * WAD) / uint256(m.capBps - m.strikeBps);
        }

        m.payoutHighWad = p;
        m.settled = true;
        emit Settled(id, value, p);
    }

    /**
     * The epoch was never agreed, so give everything back at even odds.
     *
     * Also permissionless, and deliberately so: a void that depended on this
     * contract's owner would reintroduce the stranded-collateral state the
     * oracle's void path exists to remove.
     */
    function settleVoid(bytes32 id) external {
        Market storage m = _markets[id];
        if (m.high == address(0)) revert NoMarket();
        if (m.settled || m.voided) revert AlreadySettled();
        if (!oracle.isVoided(m.seriesId, m.epoch)) revert NotSettled();

        m.payoutHighWad = WAD / 2;
        m.voided = true;
        m.settled = true;
        emit VoidSettled(id);
    }

    /**
     * Burn what the caller holds and pay what it is worth.
     *
     * ROUNDING. A complete set is redeemed at one-for-one before either side
     * is scaled, which makes redemption exact for anyone who never traded —
     * they put in N and take out N regardless of where the index landed. Only
     * the unmatched remainder is multiplied by the ratio, and both directions
     * round down.
     *
     * Rounding both down is what guarantees the last redeemer never reverts.
     * The tempting alternative — floor one side and hand the other the
     * remainder — pays out up to one wei more per holder than the market
     * holds, and the person who finds out is whoever redeems last.
     *
     * The cost is at most one wei per side per holder left in the vault. That
     * is a rounding crumb; a revert is a support ticket.
     */
    function redeem(bytes32 id) external returns (uint256 paid) {
        Market storage m = _markets[id];
        if (m.high == address(0)) revert NoMarket();
        if (!m.settled) revert NotSettled();

        OutcomeToken high = OutcomeToken(m.high);
        OutcomeToken low = OutcomeToken(m.low);

        uint256 h = high.balanceOf(msg.sender);
        uint256 l = low.balanceOf(msg.sender);
        if (h == 0 && l == 0) revert NothingToRedeem();

        // A matched pair is worth exactly one unit of collateral whatever the
        // ratio is, because the two payouts are defined to sum to one.
        uint256 pair = h < l ? h : l;
        paid = pair;

        uint256 p = m.payoutHighWad;
        unchecked {
            uint256 hRest = h - pair;
            uint256 lRest = l - pair;
            if (hRest != 0) paid += (hRest * p) / WAD;
            if (lRest != 0) paid += (lRest * (WAD - p)) / WAD;
        }

        if (h != 0) high.burn(msg.sender, h);
        if (l != 0) low.burn(msg.sender, l);
        m.collateral -= paid;

        collateralToken.safeTransfer(msg.sender, paid);
        emit Redeemed(id, msg.sender, h, l, paid);
    }

    /*//////////////////////////////////////////////////////////////
                              OPEN INTEREST
    //////////////////////////////////////////////////////////////*/

    /**
     * What the oracle sizes a publication bond against.
     *
     * Summed across every market on this (series, epoch), because a false
     * value settles all of them at once and the bond has to exceed what that
     * is worth in total rather than what one strike is worth.
     */
    function openInterestOf(bytes32 seriesId, uint64 epoch) external view returns (uint256) {
        return _openInterest[seriesId][epoch];
    }

    mapping(bytes32 => mapping(uint64 => uint256)) internal _openInterest;

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
