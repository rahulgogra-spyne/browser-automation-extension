import { describe, expect, it } from 'vitest';
import { hasValue, usefulRows } from '../lib/tekion-run';

describe('Tekion records', () => {
  it('counts only real values as data', () => {
    expect(hasValue(null)).toBe(false);
    expect(hasValue('')).toBe(false);
    expect(hasValue([])).toBe(false);
    expect(hasValue({})).toBe(false);
    expect(hasValue(0)).toBe(true);
    expect(hasValue(false)).toBe(true);
    expect(hasValue('RO-1')).toBe(true);
  });

  it('keeps only populated fields and drops rows with nothing in them', () => {
    const rows = [
      { id: 'a', roNo: '1001', assetNo: null, serviceId: null, status: 'OPEN' },
      { id: 'b', roNo: null, assetNo: null, serviceId: null, status: null },
      { id: null, roNo: null, assetNo: null, serviceId: null, status: null },
    ];
    expect(usefulRows(rows)).toEqual([
      { id: 'a', roNo: '1001', status: 'OPEN' },
      { id: 'b', roNo: null, status: null },
    ]);
  });

  it('returns nothing when every row is empty', () => {
    expect(usefulRows([{ id: null, roNo: null }, { id: null, roNo: null }])).toEqual([]);
  });
});

import { noteRows, technicianRows, tradeRows } from '../lib/tekion-run';

describe('Tekion lead reshaping', () => {
  it('turns a lead\'s owned vehicles into trade-ins', () => {
    const rows = tradeRows([
      { leadId: 'L1', ownedVehicles: [{ make: 'Ford', model: 'F-150', odometer: 80000, tradeIn: true, tradeAllowance: 9000, ownedVehicleId: 'O1' }] },
      { leadId: 'L2', ownedVehicles: [] },
    ]);
    expect(rows).toEqual([{ leadId: 'L1', ownedVehicleId: 'O1', make: 'Ford', model: 'F-150', odometer: 80000, tradeIn: true, tradeAllowance: 9000, price: null, certified: null }]);
  });

  it('turns the bulk notes into one row per note', () => {
    const rows = noteRows({ L1: { noteList: [{ title: 'Call', text: 'Left a message', userName: 'Ana', createdTime: 1_781_000_000_000, assetType: 'LEAD' }] } });
    expect(rows).toEqual([{ leadId: 'L1', title: 'Call', text: 'Left a message', userName: 'Ana', createdTime: new Date(1_781_000_000_000).toISOString(), assetType: 'LEAD' }]);
    expect(noteRows(null)).toEqual([]);
  });

  it('turns the service team into one row per technician', () => {
    const rows = technicianRows([{ name: 'Service', teamId: 'T1', dispatchType: 'AUTO', memberIds: ['u1', 'u2'] }]);
    expect(rows).toEqual([
      { team: 'Service', teamId: 'T1', technicianId: 'u1', dispatchType: 'AUTO' },
      { team: 'Service', teamId: 'T1', technicianId: 'u2', dispatchType: 'AUTO' },
    ]);
  });
});
