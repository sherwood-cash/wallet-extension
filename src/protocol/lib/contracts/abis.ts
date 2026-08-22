// Human-readable ABIs (ethers v5) for the pieces the frontend touches. These are
// hand-transcribed from robinhood-mixer/artifacts:
//   - contracts/PrivacyVault.sol/PrivacyVault.json
//   - contracts/dex/SwapLogic.sol/SwapLogic.json
// Field order matches the Solidity structs exactly so ethers encodes them right.

// Proof + ExtData tuples (identical to PrivacyVault.Proof / PrivacyVault.ExtData).
const PROOF_TUPLE =
  'tuple(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes32 root, bytes32[2] inputNullifiers, bytes32[2] outputCommitments, uint256 publicAmount, bytes32 extDataHash)'

const EXTDATA_TUPLE =
  'tuple(address recipient, int256 extAmount, address feeRecipient, uint256 fee, bytes encryptedOutput1, bytes encryptedOutput2, bytes32 swapParamsHash)'

// PrivacyVault.SwapParams. `version` is ISwapLogic.Version (uint8: 0=V2,1=V3,2=V4).
// Exported because the swap flow must hash this tuple into extData.swapParamsHash
// BEFORE proving — the encoding here has to stay byte-identical to the Solidity struct.
export const SWAP_PARAMS_TUPLE =
  'tuple(uint256 assetIn, address tokenOut, uint8 version, bytes routeData, uint256 minOut, uint256 deadline, bytes32 outPubkey, bytes32 outBlinding, uint256 relayerFeeOut, bytes encryptedOutput)'

// PrivacyVault — the single, immutable multi-asset mixer + private DEX vault.
export const VAULT_ABI = [
  // ---- deposit / withdraw / internal transfer (transact) ----
  // payable: native-ETH deposits ride as msg.value; ERC-20 deposits call with value 0.
  // `inEpoch` is the epoch of the tree the SPENT notes live in. Output notes always land
  // in the asset's LIVE epoch, which is why a spend can cross an epoch boundary.
  // extAmount == 0 is a valid internal transfer (consolidation / epoch migration).
  `function transact(uint256 assetId, uint32 inEpoch, ${PROOF_TUPLE} _args, ${EXTDATA_TUPLE} _extData) payable`,

  // ---- swap (spend an input note, mint the measured output note) ----
  `function executeSwap(uint32 inEpoch, ${PROOF_TUPLE} _args, ${EXTDATA_TUPLE} _extData, ${SWAP_PARAMS_TUPLE} p) returns (uint256 amountOut)`,

  // ---- registration / config (admin) ----
  'function registerToken(address token) returns (uint256 assetId)',
  'function assetIdOf(address token) view returns (uint256)',
  'function assetRegistered(uint256 assetId) view returns (bool)',
  'function assetToken(uint256 assetId) view returns (address)',
  'function canonicalRouter(uint8 version) view returns (address)',
  'function isRouterAllowed(uint8 version, address router) view returns (bool)',

  // ---- swap allowlist ----
  // Swapping is closed by default: base assets (ETH/USDG) are always swappable, any
  // other token needs an admin entry. `permissionlessSwaps` reopens everything.
  'function isSwappable(address token) view returns (bool)',
  'function swapAllowed(address token) view returns (bool)',
  'function permissionlessSwaps() view returns (bool)',

  // ---- epochs ----
  // Each (assetId, epoch) pair owns its own tree, addressed by treeIdOf(). A tree that
  // fills rotates automatically. The index in NewCommitment is GLOBAL:
  //   epoch = index / capacity()   localIndex = index % capacity()
  // Only localIndex may be fed to the circuit (merkleProof does Num2Bits(levels)).
  'function currentEpoch(uint256 assetId) view returns (uint32)',
  'function treeIdOf(uint256 assetId, uint32 epoch) view returns (uint256)',
  'function liveTreeId(uint256 assetId) view returns (uint256)',
  'function capacity() view returns (uint256)',
  'function levels() view returns (uint32)',

  // ---- tree / nullifier reads (tree reads are keyed by treeId, not assetId) ----
  'function NATIVE_ASSET_ID() view returns (uint256)',
  'function isSpent(bytes32 nullifier) view returns (bool)',
  'function isKnownRoot(uint256 treeId, bytes32 root) view returns (bool)',
  'function getLastRoot(uint256 treeId) view returns (bytes32)',
  'function nextIndex(uint256 treeId) view returns (uint32)',
  'function isTreeInitialized(uint256 treeId) view returns (bool)',
  'function isTreeFull(uint256 treeId) view returns (bool)',
  'function poseidon4(bytes32 a, bytes32 b, bytes32 c, bytes32 d) view returns (bytes32)',

  // ---- events ----
  'event NewCommitment(uint256 indexed assetId, bytes32 commitment, uint256 index, bytes encryptedOutput)',
  'event NewNullifier(bytes32 nullifier)',
  'event TokenRegistered(uint256 indexed assetId, address indexed token)',
  'event Swap(uint256 indexed assetIn, uint256 indexed assetOut, uint256 amountIn, uint256 amountOut, bytes32 commitment)',
  'event EpochRotated(uint256 indexed assetId, uint32 epoch, uint256 treeId)',
  'event SwapAllowedSet(address indexed token, bool allowed)',
  'event PermissionlessSwapsSet(bool enabled)',
]

// SwapLogic — read-only route builder (the front never calls it directly; the
// vault staticcalls buildRoute). Exposed here only for optional off-chain quoting.
export const SWAPLOGIC_ABI = ['function logicVersion() view returns (uint256)']

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
  'function version() view returns (string)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
]
