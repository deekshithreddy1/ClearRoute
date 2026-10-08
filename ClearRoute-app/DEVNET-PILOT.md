# ClearRoute public Devnet funding pilot

## What this build does

Share `/funding`. A visitor submits a team, contact email, full Canton Devnet party,
wallet provider, purpose and an exact CC amount. No administrator-created customer
account is needed. They receive a private tracking link (a secret in the URL fragment).
Bookmark it: this pilot does not send email or provide email recovery. The database
stores a hash of the tracking secret. Email and party ownership are not automatically
verified; the operator must contact the tester before approving.

An authenticated operator opens **Demo transfers**, reviews the request, checks the
treasury, and sends a transfer offer. The recipient accepts it in their own compatible
Splice wallet. ClearRoute checks the original transfer every 20 seconds and shows the
wallet-confirmed outcome and transaction ID. The public receipt refreshes every 15
seconds. A wallet API result is the evidence source, not an independent ledger audit.

Limits: Devnet only, 10 CC per request, 100 CC aggregate approved/delivered exposure
(excluding fees), one outstanding or completed request per recipient. Rejected and
wallet-confirmed failed requests can be replaced. These bounds use exact decimals.
Intake is rate limited and capped at 2,000 records. No native credentials reach visitors.

This is a free hackathon pilot, separate from ClearRoute service contracts and invoices.
CC delivery does not automatically purchase validator traffic. No new DAR is needed.

## 1. Run locally first

In the ClearRoute-app PowerShell window that has your fresh NODERS access token, stop
the server with Ctrl+C. Keep your existing hosted authentication/network configuration.
Then run:

```powershell
if ([string]::IsNullOrWhiteSpace($env:CLEARROUTE_DEVNET_TOKEN)) {
  throw "Get a fresh NODERS token in this terminal first."
}
$env:CLEARROUTE_PUBLIC_FUNDING = "1"
$env:CLEARROUTE_NETWORK_MODE = "devnet"
$env:CLEARROUTE_DEVNET_TREASURY_PARTY = "6577027c-41cb-472b-9499-36e7b96fa641::12204a9d883d1158141d8f099d06dd2e42cb52615deb42da5a46f042c8d0e1dbdf0e"
$env:CLEARROUTE_DEVNET_WALLET_TOKEN = $env:CLEARROUTE_DEVNET_TOKEN
$env:CLEARROUTE_DEVNET_TRANSFERS = "ENABLED"
npm start
```

Open `http://127.0.0.1:3001/funding`. This is a local address, not the link to send
to another participant. Open the operator account in another tab at `/` and choose
**Demo transfers**. Click **Check treasury wallet**. This reads the wallet identity,
balance and exact pinned NODERS Devnet synchronizer; it makes no transfer.

The wallet identity is deliberately separate from the provider agreement identity.
Do not replace your provider or customer ledger party in networks.json.

## 2. First real test

1. Get a volunteer with a Devnet Splice wallet that accepts legacy wallet transfer
   offers. A Mainnet Grofty wallet or a preapproval-only wallet is not compatible with
   this demo connector. Preapproval alone is not used by this flow.
2. Have them submit 1 CC through `/funding` and save their private receipt link.
3. In **Demo transfers**, confirm their full party and wallet compatibility directly
   with them. Add a review note, check recipient verification, and approve.
4. Click **Send 1 CC offer**. Review the party and amount in the confirmation.
   Wallet fees are additional. The check requires one CC of headroom, not a fee quote.
5. The recipient finds the incoming ClearRoute offer in their own wallet and accepts.
6. Wait for **CC delivered** and a transfer transaction ID. Ask the recipient to
   confirm their wallet received the amount. Balance changes alone are not proof.
7. Keep the request reference and transaction ID as demo evidence. Clicking Send
   again cannot create a second offer for the same request.

