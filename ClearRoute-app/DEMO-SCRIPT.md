# ClearRoute demo video script

Target length: 4-5 minutes. Record the browser and a small face/voice window only
if desired. Use a clean public HTTPS deployment for the final recording; the local
URL is suitable for rehearsal only.

## Before recording

- Confirm the operator can sign in.
- Open `/funding` in a second browser profile.
- Have one volunteer's verified Devnet Party ID and compatible wallet ready.
- Run **Demo transfers → Check treasury wallet**.
- Confirm the wallet has enough CC for the 1 CC test plus fees.
- Keep the recipient wallet visible in a second window for acceptance.

## Spoken and on-screen sequence

**0:00 - The problem**

“Small Canton teams can be ready to transact but have no CC in the right wallet.
ClearRoute turns that blocked first transaction into a controlled funding path.”
Show the ClearRoute landing view and the dynamic DNA artwork. Explain that CC is
the fuel layer for Canton activity, while ClearRoute keeps the funding decision,
delivery evidence and billing record together.

**0:35 - Request**

Open the public funding page. Say: “The builder needs no ClearRoute account and
never shares a private key. They provide the full Canton Party ID, wallet provider,
amount and test purpose.” Submit a 1 CC request and save the private tracking link.

**1:20 - Review**

Switch to the operator. Open **Demo transfers** and show the request, party ID,
wallet provider, amount and purpose. Say: “Approval is a human decision with a
limit. It is not delivery.” Verify the recipient with the builder, tick the
verification box and approve.

**2:05 - Treasury and send**

Show the treasury check and observed balance. Say: “ClearRoute pins this adapter
to the verified Devnet wallet and synchronizer. The send action uses one stable
tracking ID, so a timeout cannot create a second payment.” Send the 1 CC offer.

**2:45 - Recipient consent**

Switch to the recipient wallet. Show the incoming offer, sender, amount and expiry.
The recipient verifies the details and accepts in their own wallet.

**3:20 - Evidence**

Return to ClearRoute. Reconcile if necessary and show **CC delivered**, the transfer
transaction reference, recipient party, timestamp and decision trail. Ask the
recipient to confirm the balance in their wallet. Explain that a balance change by
itself is not treated as proof.

**3:55 - Business value**

Show the operator overview and treasury planning. Say: “The same workspace can
track usage, invoices, collections, burned CC and reserve planning. The future
gas-station model can sponsor validator traffic from a segregated treasury without
requiring ClearRoute to inspect a customer's bank account.”

**4:25 - Close**

“ClearRoute gives Canton builders room for their next move: a clear request, a
bounded decision, a wallet-native transfer and evidence that survives reconciliation.”

## Recording rules

Never show passwords, access keys, refresh tokens, recovery phrases, private keys or
the full private tracking URL. Use Devnet amounts only for this recording. Label any
Mainnet/Grofty work as a separate future integration. Keep the final video focused
on a successful flow; mention the manual review and Devnet boundary explicitly.
