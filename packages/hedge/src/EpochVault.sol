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
