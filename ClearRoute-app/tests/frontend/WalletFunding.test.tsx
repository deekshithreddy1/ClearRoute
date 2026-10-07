import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test, expect, vi } from 'vitest';
import WalletFunding from '../../frontend/WalletFunding';

const transfer={id:'native-id',tenant:'atlas',amountCc:'1.00',receiver:'atlas::party',status:'awaiting_acceptance',consentAt:null,error:null,receipt:null};
const state={wallets:[{tenant:'atlas',party:'atlas::party',balanceCc:'0',error:null}],transfers:[]};
test('customer sees own wallet and explicitly accepts; no treasury spending controls',async()=>{
  const user=userEvent.setup();vi.mocked(fetch).mockImplementation(async()=>Response.json({...state,transfers:[transfer]}));render(<WalletFunding session="atlas"/>);
  await screen.findByRole('button',{name:'Accept 1.00 test CC'});expect(screen.queryByRole('button',{name:'Offer test CC'})).toBeNull();expect(screen.getByText('Delivery not yet verified.')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Accept 1.00 test CC'}));
  expect(vi.mocked(fetch).mock.calls.find(([,o])=>o?.method==='POST')?.[0]).toBe('/api/wallet-funding/native-id/accept');
});
test('operator offers exact decimal strings and preserves unknown request across remount',async()=>{
  const user=userEvent.setup();vi.mocked(fetch).mockImplementation(async(_url,o)=>o?.method==='POST'?Response.json({error:{message:'Unknown response'}},{status:503}):Response.json(state));
  const view=render(<WalletFunding session="operator"/>);await screen.findByText('atlas::party');const input=screen.getByLabelText('Amount in test CC');await user.clear(input);await user.type(input,'1.0000000001');await user.click(screen.getByRole('button',{name:'Transfer test CC'}));await screen.findByText('Unknown response');view.unmount();
  render(<WalletFunding session="operator"/>);await screen.findByText('atlas::party');await user.click(screen.getByRole('button',{name:'Retry saved transfer'}));
  const posts=vi.mocked(fetch).mock.calls.filter(([,o])=>o?.method==='POST');expect(posts[0][1]?.body).toBe(JSON.stringify({tenantId:'atlas',amountCc:'1.0000000001',recipientPartyId:'atlas::party'}));expect(posts[1][1]?.body).toBe(posts[0][1]?.body);expect(posts[1][1]?.headers).toEqual(posts[0][1]?.headers);
});
test('unresolved transfers block new offers and verified receipt is required for delivery label',async()=>{
  vi.mocked(fetch).mockResolvedValue(Response.json({...state,transfers:[{...transfer,status:'verifying'}]}));render(<WalletFunding session="operator"/>);await screen.findByText('Delivery not yet verified.');expect((screen.getByRole('button',{name:'Transfer test CC'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByText('Verified coin delivery')).toBeNull();
});
