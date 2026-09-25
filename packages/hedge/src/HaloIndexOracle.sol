// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * The index that settles the cover, published so that being wrong is provable.
 *
 * A signature proves who said a number. It does not prove the number is right,
 * and the difference is the whole design here. A gateway that signs an index
 * can be honest, buggy or lying, and the signature is identical in all three
 * cases — so a contract that pays out on one is a contract whose collateral
 * belongs to whoever holds the key.
 *
 * What makes a number settleable is not the signature but the procedure around
 * it, and that procedure is four steps:
 *
 *   1. OPEN      the rules are hashed and committed BEFORE any data exists, so
 *                the publisher cannot choose the window, the trim or the floor
 *                after seeing which choice pays them.
 *   2. PUBLISH   the median goes up with a Merkle root over the observations
 *                AND the IPFS CID of the full leaf set, backed by a bond.
 *   3. CHALLENGE anyone fetches the leaves, re-runs the committed rules, and
 *                disputes if the answer differs. There is time to do it.
 *   4. FINALIZE  only now can the vault read the value and move money.
 *
 * WHY THE CID AND NOT JUST THE ROOT. A Merkle root proves a leaf is in the
 * tree. The attack on a median is not insertion, it is censorship: drop the
 * observations on the wrong side, publish an honest median of what is left,
 * and the root is valid, the rules hash matches, and the bond is untouchable.
 * Exclusion is only provable if the full input set is published, so the CID is
 * committed in the same transaction as the root and the leaves carry no
 * identity — a price, a shop and a date are not personal data, and unlinking
 * them is what lets the input be public at all.
 *
 * VOID IS NOT OPTIONAL. An epoch that is never successfully published would
 * otherwise lock its markets' collateral forever. That is the single most
 * likely way this system loses user money, so `voidAfter` is set at open and
 * anyone may trip it.
 */
contract HaloIndexOracle {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotGovernance();
    error EpochExists();
    error NoEpoch();
    error ZeroRules();
    error BadWindow();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event EpochOpened(
        bytes32 indexed seriesId,
        uint64 indexed epoch,
        bytes32 rulesHash,
        uint64 closesAt,
        uint64 voidAfter
    );

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    enum Status {
        None,
        Open, // accepting observations; nothing published
        Published, // a value is up and the challenge window is running
        Disputed, // challenged; waiting on the arbiter
        Finalized, // settleable
        Voided // nothing was ever agreed; collateral comes back 50/50

    }

    struct Epoch {
        /// @dev Hash of the methodology and its parameters. Committed at open.
        bytes32 rulesHash;
        /// @dev Merkle root over the observation leaves. Proves inclusion.
        bytes32 leavesRoot;
        /// @dev IPFS CID of the full leaf array. Proves exclusion.
        bytes32 leavesCID;
        /// @dev The published change, in basis points. Signed.
        int256 valueBps;
        /// @dev Last moment an observation may be counted.
        uint64 closesAt;
        uint64 publishedAt;
        uint64 challengeEnd;
        /// @dev After this, anyone may void. Collateral must always come back.
        uint64 voidAfter;
        address publisher;
        uint256 bond;
        Status status;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Opens epochs and resolves disputes. A multisig, for now.
    address public governance;

    /// @dev seriesId => epoch => record
    mapping(bytes32 => mapping(uint64 => Epoch)) internal _epochs;

    constructor(address governance_) {
        governance = governance_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                                  OPENING
    //////////////////////////////////////////////////////////////*/

    /**
     * Commit the rules before the data exists.
     *
     * `rulesHash` covers the methodology document and every parameter in it:
     * the matching key, the window, the trim proportion, the per-person cap,
     * the outlet floor. Fixing them here is what stops the publisher picking,
     * after the fact, the variant that happens to pay their own position.
     *
     * It cannot be changed afterwards. An epoch that needs different rules is
     * a different epoch.
     */
    function openEpoch(
        bytes32 seriesId,
        uint64 epoch,
        bytes32 rulesHash,
        uint64 closesAt,
        uint64 challengeWindow,
        uint64 voidWindow
    ) external onlyGovernance {
        if (rulesHash == bytes32(0)) revert ZeroRules();
        if (closesAt <= block.timestamp) revert BadWindow();
        // A void window that does not outlast the challenge window would let an
        // epoch be voided while a legitimate dispute is still being resolved.
        if (voidWindow <= challengeWindow) revert BadWindow();

        Epoch storage e = _epochs[seriesId][epoch];
        if (e.status != Status.None) revert EpochExists();

        e.rulesHash = rulesHash;
        e.closesAt = closesAt;
        e.voidAfter = closesAt + voidWindow;
        e.status = Status.Open;

        // Stored on the record rather than as a constant so a series with a
        // slow statistics cycle can be given a longer window than a fast one.
        _challengeWindow[seriesId][epoch] = challengeWindow;

        emit EpochOpened(seriesId, epoch, rulesHash, closesAt, e.voidAfter);
    }

    /// @dev Per-epoch because publication cadence differs by series.
    mapping(bytes32 => mapping(uint64 => uint64)) internal _challengeWindow;

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    function epochs(bytes32 seriesId, uint64 epoch) external view returns (Epoch memory) {
        return _epochs[seriesId][epoch];
    }

    function challengeWindow(bytes32 seriesId, uint64 epoch) external view returns (uint64) {
        return _challengeWindow[seriesId][epoch];
    }

    function statusOf(bytes32 seriesId, uint64 epoch) external view returns (Status) {
        return _epochs[seriesId][epoch].status;
    }

    /**
     * When trading in this series' markets must stop.
     *
     * The freeze starts at epoch close, not at publication. By the time a value
     * is published the answer is already known to whoever computed it, and the
     * window between close and publish is exactly when someone with early
     * sight of the data can trade against a book that has none.
     */
    function freezeAt(bytes32 seriesId, uint64 epoch) external view returns (uint64) {
        return _epochs[seriesId][epoch].closesAt;
    }

    function setGovernance(address next) external onlyGovernance {
        governance = next;
    }
}
