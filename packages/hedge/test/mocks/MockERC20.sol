// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev The ordinary case: transfers move exactly what they say they move.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * The case the vault is actually defended against.
 *
 * Bridged stablecoins are upgradeable, and the decision to start charging on
 * transfer belongs to whoever holds the bridge's keys rather than to us. This
 * burns a fixed proportion of every transfer so a vault that trusts its own
 * arguments mints more outcome tokens than it holds collateral for.
 */
contract FeeOnTransferERC20 is MockERC20 {
    /// @dev Basis points taken from every transfer and destroyed.
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) MockERC20("Fee On Transfer", "FOT", 6) {
        feeBps = feeBps_;
    }

    function _fee(uint256 amount) internal view returns (uint256) {
        return (amount * feeBps) / 10_000;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        uint256 fee = _fee(amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(msg.sender, to, amount - fee);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        uint256 fee = _fee(amount);
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
        return true;
    }
}
