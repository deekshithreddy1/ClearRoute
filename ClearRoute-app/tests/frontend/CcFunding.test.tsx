import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test, expect, vi } from 'vitest';
import { CcFunding } from '../../frontend/CcFunding';
import { operationsState } from './operations-fixture';

test('customer saves recipient with exact CC amount and stable request identifier', async () => {
 const send = vi.fn().mockResolvedValue(true);
 render(<CcFunding state={operationsState} operator={false} busy={false} send={send}/>);
 await userEvent.type(screen.getByLabelText('Company name'), 'Startup');
 await userEvent.type(screen.getByLabelText('Contact email'), 'test@example.com');
 await userEvent.type(screen.getByLabelText('Validator provider / hosting details'), 'NODERS');
 await userEvent.type(screen.getByLabelText('Party ownership evidence reference'), 'ticket-1');
 await userEvent.type(screen.getByLabelText('Notes for the team (optional)'), 'Devnet app testing');
 await userEvent.click(screen.getByRole('button', {name:'Request CC'}));
 expect(send).toHaveBeenCalledWith('requests', expect.objectContaining({mode:'DirectTopUp', amount:'1', recipient:expect.objectContaining({partyId:'atlas::test-party', company:'Startup'})}));
 expect(screen.getByText('Treasury wallet connection pending')).toBeTruthy();
});
test('approval never appears as delivered and operator cannot send before wallet connection', () => {
 render(<CcFunding state={{...operationsState, requests:[{id:'request', tenant:'atlas', mode:'DirectTopUp', amount:'2', reason:'Testing', status:'approved', createdAt:new Date().toISOString(), decision:null}]}} operator busy={false} send={vi.fn()}/>);
 expect(screen.getByText('Approved · awaiting wallet')).toBeTruthy();
 expect(screen.getByRole<HTMLButtonElement>('button', {name:'Connect treasury to enable transfers'}).disabled).toBe(true);
 expect(screen.queryByRole('button', {name:'Request CC'})).toBeNull();
});
