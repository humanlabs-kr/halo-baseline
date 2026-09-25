// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * One half of a market's outcome pair.
 *
 * A market mints two of these — HIGH and LOW — and they only ever exist in
 * equal supply, because the only way to create either is to deposit collateral
 * and receive both. That invariant lives in the vault; this contract's job is
 * to be an ERC-20 that the vault can mint and burn, and nothing else.
 *
 * WHY THIS IS NOT ERC-6909. A Uniswap v4 pool addresses its currencies by
 * contract address, so an outcome that is a token id inside a shared contract
 * cannot be a pool currency. Each outcome therefore needs its own address, and
 * with hundreds of markets that has to be a clone rather than a deployment:
 * an EIP-1167 proxy is about 45k gas against roughly 700k for a full ERC-20.
 *
 * Being a clone is why there is no constructor. `initialize` stands in for one
 * and can only be called once, by whoever deploys the clone — which in practice
 * is the vault, inside the same transaction that creates the market.
 *
 * DECIMALS MIRROR THE COLLATERAL. A market denominated in six-decimal USDC
 * issues six-decimal outcome tokens, so one unit of HIGH redeems for at most
 * one unit of collateral and the pool price reads directly as a payout ratio
 * in [0, 1]. Fixing this at eighteen would put a 10^12 factor between the two
 * numbers a trader is looking at.
 */
contract OutcomeToken {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error AlreadyInitialized();
    error NotVault();
    error InsufficientBalance();
    error InsufficientAllowance();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The only address allowed to mint or burn. Set once, never rotated.
    address public vault;

    string public name;
    string public symbol;
    uint8 public decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /*//////////////////////////////////////////////////////////////
                              INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /**
     * Stand-in for a constructor, because clones do not run one.
     *
     * Guarded on `vault` rather than a separate boolean: the implementation
     * contract this is cloned from has `vault == address(0)` and every clone
     * gets a non-zero one here, so a second call is impossible on either.
     * That also means the implementation itself can never be initialised and
     * then used as if it were a market.
     */
    function initialize(address vault_, string calldata name_, string calldata symbol_, uint8 decimals_)
        external
    {
        if (vault != address(0)) revert AlreadyInitialized();
        vault = vault_;
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    /*//////////////////////////////////////////////////////////////
                              VAULT-ONLY SUPPLY
    //////////////////////////////////////////////////////////////*/

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    function mint(address to, uint256 amount) external onlyVault {
        totalSupply += amount;
        unchecked {
            // Cannot overflow: a balance is bounded by totalSupply, which was
            // just checked.
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external onlyVault {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }

    /*//////////////////////////////////////////////////////////////
                                  ERC-20
    //////////////////////////////////////////////////////////////*/

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