Do not mark a transfer delivered because it is approved, created, or accepted.
An expired/rejected/withdrawn transfer becomes failed only after the wallet reports it.
Offers expire after 24 hours; passing the deadline alone does not prove failure.

## 3. Share a real HTTPS link

Use either a temporary HTTPS tunnel to your running computer or the existing
Docker/Caddy deployment in `deploy/`. Before exposing the app:

- Set `CLEARROUTE_PUBLIC_ORIGIN` to the exact public origin, for example
  `https://your-demo.example.com` (no trailing slash or `/funding`).
- Unset `CLEARROUTE_LOCAL_HTTP_TEST`, keep `CLEARROUTE_AUTH_MODE=required`, then
  restart. This enables secure session cookies and the exact allowed origin.
- Share **that origin + `/funding`**, never an operator access key or private receipt.
- Keep the backend data directory persistent, run one application instance, and
  keep your computer/server running for the demo.
- The UI's share link reflects the address you opened. Access the operator UI
  through the public HTTPS address when copying its link.

For cloud Docker deployment, add the funding variables to the private `deploy/app.env`
(see its example). Copy/backup the current data using the established deployment
procedure if you want existing accounts on the server; otherwise provision a new
operator inside the running container. Do not commit data, tokens, or private env files.

The app deliberately does not trust arbitrary forwarded client-IP headers. Behind a
proxy, rate limits may be shared by visitors; this conservative pilot limit is five
submissions per minute and 120 status/info reads per minute per observed connection IP.

## 4. Credentials, failures and stopping

The access token expires (your previous token lasted three hours). Renew it before the
demo, set `CLEARROUTE_DEVNET_WALLET_TOKEN` in the server's launching environment, and
restart. Changing another terminal's environment does not update the running server.
No passwords or refresh tokens are stored by this integration.

For a long-running deployment, NODERS must issue a refresh token or service-account
credential. Copy `config/oidc.example.json` to a private server secret, set its
`expectedSubject` and `audience` to the claims NODERS actually issues, and configure
`CLEARROUTE_OIDC_CONFIG_FILE`, `CLEARROUTE_TOKEN_STORE_KEY`, and the private refresh
token in the deployment secret store. The broker encrypts rotated refresh tokens in
`data/credentials/renewal.enc.json`; mount the data directory persistently and back it
up securely. Test renewal before enabling transfers. If NODERS does not grant this
flow, keep manual token rotation and leave sends disabled between rotations.

If a command is uncertain, use **Reconcile original transfer**. A 404, timeout or empty
history is not proof that no transfer happened. ClearRoute never automatically retries
the monetary POST. Investigate the persisted tracking ID with NODERS if necessary;
do not edit SQLite statuses to unlock spending. Reconciliation can continue with
`CLEARROUTE_DEVNET_TRANSFERS` unset; this switch stops new sends, not status reads.

Set `CLEARROUTE_PUBLIC_FUNDING=0` and restart to close the entire public pilot.
Back up `data/public-funding.sqlite` with the other SQLite databases using a consistent
backup procedure (or stop the app first and copy the data directory).

## Compatibility and validation boundary

This explicitly uses Splice's legacy transfer-offer API, deprecated in newer Splice
releases. It is a constrained Devnet demo adapter, not a general wallet integration.
NODERS must support `/api/validator/v0/wallet/transfer-offers` and its status endpoint.
The official API distinguishes created, accepted, completed and failed. Cross-provider
recipient support must be checked before approval. No Mainnet funding is exposed here.

References:
- https://docs.sync.global/app_dev/validator_api/index.html
- https://raw.githubusercontent.com/canton-network/splice/refs/heads/main/apps/wallet/src/main/openapi/wallet-external.yaml

Run `npm run verify` for isolated backend/frontend tests and production compilation.
Live wallet compatibility, recipient acceptance, public HTTPS reachability, and the
first real transfer are separate acceptance checks. Passing offline tests does not
establish those results or long-running production readiness.
