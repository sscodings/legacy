// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ILivenessVerifier} from "./interfaces/ILivenessVerifier.sol";
import {IVaultExecutor} from "./interfaces/IVaultExecutor.sol";

contract LegacyVault is Initializable, ReentrancyGuardTransient {
    enum Status {
        Green,
        Amber,
        Red
    }

    enum ClaimStatus {
        NotInitiated,
        Contestable,
        Claimed
    }

    struct Allocation {
        address heir;
        IVaultExecutor executor;
        bytes32 assetId;
        bool exists;
        bool executed;
    }

    address public owner;
    ILivenessVerifier public verifier;
    bool public livenessRegistered;

    // Incremented after every successful liveness registration and check-in.
    // Feeds `livenessChallenge()`, so each liveness proof that commits to the
    // challenge (e.g. a passkey assertion) can be used exactly once.
    uint256 public livenessNonce;

    uint256 public lastCheckIn;
    uint256 public checkInInterval;
    uint256 public gracePeriod;
    uint256 public contestableWindow;

    bytes32 private constant LIVENESS_CHALLENGE_DOMAIN = keccak256("Legacy.LivenessChallenge.v1");

    uint256 public constant MIN_CHECK_IN_INTERVAL = 5;
    uint256 public constant MIN_CONTESTABLE_WINDOW = 5;

    // -------------------------------------------------------------------------
    // Guardians (death attestation / accelerated succession)
    // -------------------------------------------------------------------------

    // Trusted parties nominated by the owner who can collectively attest that
    // the owner has died. A unanimous attestation ("death confirmed") shrinks
    // every timelock on this vault to 1% of its nominal value — a 99% cut to
    // the time heirs must wait to inherit.
    uint256 public constant DEATH_ACCEL_NUMERATOR = 1;
    uint256 public constant DEATH_ACCEL_DENOMINATOR = 100;

    mapping(address guardian => bool) public isGuardian;
    address[] private guardians;

    mapping(address guardian => bool) public hasAttestedDeath;
    uint256 public deathAttestationCount;
    bool public deathConfirmed;
    uint256 public deathConfirmedAt;

    // -------------------------------------------------------------------------
    // Heirs
    // -------------------------------------------------------------------------

    mapping(address heir => bool) public isHeir;
    address[] private heirs;

    // -------------------------------------------------------------------------
    // Claims
    // -------------------------------------------------------------------------

    mapping(address heir => ClaimStatus) public claimStatus;
    mapping(address heir => uint256) public claimInitiatedAt;

    // -------------------------------------------------------------------------
    // Asset Allocations
    // -------------------------------------------------------------------------

    mapping(bytes32 assetId => Allocation) public allocations;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event CheckedIn(uint256 timestamp);

    event ParametersUpdated(uint256 checkInInterval, uint256 gracePeriod, uint256 contestableWindow);

    event HeirAdded(address indexed heir);
    event HeirRemoved(address indexed heir);

    event GuardianAdded(address indexed guardian);
    event GuardianRemoved(address indexed guardian);

    event DeathAttested(address indexed guardian, uint256 attestations, uint256 totalGuardians);
    event DeathAttestationRevoked(address indexed guardian, uint256 attestations, uint256 totalGuardians);
    event DeathConfirmed(uint256 timestamp);
    event DeathAttestationsReset();

    event ClaimInitiated(address indexed heir, uint256 timestamp);

    event ClaimFinalized(address indexed heir, uint256 timestamp);

    event AssetAssigned(bytes32 indexed assetId, address indexed heir, address indexed executor);

    event AssetRemoved(bytes32 indexed assetId);

    event AssetClaimed(bytes32 indexed assetId, address indexed heir, uint256 timestamp);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotOwner();
    error ParametersLockedWhileNotGreen();
    error IntervalTooShort();
    error ContestableWindowTooShort();

    error VaultNotRed();

    error ClaimAlreadyInitiated();
    error ClaimNotContestable();
    error ContestableWindowNotElapsed();

    error LivenessNotRegistered();
    error LivenessAlreadyRegistered();

    error InvalidHeir();
    error HeirAlreadyRegistered();
    error HeirNotRegistered();
    error HeirChangesLocked();

    error InvalidGuardian();
    error GuardianAlreadyRegistered();
    error GuardianNotRegistered();
    error NotGuardian();
    error AlreadyAttestedDeath();
    error NotAttestedDeath();
    error DeathAlreadyConfirmed();

    error InvalidAssetId();
    error InvalidExecutor();
    error AssetNotAssigned();
    error AssetAlreadyAssigned();
    error AssetAlreadyClaimed();
    error NotAssignedHeir();
    error ClaimNotFinalized();

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGreen() {
        if (getStatus() != Status.Green) {
            revert HeirChangesLocked();
        }
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor & Initializer
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _owner,
        ILivenessVerifier _verifier,
        uint256 _checkInInterval,
        uint256 _gracePeriod,
        uint256 _contestableWindow
    ) external initializer {
        if (_checkInInterval < MIN_CHECK_IN_INTERVAL) revert IntervalTooShort();
        if (_contestableWindow < MIN_CONTESTABLE_WINDOW) revert ContestableWindowTooShort();

        owner = _owner;
        verifier = _verifier;

        checkInInterval = _checkInInterval;
        gracePeriod = _gracePeriod;
        contestableWindow = _contestableWindow;

        lastCheckIn = block.timestamp;
    }

    // -------------------------------------------------------------------------
    // Vault status
    // -------------------------------------------------------------------------

    function getStatus() public view returns (Status) {
        uint256 elapsed = block.timestamp - lastCheckIn;

        uint256 interval = _effectiveDuration(checkInInterval);
        uint256 grace = _effectiveDuration(gracePeriod);

        if (elapsed < interval) {
            return Status.Green;
        }

        if (elapsed < interval + grace) {
            return Status.Amber;
        }

        return Status.Red;
    }

    /**
     * @notice Returns a timelock duration reduced to 1% of nominal once the
     *         owner's death has been unanimously attested by guardians.
     * @dev While death is unconfirmed this is the identity function, so vault
     *      behavior is unchanged for owners who never nominate guardians.
     */
    function _effectiveDuration(uint256 nominal) internal view returns (uint256) {
        if (deathConfirmed) {
            return (nominal * DEATH_ACCEL_NUMERATOR) / DEATH_ACCEL_DENOMINATOR;
        }
        return nominal;
    }

    /**
     * @notice Current effective timelock durations, accounting for any
     *         confirmed death acceleration. Intended for front-end display.
     */
    function getEffectiveTimelock() external view returns (uint256 interval, uint256 grace, uint256 contestable) {
        return
            (
                _effectiveDuration(checkInInterval),
                _effectiveDuration(gracePeriod),
                _effectiveDuration(contestableWindow)
            );
    }

    // -------------------------------------------------------------------------
    // Liveness
    // -------------------------------------------------------------------------

    /**
     * @notice The single-use value the next liveness proof must commit to.
     * @dev Bound to this chain, this vault and the current nonce, so a proof
     *      cannot be replayed on another vault, another chain, or a second time
     *      here. Verifiers whose proofs cannot commit to arbitrary data (World ID)
     *      ignore it; `checkIn` being owner-only covers replay for those.
     */
    function livenessChallenge() public view returns (bytes32) {
        return keccak256(abi.encode(LIVENESS_CHALLENGE_DOMAIN, block.chainid, address(this), livenessNonce));
    }

    /**
     * @notice Binds the owner's liveness credential to this vault, once.
     * @param proof Verifier-specific credential and proof of possession.
     */
    function registerLiveness(bytes calldata proof) external onlyOwner {
        if (livenessRegistered) {
            revert LivenessAlreadyRegistered();
        }

        verifier.registerCredential(owner, livenessChallenge(), proof);

        livenessNonce++;
        livenessRegistered = true;
    }

    /**
     * @notice Proves the owner is alive, resetting the liveness timer.
     * @param proof Verifier-specific liveness proof over `livenessChallenge()`.
     */
    function checkIn(bytes calldata proof) external onlyOwner {
        if (!livenessRegistered) {
            revert LivenessNotRegistered();
        }

        verifier.verifyLiveness(owner, livenessChallenge(), proof);

        livenessNonce++;
        lastCheckIn = block.timestamp;

        // A verified liveness proof is the strongest possible evidence the
        // owner is alive: it clears any pending or confirmed death attestations
        // and restores the vault to its nominal timelock.
        _resetDeathAttestations();

        emit CheckedIn(block.timestamp);
    }

    // -------------------------------------------------------------------------
    // Parameters
    // -------------------------------------------------------------------------

    function updateParameters(uint256 _checkInInterval, uint256 _gracePeriod, uint256 _contestableWindow)
        external
        onlyOwner
    {
        if (getStatus() != Status.Green) {
            revert ParametersLockedWhileNotGreen();
        }
        if (_checkInInterval < MIN_CHECK_IN_INTERVAL) revert IntervalTooShort();
        if (_contestableWindow < MIN_CONTESTABLE_WINDOW) revert ContestableWindowTooShort();

        checkInInterval = _checkInInterval;
        gracePeriod = _gracePeriod;
        contestableWindow = _contestableWindow;

        emit ParametersUpdated(_checkInInterval, _gracePeriod, _contestableWindow);
    }

    // -------------------------------------------------------------------------
    // Heir management
    // -------------------------------------------------------------------------

    /**
     * @notice Registers an address as an authorized heir.
     * @dev Can only happen while the vault is Green.
     */
    function addHeir(address heir) external onlyOwner onlyGreen {
        if (heir == address(0) || heir == owner) {
            revert InvalidHeir();
        }

        if (isHeir[heir]) {
            revert HeirAlreadyRegistered();
        }

        isHeir[heir] = true;
        heirs.push(heir);

        emit HeirAdded(heir);
    }

    /**
     * @notice Removes an address from the authorized heir set.
     * @dev Can only happen while the vault is Green.
     */
    function removeHeir(address heir) external onlyOwner onlyGreen {
        if (!isHeir[heir]) {
            revert HeirNotRegistered();
        }

        isHeir[heir] = false;

        // Remove from enumerable array using swap-and-pop.
        uint256 length = heirs.length;

        for (uint256 i = 0; i < length; i++) {
            if (heirs[i] == heir) {
                heirs[i] = heirs[length - 1];
                heirs.pop();
                break;
            }
        }

        emit HeirRemoved(heir);
    }

    /**
     * @notice Returns all currently registered heirs.
     */
    function getHeirs() external view returns (address[] memory) {
        return heirs;
    }

    /**
     * @notice Returns the number of currently registered heirs.
     */
    function getHeirCount() external view returns (uint256) {
        return heirs.length;
    }

    // -------------------------------------------------------------------------
    // Guardians & death attestation
    // -------------------------------------------------------------------------

    /**
     * @notice Nominates a trusted party who may attest to the owner's death.
     * @dev Can only happen while the vault is Green (owner is demonstrably live).
     */
    function addGuardian(address guardian) external onlyOwner onlyGreen {
        if (guardian == address(0) || guardian == owner) {
            revert InvalidGuardian();
        }
        if (isGuardian[guardian]) {
            revert GuardianAlreadyRegistered();
        }

        isGuardian[guardian] = true;
        guardians.push(guardian);

        emit GuardianAdded(guardian);
    }

    /**
     * @notice Removes a guardian from the attestation set.
     * @dev Can only happen while the vault is Green. If the removed guardian had
     *      an outstanding attestation it is withdrawn; removing the final
     *      dissenting guardian can therefore complete a unanimous attestation.
     */
    function removeGuardian(address guardian) external onlyOwner onlyGreen {
        if (!isGuardian[guardian]) {
            revert GuardianNotRegistered();
        }

        isGuardian[guardian] = false;

        if (hasAttestedDeath[guardian]) {
            hasAttestedDeath[guardian] = false;
            deathAttestationCount--;
        }

        // Remove from enumerable array using swap-and-pop.
        uint256 length = guardians.length;
        for (uint256 i = 0; i < length; i++) {
            if (guardians[i] == guardian) {
                guardians[i] = guardians[length - 1];
                guardians.pop();
                break;
            }
        }

        emit GuardianRemoved(guardian);

        _maybeConfirmDeath();
    }

    /**
     * @notice Called by a guardian to attest that the owner has died.
     * @dev When every current guardian has attested, death is confirmed and
     *      all timelocks collapse to 1% of nominal. Callable in any status.
     */
    function attestDeath() external {
        if (!isGuardian[msg.sender]) {
            revert NotGuardian();
        }
        if (hasAttestedDeath[msg.sender]) {
            revert AlreadyAttestedDeath();
        }

        hasAttestedDeath[msg.sender] = true;
        deathAttestationCount++;

        emit DeathAttested(msg.sender, deathAttestationCount, guardians.length);

        _maybeConfirmDeath();
    }

    /**
     * @notice Withdraws a guardian's own death attestation.
     * @dev Only possible before death is confirmed; afterwards the owner must
     *      check in (a verified liveness proof) to reset the vault.
     */
    function revokeAttestation() external {
        if (!isGuardian[msg.sender]) {
            revert NotGuardian();
        }
        if (deathConfirmed) {
            revert DeathAlreadyConfirmed();
        }
        if (!hasAttestedDeath[msg.sender]) {
            revert NotAttestedDeath();
        }

        hasAttestedDeath[msg.sender] = false;
        deathAttestationCount--;

        emit DeathAttestationRevoked(msg.sender, deathAttestationCount, guardians.length);
    }

    /**
     * @notice Returns all currently registered guardians.
     */
    function getGuardians() external view returns (address[] memory) {
        return guardians;
    }

    /**
     * @notice Returns the number of currently registered guardians.
     */
    function getGuardianCount() external view returns (uint256) {
        return guardians.length;
    }

    /**
     * @dev Confirms death once every current guardian has attested. No-op if
     *      already confirmed or if there are no guardians (a vault with no
     *      guardians can never be accelerated).
     */
    function _maybeConfirmDeath() internal {
        if (!deathConfirmed && guardians.length > 0 && deathAttestationCount >= guardians.length) {
            deathConfirmed = true;
            deathConfirmedAt = block.timestamp;
            emit DeathConfirmed(block.timestamp);
        }
    }

    /**
     * @dev Clears all attestation state and lifts any acceleration.
     */
    function _resetDeathAttestations() internal {
        if (deathAttestationCount == 0 && !deathConfirmed) {
            return;
        }

        uint256 length = guardians.length;
        for (uint256 i = 0; i < length; i++) {
            hasAttestedDeath[guardians[i]] = false;
        }

        deathAttestationCount = 0;
        deathConfirmed = false;
        deathConfirmedAt = 0;

        emit DeathAttestationsReset();
    }

    // -------------------------------------------------------------------------
    // Asset Allocation
    // -------------------------------------------------------------------------

    /**
     * @notice Assigns an asset to an authorized heir via a designated executor.
     * @dev Can only happen while the vault is Green.
     */
    function assignAsset(bytes32 assetId, address heir, IVaultExecutor executor) external onlyOwner onlyGreen {
        if (assetId == bytes32(0)) revert InvalidAssetId();
        if (!isHeir[heir]) revert HeirNotRegistered();
        if (address(executor) == address(0)) revert InvalidExecutor();

        Allocation storage alloc = allocations[assetId];
        if (alloc.exists && !alloc.executed) revert AssetAlreadyAssigned();

        allocations[assetId] =
            Allocation({heir: heir, executor: executor, assetId: assetId, exists: true, executed: false});

        emit AssetAssigned(assetId, heir, address(executor));
    }

    /**
     * @notice Removes an asset assignment.
     * @dev Can only happen while the vault is Green.
     */
    function removeAsset(bytes32 assetId) external onlyOwner onlyGreen {
        Allocation storage alloc = allocations[assetId];
        if (!alloc.exists || alloc.executed) revert AssetNotAssigned();

        delete allocations[assetId];

        emit AssetRemoved(assetId);
    }

    // -------------------------------------------------------------------------
    // Claim lifecycle & Execution
    // -------------------------------------------------------------------------

    function initiateClaim() external {
        // Only registered heirs can initiate.
        if (!isHeir[msg.sender]) {
            revert HeirNotRegistered();
        }

        if (getStatus() != Status.Red) {
            revert VaultNotRed();
        }

        ClaimStatus status = claimStatus[msg.sender];

        bool staleContestable = status == ClaimStatus.Contestable && lastCheckIn >= claimInitiatedAt[msg.sender];

        if (status != ClaimStatus.NotInitiated && !staleContestable) {
            revert ClaimAlreadyInitiated();
        }

        claimStatus[msg.sender] = ClaimStatus.Contestable;
        claimInitiatedAt[msg.sender] = block.timestamp;

        emit ClaimInitiated(msg.sender, block.timestamp);
    }

    function finalizeClaim() external {
        // Finalization is restricted to a currently authorized heir.
        if (!isHeir[msg.sender]) {
            revert HeirNotRegistered();
        }

        if (claimStatus[msg.sender] != ClaimStatus.Contestable) {
            revert ClaimNotContestable();
        }

        if (getStatus() != Status.Red) {
            revert VaultNotRed();
        }

        // Owner must not have checked in after this claim started.
        if (lastCheckIn >= claimInitiatedAt[msg.sender]) {
            revert ClaimNotContestable();
        }

        if (block.timestamp < claimInitiatedAt[msg.sender] + _effectiveDuration(contestableWindow)) {
            revert ContestableWindowNotElapsed();
        }

        claimStatus[msg.sender] = ClaimStatus.Claimed;

        emit ClaimFinalized(msg.sender, block.timestamp);
    }

    /**
     * @notice Executes control transfer for a specific allocated asset.
     * @dev Gated on heir claim finalization and CEI pattern.
     */
    function executeClaim(bytes32 assetId) external nonReentrant {
        Allocation storage alloc = allocations[assetId];

        if (!alloc.exists) revert AssetNotAssigned();
        if (alloc.executed) revert AssetAlreadyClaimed();
        if (alloc.heir != msg.sender) revert NotAssignedHeir();
        if (!isHeir[msg.sender]) revert HeirNotRegistered();
        if (claimStatus[msg.sender] != ClaimStatus.Claimed) revert ClaimNotFinalized();

        // Checks-Effects-Interactions (CEI): Mark executed before external call
        alloc.executed = true;

        emit AssetClaimed(assetId, msg.sender, block.timestamp);

        alloc.executor.transferControl(owner, msg.sender);
    }
}
