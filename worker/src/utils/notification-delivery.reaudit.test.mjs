import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverNotification } from './notification-dispatch.ts';

for (const alreadySent of [false, true]) {
  for (const markerAccepted of [false, true]) {
    test(`R-D06 ${alreadySent ? 'stored' : 'new'} receipt advances state only when its completion token is accepted=${markerAccepted}`, async () => {
      const sequence = [];
      const result = await deliverNotification({
        claim: async () => ({ claimed: !alreadySent, delivered: alreadySent, token: 'synthetic-completion-token' }),
        send: async () => { sequence.push('send'); return true; },
        complete: async token => { sequence.push(`complete:${token}`); return true; },
        onDelivered: async token => { sequence.push(`marker:${token}`); return markerAccepted; },
      });
      assert.deepEqual(sequence, [
        ...(!alreadySent ? ['send', 'complete:synthetic-completion-token'] : []),
        'marker:synthetic-completion-token',
      ], 'Marker authority is checked after SQL confirmation, also on delivered retries without another send');
      assert.equal(result, markerAccepted, 'A retired receipt cannot look like current entity completion');
    });
  }
}

test('R-D06 failed or retired completion never invokes the state marker', async () => {
  let markers = 0;
  for (const sent of [false, true]) {
    assert.equal(await deliverNotification({
      claim: async () => ({ claimed: true, delivered: false, token: 'synthetic-retired-token' }),
      send: async () => sent,
      complete: async () => false,
      onDelivered: async () => { markers += 1; return true; },
    }), false);
  }
  assert.equal(markers, 0);
});
