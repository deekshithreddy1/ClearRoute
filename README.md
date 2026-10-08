# ClearRoute

The application lives in **ClearRoute-app/**. Run all npm and deployment
commands there.

| Path | Purpose | Deployed where |
| --- | --- | --- |
| ClearRoute-app/frontend/ | React customer and administrator UI | Built into dist/, served by backend |
| ClearRoute-app/backend/ | Node API, authentication, ledger adapters, SQLite | App server |
| ClearRoute-app/tests/frontend/ | Browser component tests | Verification only |
| ClearRoute-app/config/ | Network profile example | Private server configuration |
| ClearRoute-app/deploy/ | Docker Compose, HTTPS proxy, environment example | One cloud VM |
| ClearRoute-app/data/ | Private database files, ignored by Git | Persistent server volume |

Contracts live in the separate
[ClearRoute-DAML repository](https://github.com/deekshithreddy1/ClearRoute-DAML).
Upload its tested release DAR to NODERS; do not deploy the Daml compiler or the
Quickstart containers to the application server.

Start with [DEPLOYMENT.md](ClearRoute-app/DEPLOYMENT.md).
The older Quickstart workspace is not the deployment source.

Branch flow: sprint branch → dev → main. main is the published, verified
deployment candidate; hosted funding capability still requires the documented
Devnet acceptance.

## Why this project matters

ClearRoute is the funding and billing layer for small Canton teams. A builder
needs only a full Canton Party ID and a compatible validator/wallet to request a
small CC allocation. The operator verifies the recipient, approves a bounded
amount, sends a wallet offer, and records the wallet-confirmed result. This
removes the first-transaction barrier without asking ClearRoute to hold a
customer bank balance or inspect institutional banking activity.

The future gas-station model can sponsor validator traffic from a segregated
treasury and bill usage later. It still requires explicit consent, limits,
audit evidence, custody controls and jurisdiction-specific legal review. This
repository does not claim KYC/AML coverage, licensing or regulated-custody
approval.

See [the application README](ClearRoute-app/README.md), [the Devnet pilot guide](ClearRoute-app/DEVNET-PILOT.md), and [the Daml repository](https://github.com/deekshithreddy1/ClearRoute-DAML).
