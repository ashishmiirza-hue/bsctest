// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CreditSubscriptions
/// @notice Capped, cancellable USDT subscriptions.
///
/// What this contract can and cannot do with a subscriber's allowance:
///  - It can only ever pull the plan price that was locked in when the user subscribed.
///  - It can pull at most `maxCharges` times in total (first payment included).
///  - Two charges are always at least `period` seconds apart. Missed periods are NOT
///    caught up: a late charge restarts the clock from the moment it happens.
///  - The user can cancel at any time; after that no charge is possible.
///  - Funds always go to `treasury`. There is no function that moves an arbitrary amount.
///  - The treasury address can only be changed after a public 2-day waiting period.
interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract CreditSubscriptions {
    struct Plan {
        uint128 price;      // token units charged per period
        uint32 period;      // seconds between charges
        uint16 maxCharges;  // total number of charges the authorization covers
        bool active;        // open for new subscriptions
    }

    struct Sub {
        uint32 planId;
        uint128 price;      // locked at subscribe time
        uint32 period;      // locked at subscribe time
        uint16 maxCharges;  // locked at subscribe time
        uint16 charges;     // charges taken so far
        uint64 nextChargeAt;
        bool active;
    }

    address public immutable token;
    uint32 public immutable minPeriod;
    address public owner;
    address public pendingOwner;
    address public treasury;
    address public pendingTreasury;
    uint64 public treasuryChangeAt;
    uint64 public constant TREASURY_DELAY = 2 days;

    Plan[] public plans;
    mapping(address => Sub) public subs;

    event PlanCreated(uint256 indexed planId, uint256 price, uint256 period, uint256 maxCharges);
    event PlanStatus(uint256 indexed planId, bool active);
    event Subscribed(address indexed user, uint256 indexed planId, uint256 price, uint256 period, uint256 maxCharges, uint256 nextChargeAt);
    event Charged(address indexed user, uint256 indexed planId, uint256 amount, uint256 chargeNo, uint256 nextChargeAt);
    event Cancelled(address indexed user, address indexed by);
    event Completed(address indexed user);
    event TreasuryProposed(address indexed treasury, uint256 effectiveAt);
    event TreasuryChanged(address indexed treasury);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address token_, address treasury_, uint32 minPeriod_) {
        require(token_ != address(0) && treasury_ != address(0), "zero address");
        require(token_.code.length > 0, "token is not a contract");
        require(minPeriod_ > 0, "minPeriod");
        token = token_;
        treasury = treasury_;
        minPeriod = minPeriod_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------- views

    function planCount() external view returns (uint256) {
        return plans.length;
    }

    /// @notice Total amount a subscriber to this plan authorizes (price x maxCharges).
    function capOf(uint256 planId) public view returns (uint256) {
        Plan memory p = plans[planId];
        return uint256(p.price) * p.maxCharges;
    }

    /// @notice Amount that can still be charged to this user under the current subscription.
    function remainingCap(address user) external view returns (uint256) {
        Sub memory s = subs[user];
        if (!s.active) return 0;
        return uint256(s.price) * (s.maxCharges - s.charges);
    }

    // ---------------------------------------------------------------- admin

    function createPlan(uint128 price, uint32 period, uint16 maxCharges) external onlyOwner returns (uint256 planId) {
        require(price > 0, "price");
        require(period >= minPeriod, "period too short");
        require(maxCharges > 0, "maxCharges");
        planId = plans.length;
        plans.push(Plan(price, period, maxCharges, true));
        emit PlanCreated(planId, price, period, maxCharges);
    }

    /// @notice Plans are immutable; to change terms, close the plan and create a new one.
    function setPlanActive(uint256 planId, bool active) external onlyOwner {
        plans[planId].active = active;
        emit PlanStatus(planId, active);
    }

    /// @notice Step 1 of changing where payments go. Takes effect no sooner than TREASURY_DELAY later,
    ///         so a stolen owner key cannot redirect payments instantly. Propose address(0) to abort.
    function proposeTreasury(address treasury_) external onlyOwner {
        pendingTreasury = treasury_;
        treasuryChangeAt = uint64(block.timestamp) + TREASURY_DELAY;
        emit TreasuryProposed(treasury_, treasuryChangeAt);
    }

    /// @notice Step 2, after the waiting period.
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

    /// @notice Take one renewal payment. Reverts if it is not due, the cap is used up,
    ///         the subscription is cancelled, or the user's balance/allowance is short.
    function charge(address user) external onlyOwner {
        Sub storage s = subs[user];
        require(s.active, "not active");
        require(block.timestamp >= s.nextChargeAt, "not due");
        require(s.charges < s.maxCharges, "cap reached");

        s.charges += 1;
        s.nextChargeAt = uint64(block.timestamp) + s.period;
        bool done = s.charges == s.maxCharges;
        if (done) s.active = false;

        _pull(user, s.price);
        emit Charged(user, s.planId, s.price, s.charges, s.nextChargeAt);
        if (done) emit Completed(user);
    }

    function cancelFor(address user) external onlyOwner {
        _cancel(user);
    }

    // ---------------------------------------------------------------- users

    /// @param expectedPrice must equal the plan price the user was shown.
    function subscribe(uint256 planId, uint256 expectedPrice) external {
        Plan memory p = plans[planId];
        require(p.active, "plan closed");
        require(p.price == expectedPrice, "price changed");
        require(!subs[msg.sender].active, "already subscribed");

        uint64 next = uint64(block.timestamp) + p.period;
        bool done = p.maxCharges == 1;
        subs[msg.sender] = Sub(uint32(planId), p.price, p.period, p.maxCharges, 1, next, !done);

        _pull(msg.sender, p.price);
        emit Subscribed(msg.sender, planId, p.price, p.period, p.maxCharges, next);
        if (done) emit Completed(msg.sender);
    }

    function cancel() external {
        _cancel(msg.sender);
    }

    // ---------------------------------------------------------------- internal

    function _cancel(address user) internal {
        Sub storage s = subs[user];
        require(s.active, "not active");
        s.active = false;
        emit Cancelled(user, msg.sender);
    }

    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, treasury, amount)
        );
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "payment failed");
    }
}
