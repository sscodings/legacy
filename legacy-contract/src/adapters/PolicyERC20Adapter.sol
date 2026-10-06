// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVaultExecutor} from "../interfaces/IVaultExecutor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ILegacyVaultForAdapter {
    function claimInitiatedAt(address heir) external view returns (uint256);
    function contestableWindow() external view returns (uint256);
}

/// @title PolicyERC20Adapter
/// @notice Non-custodial policy adapter that enforces programmable release delays upon succession.
contract PolicyERC20Adapter is IVaultExecutor {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public immutable amount;
    address public immutable vault;
    uint256 public immutable releaseDelay;
    address public immutable beneficiary;
    address public immutable fallbackBeneficiary;

    error NotVault();
    error InsufficientBalance();
    error InsufficientAllowance();
    error InvalidAddress();
    error InvalidAmount();
    error UnauthorizedRecipient();
    error ReleaseTimelocked(uint256 availableAt, uint256 currentTimestamp);

    event TokenTransferred(address indexed token, address indexed from, address indexed to, uint256 amount);

    constructor(
        address _token,
        uint256 _amount,
        address _vault,
        uint256 _releaseDelay,
        address _beneficiary,
        address _fallbackBeneficiary
    ) {
        if (_token == address(0) || _vault == address(0) || _beneficiary == address(0)) {
            revert InvalidAddress();
        }
        if (_amount == 0) {
            revert InvalidAmount();
        }

        token = IERC20(_token);
        amount = _amount;
        vault = _vault;
        releaseDelay = _releaseDelay;
        beneficiary = _beneficiary;
        fallbackBeneficiary = _fallbackBeneficiary;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    function checkOwnership(address expectedOwner) external view override returns (bool) {
        return token.balanceOf(expectedOwner) >= amount && token.allowance(expectedOwner, address(this)) >= amount;
    }

    /**
     * @notice Returns the earliest block timestamp at which this adapter can execute.
     */
    function getReleaseTimestamp(address claimant) public view returns (uint256) {
        if (releaseDelay == 0) return 0;
        ILegacyVaultForAdapter v = ILegacyVaultForAdapter(vault);
        uint256 initiatedAt = v.claimInitiatedAt(claimant);
        if (initiatedAt == 0) return 0;
        uint256 contestable = v.contestableWindow();
        return initiatedAt + contestable + releaseDelay;
    }

    function transferControl(address from, address to) external override onlyVault {
        if (to != beneficiary && (fallbackBeneficiary == address(0) || to != fallbackBeneficiary)) {
            revert UnauthorizedRecipient();
        }

        if (releaseDelay > 0) {
            uint256 releaseTime = getReleaseTimestamp(to);
            if (releaseTime > 0 && block.timestamp < releaseTime) {
                revert ReleaseTimelocked(releaseTime, block.timestamp);
            }
        }

        if (token.balanceOf(from) < amount) {
            revert InsufficientBalance();
        }
        if (token.allowance(from, address(this)) < amount) {
            revert InsufficientAllowance();
        }

        token.safeTransferFrom(from, to, amount);

        emit TokenTransferred(address(token), from, to, amount);
    }
}
