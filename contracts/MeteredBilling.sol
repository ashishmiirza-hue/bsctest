// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MeteredBilling
/// @notice Pay-as-you-go USDT billing with a user-set spending limit.
///
/// How it protects the user — the contract enforces all of this, the operator cannot override it:
///  - Nothing is ever charged when the user authorizes. The only thing authorizing does is set an
///    ERC-20 allowance (the spending limit) with the user's wallet.
///  - The operator can only ever pull USDT the user has already allowed. The user's current
///    allowance is the hard ceiling on everything still owed, and it goes down with each charge.
///  - Every charge moves USDT straight to `treasury`. There is no function that moves an arbitrary
///    amount anywhere else, and no function that raises a user's allowance — only the user can.
///  - The user can stop billing on-chain at any time with stop(); after that no charge is possible,
///    even if an allowance is still in place. They can also set the allowance back to zero in their
///    wallet. Either one is enough on its own.
///  - `maxPerCharge` is an extra ceiling the owner sets on any single charge, as a guard against a
///    compromised owner key draining a user's whole remaining allowance in one transaction.
///  - The treasury can only be changed after a public 2-day delay, and ownership transfer is 2-step.
interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract MeteredBilling {
    address public immutable token;
    address public owner;
    address public pendingOwner;
    address public treasury;
    address public pendingTreasury;
    uint64 public treasuryChangeAt;
    uint64 public constant TREASURY_DELAY = 2 days;

    uint256 public maxPerCharge; // 0 = no per-charge ceiling (the allowance is still the hard bound)

    mapping(address => uint256) public totalCharged; // lifetime USDT pulled from this user
    mapping(address => bool) public stopped;         // user (or owner) blocked all charging

    event Charged(address indexed user, uint256 amount, uint256 totalCharged);
    event Stopped(address indexed user, address indexed by);
    event Resumed(address indexed user);
    event MaxPerChargeSet(uint256 amount);
    event TreasuryProposed(address indexed treasury, uint256 effectiveAt);
    event TreasuryChanged(address indexed treasury);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address token_, address treasury_) {
        require(token_ != address(0) && treasury_ != address(0), "zero address");
        require(token_.code.length > 0, "token is not a contract");
        token = token_;
        treasury = treasury_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------- views

    /// @notice USDT that can still be charged to this user: their allowance, or 0 if stopped.
    function remaining(address user) external view returns (uint256) {
        if (stopped[user]) return 0;
        return IERC20(token).allowance(user, address(this));
    }

    // ---------------------------------------------------------------- user

    /// @notice Block every future charge. The user calls this themselves.
    function stop() external {
        stopped[msg.sender] = true;
        emit Stopped(msg.sender, msg.sender);
    }

    /// @notice Allow charging again (the allowance still has to be in place).
    function resume() external {
        stopped[msg.sender] = false;
        emit Resumed(msg.sender);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Pull `amount` USDT from `user` for usage they have run up. Reverts if the user
    ///         stopped billing, the amount is zero, it exceeds maxPerCharge, or the user's
    ///         allowance/balance is too low.
    function charge(address user, uint256 amount) external onlyOwner {
        require(!stopped[user], "user stopped billing");
        require(amount > 0, "amount");
        if (maxPerCharge > 0) require(amount <= maxPerCharge, "over per-charge max");
        totalCharged[user] += amount;
        _pull(user, amount);
        emit Charged(user, amount, totalCharged[user]);
    }

    function stopFor(address user) external onlyOwner {
        stopped[user] = true;
        emit Stopped(user, msg.sender);
    }

    function setMaxPerCharge(uint256 amount) external onlyOwner {
        maxPerCharge = amount;
        emit MaxPerChargeSet(amount);
    }

    function proposeTreasury(address treasury_) external onlyOwner {
        pendingTreasury = treasury_;
        treasuryChangeAt = uint64(block.timestamp) + TREASURY_DELAY;
        emit TreasuryProposed(treasury_, treasuryChangeAt);
    }

    function applyTreasury() external onlyOwner {
        require(pendingTreasury != address(0), "nothing proposed");
        require(block.timestamp >= treasuryChangeAt, "too early");
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChanged(treasury);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------- internal

    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, treasury, amount)
        );
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "payment failed");
    }
}
