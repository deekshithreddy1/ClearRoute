# ClearRoute funding MVP

## What the product does

ClearRoute has two different funding products:

| Product | Where the CC goes | What the customer receives |
| --- | --- | --- |
| Traffic sponsorship | Treasury CC is burned to purchase traffic for a validator participant | Application submission service under an allowance |
| Wallet funding | Treasury CC is transferred to the customer's Canton party | An actual CC holding, after recipient acceptance |

A funded party does not automatically have its own transaction gas balance. Global
Synchronizer traffic is accounted for at the participant/member level and shared
by the parties hosted there. The operator must have available traffic or buy it.
See [Synchronizer traffic fees](https://docs.sync.global/deployment/traffic.html).

## Wallets, parties and the DAR

A party is an on-ledger identity. Its coin holdings are native Canton Coin
contracts. A wallet provides authenticated access, displays those holdings and
coordinates transfers. A party ID is a destination, not a private key or login.
The participant-hosted LocalNet wallets here use validator-managed authorization;
they are not externally signed customer wallets.

The ClearRoute DAR defines service agreements, allowances, jobs, invoice records,
and receipt attestations. Its `TopUpReceipt` does not transfer CC and its
`FundingReceipt` does not buy traffic. Native CC contracts and network APIs must
execute the financial operation first; records are evidence only afterward.
No DAR rebuild is required for this wallet integration.

The configured `provider` service party is also different from the built-in
`app-provider` wallet treasury. Wallet funding shows the actual treasury party.
Never send funds to fixture party IDs displayed by the older Overview/Settings
screens. Confirm the network and native wallet party before using any destination.

## Implemented LocalNet flow

1. Existing local setup allocates the Atlas and Nova service parties.
2. `npm run wallet:setup` installs wallets for those same parties. It does not
   request a CC transfer. `CLEARROUTE_NETWORK_MODE=localnet` is required.
3. Operator opens **Wallet funding**, selects the customer and offers test CC.
4. Customer signs in, reviews the exact amount and recipient, then accepts.
5. Wallet automation completes delivery. ClearRoute verifies the transaction ID,
   synchronizer, native completion tracking ID, sender, receiver, delivered coin
   contract and its exact amount before reporting `completed`.

Only the configured Atlas and Nova wallets on the bundled provider participant
are supported. This does not yet fund arbitrary externally hosted parties.
The legacy **CC Top-up** screen and commercial invoices remain simulations.

The funding journal is `wallet-funding.sqlite` in the selected data directory.
Transfer IDs, original requests and expiries survive restart. Unknown results
remain unresolved; do not erase them or create replacement requests to bypass
reconciliation. Observing an offer disables automatic re-creation even if its
status later returns 404. A completed wallet status with missing ledger proof is
`verifying`, not delivered. Customer consent is persisted separately.

Test limits: 100 CC per offer, 1000 CC cumulative excluding confirmed failures,
one unresolved offer at a time, 30-minute offer expiry. Native amounts use ten
decimal places and integer arithmetic. Fees can still make execution fail;
the amount offered is not a promise of sufficient treasury balance.

This adapter uses the bundled Splice wallet transfer-offer compatibility API.
That API is deprecated. It is restricted to the existing loopback LocalNet and
must not be repurposed as a MainNet connector. A commercial adapter should use
the [Canton Token Standard integration](https://docs.sync.global/app_dev/validator_api/index.html),
including receiver authorization or a [transfer preapproval](https://docs.sync.global/background/preapprovals.html).

## Running from this nested application folder

```powershell
npm run verify
$env:CLEARROUTE_NETWORK_MODE = 'localnet'
$env:CLEARROUTE_LOCALNET_CONFIG = (Resolve-Path '../../data/localnet.json').Path
$env:CLEARROUTE_DATA_DIR = 'data/wallet-mvp'
npm run wallet:setup
```

Use the authentication provisioning commands in README.md with that same data
directory, build, and start the server on an unused port. Provision operator,
Atlas and Nova accounts separately. Do not put keys in source files or logs.
The config path above refers to the outer app's existing identities in this
workspace; standalone checkouts need an explicit path to their own setup file.

`npm run wallet:e2e -- --execute` is a separate integration check after the
component gate. It sends exactly one 1 CC test offer to Atlas, accepts as Atlas,
and checks delivery through authenticated application APIs. It uses a stable
request key, so rerunning against the same data directory reuses the transfer.
It writes evidence to that directory and does not use commercial funds.

`npm run gas:e2e -- --execute` separately buys one minimum traffic batch,
executes the five-step Atlas service workflow and verifies measured customer
traffic. It also uses a stable key in the selected data directory. Run these
checks with no application server using that directory. Both acceptance commands
are intentional ledger mutations and are excluded from component verification.

## How ClearRoute gets funded commercially

A validator, company or liquidity supplier can transfer CC to ClearRoute's
treasury party on the same network. ClearRoute must accept the incoming transfer
or maintain an appropriate preapproval. A balance should be recognized from
native holdings and transaction evidence, not by entering a number in the UI.
The current application can display the treasury balance; supplier deposits are
accepted in the provider wallet, and supplier accounting is not implemented here.

Choose a clear supplier arrangement: purchase CC for treasury inventory, accept
customer prepayments for services, or negotiate a separate financing agreement.
A validator's token balance creates no automatic obligation to supply ClearRoute,
no automatic liquidity pool and no guaranteed return. Token price risk, inventory
ownership, fees and settlement terms need explicit commercial agreements.

The current tokenomics documentation describes holding fees per coin contract
(UTXO), independent of the CC amount. Holding fees are not a percentage charge
on a large balance. Consequently, “validators must lend their enormous balances
to avoid holding costs” is not a sound business premise. See the current
[tokenomics explanation](https://docs.sync.global/background/tokenomics/overview_tokenomics.html).

## Recommended first paid pilot

Start with one cooperating validator and a few developer teams hosted on it.
Sell prepaid traffic sponsorship with clear limits, usage reporting and support.
Price the service from actual purchase costs plus an explicit service margin;
do not equate one customer's measured bytes with a specific amount of CC burned.
Keep supplier inventory, shared participant traffic and customer service credits
as separate accounts. Native CC top-ups can be offered as a separate service
once token delivery and customer payment reconciliation are joined safely.

Before charging customers, complete:

- Token Standard transfer integration and approved real-network configuration.
- Registration ownership checks and execution bound to approved party,
  participant, validator and synchronizer records; onboarding currently records
  approvals but the connector still uses the configured demo identities.
- Real customer payments, executable quotes, invoice settlement and supplier
  deposit accounting. The existing USD/USDC records are sandbox records.
- Treasury custody/signing controls, durable spending limits and reconciliation,
  backups, operational monitoring and production authentication/deployment.
- A supported application submission interface; the current sponsorship path
  executes only the supplied five-step service workflow.

Bank custody and holding customer deposits are separate products with additional
operational and commercial requirements. They are outside this developer MVP.

## Acceptance evidence

Component results and live integration results are reported separately in
SPRINTS.md. A successful transfer on LocalNet proves test coin delivery on that
network; it does not establish MainNet compatibility or commercial readiness.
