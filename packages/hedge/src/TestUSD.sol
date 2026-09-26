// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Six-decimal collateral for a testnet, mintable by anyone.
 *
 * WHY NOT A TESTNET USDC. Because a demo that depends on a faucet is a demo
 * that fails at the venue. This one anybody can mint, including a judge who
 * wants to walk the flow themselves rather than watch it.
 *
 * WHY SIX DECIMALS. Because that is what the real collateral would be, and the
 * vault's arithmetic — the payout ratio, the exact-pair redemption, the bond
 * conversion — all behave differently at six than at eighteen. Demoing on an
 * eighteen-decimal token would be demoing a different contract. The unit
 * mismatch that made the publication bond meaningless for a while was only
 * visible because the tests used six.
 *
 * Deliberately has no owner, no cap and no pause. It is a testnet fixture and
 * pretending otherwise would invite somebody to treat it as collateral.
 */
contract TestUSD {
    string public constant name = "Halo Test USD";
    string public constant symbol = "tUSD";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error InsufficientBalance();
    error InsufficientAllowance();

    /// @notice Anyone, any amount. This is a fixture, not a currency.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
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
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
