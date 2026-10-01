# ClearRoute application

React frontend and TypeScript/Express backend for LocalNet transaction sponsorship,
validator traffic purchases, customer metering and sandbox billing.

## Build and test

Requires Node.js 22.14 or later.

```sh
cd ClearRoute-app
npm ci --legacy-peer-deps
npm run verify
```

Verification typechecks the source and tests, runs isolated backend and frontend
tests, and builds both artifacts. Tests do not require Docker or Canton.

```sh
npm start
```

Open http://127.0.0.1:3001. For development, use `npm run dev`.

## LocalNet integration

This repository contains the application folder only. The Canton Docker stack,
custom Daml project/DAR, runtime identities and databases are not included.
The current connector targets the bundled Quickstart LocalNet ports and its
provider participant. `npm run localnet:setup` expects the separately built DAR
at `../daml/launchfuel/.daml/dist/launchfuel-0.1.0.dar`, relative to this folder,
and a running compatible LocalNet. It initializes scoped local identities in
`data/localnet.json`.

In **Gas station**, the operator approves a capacity allowance for Atlas or Nova.
A customer request buys a fresh traffic batch, verifies its receipt, executes the
supported five-step Daml workflow, and reconciles measured customer traffic.
Purchases spend LocalNet test CC. Limits are in traffic bytes, not CC price.

After component verification, `node scripts/verify-sponsorship.mjs --execute`
runs one explicitly bounded, real LocalNet acceptance test and saves evidence.
Other probe/verification scripts may also write test contracts or buy traffic;
they are not part of the isolated test suite.

The implemented connector supports the existing service workflow on the local
provider participant. Role headers, fixed customers and invoice tariffs are
development fixtures. Production authentication, arbitrary app/remote-validator
connectors and commercial settlement are not implemented.

Runtime databases, logs, generated builds, dependencies and integration evidence
are excluded from Git. Run only one application server per data directory.
