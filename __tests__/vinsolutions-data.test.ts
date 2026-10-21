import { describe, expect, it } from 'vitest';
import { toDatasets, vehicleOf, type CustomerRow } from '../lib/vinsolutions-data';

const row: CustomerRow = {
  globalCustomerId: 101,
  autoLeadId: 201,
  dealerId: 18711,
  fullName: 'Connor Walsh',
  email: 'connor@example.com',
  cellPhone: '(224) 629-9331',
  dayPhone: null,
  city: 'Chicago',
  state: 'IL',
  postalCode: '60607',
  dealerName: 'Roanoke Ford',
  salesRepDisplay: 'C Johnson',
  leadSourceName: 'Tv',
  leadStatusTypeName: 'New Quote Ford',
  createdLocal: '10/15/26',
  vehicleDisplay: '2026 Ford Maverick',
  vehicleYear: 2026,
  vehicleMake: 'Ford',
  vehicleModel: 'Maverick',
  vehicleStockNumber: null,
};

describe('VinSolutions datasets', () => {
  it('maps a customer row to the customer, lead and vehicle fields', () => {
    const d = toDatasets({ rows: [row], total: 1, dealers: ['Roanoke Ford'], details: {}, detailLimit: 5 });
    expect(d.customers[0]).toMatchObject({ full_name: 'Connor Walsh', email: 'connor@example.com', phone_mobile: '(224) 629-9331', vehicle_year: '2026', stock_number: null });
    expect(d.leads[0]).toEqual({ full_name: 'Connor Walsh', lead_source: 'Tv', lead_status: 'New Quote Ford', salesperson: 'C Johnson', dealer_name: 'Roanoke Ford', vehicle: '2026 Ford Maverick', created_date: '10/15/26' });
    expect(d.vehicles).toHaveLength(1);
    expect(d.dealership).toBe('Roanoke Ford');
    expect(d.total_in_list).toBe(1);
  });

  it('leaves out vehicles for rows without one', () => {
    expect(vehicleOf({ ...row, vehicleDisplay: null, vehicleStockNumber: null })).toBeNull();
  });

  it('builds appointments, tasks, trade vehicles and notes from the detail reads', () => {
    const d = toDatasets({
      rows: [row],
      total: 1,
      dealers: ['Roanoke Ford'],
      detailLimit: 5,
      details: {
        '101': {
          trade_in: '2019 Honda Civic',
          trade_detail: 'Mileage 60,000',
          trade_value: '$9,000',
          customer_note: 'Wants a truck',
          tasks: 'Call back Friday',
          appointments: [{ subject: 'Test drive', recipient: 'C Johnson', when: '4/17/21 8:30a Completed' }],
          notes: [{ date: '2026-10-14', sender: 'C Johnson', subject: 'Received from: 555', body: 'Hi' }],
        },
      },
    });
    expect(d.appointments).toEqual([{ full_name: 'Connor Walsh', subject: 'Test drive', when: '4/17/21 8:30a Completed', rep: 'C Johnson', status: null }]);
    expect(d.tasks).toEqual([{ full_name: 'Connor Walsh', task: 'Call back Friday', due: null, status: null }]);
    expect(d.trade_vehicles).toEqual([{ full_name: 'Connor Walsh', description: '2019 Honda Civic', detail: 'Mileage 60,000', value: '$9,000' }]);
    expect(d.customer_notes).toEqual([
      { full_name: 'Connor Walsh', date: null, author: null, note: 'Wants a truck' },
      { full_name: 'Connor Walsh', date: '2026-10-14', author: 'C Johnson', note: 'Received from: 555: Hi' },
    ]);
    expect(d.unavailable).toEqual([]);
  });

  it('says what was not read when detail reads are capped or failed', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...row, globalCustomerId: i + 1, fullName: `C${i}` }));
    const d = toDatasets({
      rows: many,
      total: 7,
      dealers: [],
      detailLimit: 2,
      details: { '1': { errors: ['notes: not JSON (12 characters)'] } },
    });
    expect(d.unavailable.some((u) => u.includes('first 2 of 7'))).toBe(true);
    expect(d.unavailable.some((u) => u.includes('notes: not JSON'))).toBe(true);
    expect(d.dealership).toBeNull();
  });
});
