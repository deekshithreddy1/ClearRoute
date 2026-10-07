# ClearRoute application

**Current entry point:** [DEPLOYMENT.md](DEPLOYMENT.md) explains the two
repositories, local startup and cloud deployment. Source is now explicitly
separated into **frontend/** and **backend/**. All active names, environment
variables and Daml modules use ClearRoute. The legacy prototype notes below
are historical and are not the hosted deployment procedure.

The authenticated workspace now uses hosted **Devnet / Testnet / Mainnet**
operations, customer funding requests, service-contract commands and treasury
planning. Start with [HOSTED-NETWORKS.md](HOSTED-NETWORKS.md) and
[config/networks.example.json](config/networks.example.json).
Hosted native CC funding remains disabled pending NODERS connector verification;
this is not yet a production release. The sections below describe the retained
offline/LocalNet prototype and do not configure hosted networks.

React frontend and TypeScript/Express backend for LocalNet transaction sponsorship,
validator traffic purchases, customer metering and sandbox billing.

Native LocalNet CC transfers are available in **Wallet funding**, separately from
the simulated **CC Top-up** screen. See [FUNDING-MVP.md](FUNDING-MVP.md) for the
wallet model, customer setup, transfer acceptance check and commercial boundaries.
The adapter supports the configured Atlas/Nova parties on the bundled LocalNet;
it does not yet support arbitrary customer parties or MainNet.

For ledger setup from a nested checkout, set `CLEARROUTE_DAR_PATH` to the existing
DAR and `CLEARROUTE_LOCALNET_CONFIG` to the desired identity file. Setup requires
`CLEARROUTE_NETWORK_MODE=localnet` and writes identities to that configured file.

## Build and test

Requires Node.js 22.14 or later.

```sh
cd ClearRoute-app
npm ci --legacy-peer-deps
npm run verify
```

Verification typechecks the source and tests, runs isolated backend and frontend
tests, and builds both artifacts. Tests do not require Docker or Canton.

## Sprint 1: authenticated offline startup

Startup defaults to `CLEARROUTE_AUTH_MODE=required` and
`CLEARROUTE_NETWORK_MODE=offline`. Offline startup creates no Canton connectors
or polling workers. Network workspaces return an unavailable response; the banner
identifies offline mode. Fixture account/usage screens remain simulated.

From this repository's `ClearRoute-app` directory, after a successful build:

```powershell
$env:CLEARROUTE_AUTH_MODE = 'required'
$env:CLEARROUTE_NETWORK_MODE = 'offline'
$env:CLEARROUTE_DATA_DIR = 'data/sprint-01'
$env:PORT = '3002'
npm run auth:admin -- create --id operator-admin --name 'ClearRoute Operator' --role operator
npm run auth:admin -- issue --id operator-admin --days 30
npm run auth:admin -- create --id atlas-owner --name 'Atlas Owner' --role customer --tenant atlas
npm run auth:admin -- issue --id atlas-owner --days 30
npm start
```

Open http://127.0.0.1:3002 yourself. Each `issue` command displays an access key
once. Keep it private and enter it in the sign-in screen; do not paste keys into
issues, chat, or commits. Use the same data directory for provisioning and startup.
The separate port/data directory avoids replacing a previously running demo.
For Vite development use the default API port 3001 (`Remove-Item Env:PORT` then
`npm run dev`), with no other server already using that port.

Accounts have immutable roles and customer bindings. Browser sessions use an
HttpOnly, SameSite=Strict cookie and expire after eight hours or sooner when the
key expires. Keys expire in 1?90 days (30 by default); storage contains hashes,
not recoverable credentials. API clients send `Authorization: Bearer <access-key>`.
`x-demo-session` cannot select or elevate identity in required mode. Allowed
Origin checks protect browser mutations. Login is limited to ten attempts per
minute per IP in this single-process test release.

```powershell
npm run auth:admin -- list
npm run auth:admin -- revoke --id <credential-id>
npm run auth:admin -- disable --id <account-id>
```

Revoking a key invalidates its sessions; disabling an account invalidates all its
keys and sessions. Issue another key to rotate credentials, then revoke the old
credential ID. Pending operation IDs are preserved separately for each account.
Local administrators who can access the database or provisioning command are trusted.

The Settings workspace now contains application-party and validator onboarding.
A customer registers its party and participant; an operator registers and
approves a validator participant/domain, approves the application, then binds
the validator. The API rejects cross-tenant registrations, unapproved bindings
and malformed identities. Application and validator parties are independent
identities; their prefixes do not need to match. These records are durable in `data/onboarding.sqlite`
and audited. Sprint 2 records are a control plane for the next execution stage;
the current live connector continues to use its existing configured identities.

To use the legacy role-switching fixture explicitly, set
`CLEARROUTE_AUTH_MODE=demo`. Never use this mode as an authentication mechanism.
The server binds only to loopback. This sprint does not provide public hosting,
TLS termination, SSO/MFA, distributed rate limiting or production identity operations.

See [SPRINTS.md](SPRINTS.md) for sprint boundaries and acceptance criteria.

## Hackathon acceptance path

After Docker LocalNet is healthy and `data/localnet.json` has been created by
the existing setup, run the authenticated server against that identity file:

```powershell
$env:CLEARROUTE_AUTH_MODE = 'required'
$env:CLEARROUTE_NETWORK_MODE = 'localnet'
$env:CLEARROUTE_LOCALNET_CONFIG = 'C:\path\to\quickstart\ClearRoute-app\data\localnet.json'
$env:CLEARROUTE_DATA_DIR = 'data/hackathon'
$env:PORT = '3002'
npm start
```

Open `http://127.0.0.1:3002`, sign in as the operator, and open **Hackathon
demo**. The operator approval button uses the provider wallet's current minimum
traffic amount. Sign in as Atlas in a second browser profile and run the
application transaction. ClearRoute then buys real LocalNet validator traffic,
executes the five-step Daml workflow, and waits for matching ledger evidence.

For a repeatable terminal acceptance check after provisioning operator and Atlas
keys in the same `CLEARROUTE_DATA_DIR`, set the two key variables and run:

```powershell
$env:CLEARROUTE_BASE_URL = 'http://127.0.0.1:3002'
$env:CLEARROUTE_OPERATOR_KEY = 'crk_...'
$env:CLEARROUTE_CUSTOMER_KEY = 'crk_...'
npm run hackathon:e2e
```

This creates one real LocalNet traffic purchase and one real Atlas ledger
workflow. It is the hackathon integration test and should only be run after the
component gate has passed and the Docker network is intentionally available.

## LocalNet integration

This repository contains the application folder only. The Canton Docker stack,
custom Daml project/DAR, runtime identities and databases are not included.
The current connector targets the bundled Quickstart LocalNet ports and its
provider participant. `npm run localnet:setup` expects the separately built DAR
at `../daml/clearroute/.daml/dist/clearroute-0.1.0.dar`, relative to this folder,
and a running compatible LocalNet. It initializes scoped local identities in
`data/localnet.json`.

LocalNet is a later, separately authorized integration stage. Only for that stage,
set `CLEARROUTE_NETWORK_MODE=localnet` with matching runtime configuration. Do not
run setup or integration scripts as part of the offline build/test gate.

In **Gas station**, the operator approves a capacity allowance for Atlas or Nova.
A customer request buys a fresh traffic batch, verifies its receipt, executes the
supported five-step Daml workflow, and reconciles measured customer traffic.
Purchases spend LocalNet test CC. Limits are in traffic bytes, not CC price.

After component verification and integration authorization, the legacy demo-mode
script `node scripts/verify-sponsorship.mjs --execute`
runs one explicitly bounded, real LocalNet acceptance test and saves evidence.
Other probe/verification scripts may also write test contracts or buy traffic;
they are not part of the isolated test suite.

The implemented connector supports the existing service workflow on the local
provider participant. Fixed customers and invoice tariffs remain development fixtures. Access-key
authentication is implemented for local testing; production identity operations,
arbitrary app/remote-validator connectors and commercial settlement remain future work.

Runtime databases, logs, generated builds, dependencies and integration evidence
are excluded from Git. Run only one application server per data directory.
