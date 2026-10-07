import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import GasStation from '../../frontend/GasStation';

const policy = { tenant:'atlas', enabled:true, batchBytes:200000, capacityLimitBytes:400000, remainingCapacityBytes:400000, binding:{party:'atlas::party',validator:'provider::party',domain:'domain'} };
const state = { policies:[policy], requests:[], audit:[] };
test('customer sees its funding policy and cannot grant sponsorship', async()=>{
  vi.mocked(fetch).mockResolvedValue(Response.json(state));render(<GasStation session="atlas"/>);
  await screen.findByText('atlas::party');expect(screen.queryByRole('button',{name:'Save sponsorship policy'})).toBeNull();
  expect((screen.getByRole('button',{name:'Fund and run workflow'}) as HTMLButtonElement).disabled).toBe(false);
});
test('unapproved and exhausted customers cannot start a funded workflow',async()=>{
  vi.mocked(fetch).mockResolvedValue(Response.json({...state,policies:[{...policy,remainingCapacityBytes:0}]}));render(<GasStation session="atlas"/>);
  await screen.findByText('atlas::party');expect((screen.getByRole('button',{name:'Fund and run workflow'}) as HTMLButtonElement).disabled).toBe(true);
});
test('operator must explicitly authorize provider spending and saves bounded policy',async()=>{
  const user=userEvent.setup();vi.mocked(fetch).mockImplementation(async()=>Response.json({policies:[],requests:[],audit:[]}));render(<GasStation session="operator"/>);
  const consent=screen.getByRole('checkbox') as HTMLInputElement;expect(consent.checked).toBe(false);
  await user.click(consent);await user.click(screen.getByRole('button',{name:'Save sponsorship policy'}));
  const post=vi.mocked(fetch).mock.calls.find(([,o])=>o?.method==='POST')!;
  expect(post[0]).toBe('/api/sponsorship/policies/atlas');expect(JSON.parse(post[1]!.body as string)).toEqual({enabled:true,batchBytes:200000,capacityLimitBytes:200000});
});
test('uncertain sponsorship response survives remount and retries identical request',async()=>{
  const user=userEvent.setup();let count=0;
  vi.mocked(fetch).mockImplementation(async(_url,o)=>o?.method==='POST'?(++count===1?Response.json({error:{message:'Response unknown'}},{status:503}):Response.json({result:{id:'saved'}})):Response.json(state));
  const view=render(<GasStation session="atlas"/>);await screen.findByText('atlas::party');await user.click(screen.getByRole('button',{name:'Fund and run workflow'}));
  await screen.findByRole('alert');view.unmount();render(<GasStation session="atlas"/>);
  await user.click(screen.getByRole('button',{name:'Retry saved sponsorship request'}));
  await waitFor(()=>expect(count).toBe(2));const posts=vi.mocked(fetch).mock.calls.filter(([,o])=>o?.method==='POST');
  expect(posts[1][1]?.body).toBe(posts[0][1]?.body);expect(posts[1][1]?.headers).toEqual(posts[0][1]?.headers);
});
test('pending purchase is presented as waiting and prevents another submission',async()=>{
  vi.mocked(fetch).mockResolvedValue(Response.json({...state,requests:[{id:'sponsor-1',tenant:'atlas',status:'awaiting_funding',bytes:200000,error:'Waiting for receipt',purchase:null,run:null,measurement:null}]}));
  render(<GasStation session="atlas"/>);await screen.findByText('atlas · awaiting funding');
  expect(screen.getByRole('button',{name:'Check saved request'})).toBeTruthy();expect((screen.getByRole('button',{name:'Fund and run workflow'}) as HTMLButtonElement).disabled).toBe(true);
});
