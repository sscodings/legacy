# Legacy

**A non-custodial digital vault for passing on crypto assets after death.**

A bank vault, not a dashboard.

Legacy lets a crypto holder lock assets in an on-chain vault that only unlocks for their named heirs — and only after the owner has stopped proving they're alive. There's no custodian, no lawyer, and no trust required between owner and heir: liveness, death, and inheritance are all enforced by the smart contract itself.

🔗 Live app: [legacy-drab-two.vercel.app](https://legacy-drab-two.vercel.app)

---

## How it works

Every vault moves through three states based on the owner's check-ins:

| State | Meaning |
| :--- | :--- |
| 🟢 **Green** | Owner has checked in recently. Vault is locked. Only the owner can act. |
| 🟡 **Amber** | Check-in interval lapsed. Grace period before heirs can act. |
| 🔴 **Red** | Grace period expired. Heirs may initiate a claim. |

**Owner flow**
1. Deploy a vault, add heirs, and assign specific assets to each.
2. Check in periodically (verified with World ID) to keep the vault Green.
3. If a claim is ever wrongly initiated, check in during the contestable window to invalidate it.

**Heir flow**
1. Once the vault reaches Red, initiate a claim.
2. Wait out the contestable window — the owner can still cancel it by proving they're alive.
3. If the window closes without contest, finalize and execute the claim to receive the allocated assets.

**Guardians (death acceleration)**
Owners can optionally name guardians who can jointly attest to the owner's death. Unanimous guardian attestation collapses all timelocks to 1% of their normal duration, letting heirs claim quickly in confirmed-death cases instead of waiting out the full check-in cycle.

---

## Architecture

This is a monorepo with two independently deployable parts:

```
legacy/
├── legacy-contract/   # Solidity smart contracts (Foundry)
└── legacy-frontend/   # Next.js web app
```

### `legacy-contract/`
- **Solidity + Foundry** (Forge, Cast, Anvil, Chisel)
- `LegacyVault.sol` — the per-owner vault: liveness state machine, heir/guardian registries, asset allocation, and the claim/contest/finalize lifecycle
- `LegacyVaultFactory.sol` — deploys new vault instances
- `adapters/`, `interfaces/`, `libraries/` — supporting contract modules (including a World ID verifier adapter)
- Pinned to `solc 0.8.36` with OpenZeppelin vendored as a git submodule for reproducible, verifiable deployments

### `legacy-frontend/`
- **Next.js 16** + React 19 + TypeScript
- **Wallets & chain access:** `wagmi`, `viem`, Reown AppKit, WalletConnect, MetaMask connector
- **Identity:** World ID (`@worldcoin/idkit`) for sybil-resistant liveness check-ins
- **Payments:** `x402` (HTTP 402 micropayment protocol, EVM + SVM)
- **Data:** MongoDB/Mongoose for off-chain state (e.g. notifications), Vercel Blob for file storage, Nodemailer for check-in/claim email alerts

---

## Getting started

### Prerequisites
- Node.js 18+ / Bun
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- A wallet (MetaMask, WalletConnect-compatible) and testnet funds
- World ID app credentials
- MongoDB connection string (for the frontend's off-chain features)

### Contracts
```bash
cd legacy-contract
cp .env.example .env   # fill in RPC URL, deployer key, etc.
forge install
forge build
forge test
```

Deploy with the scripts in `script/`, then record the deployed vault/factory addresses in `deployments/`.

### Frontend
```bash
cd legacy-frontend
cp .env.example .env   # contract addresses, World ID app ID, Mongo URI, etc.
bun install             # or npm/yarn/pnpm install
bun run dev
```

Open [http://localhost:3000](http://localhost:3000). The dev server hot-reloads as you edit.

---

## Design philosophy

The UI deliberately avoids typical SaaS/dashboard conventions. Every action — a check-in, a claim finalization — is treated as a deliberate, weighty moment rather than a casual form submission, in keeping with what the vault actually represents.

---

## Disclaimer

Legacy is experimental software handling real, irreversible transfers of digital assets. It has not been audited. Do not use it to secure funds you cannot afford to lose.
