import { describe, expect, it } from 'vitest';
import { toDatasets, type LeadRow } from '../lib/dealr-data';

const lead: LeadRow = {
  id: 1,
  name: 'Sam Lee',
  source_name: 'Website',
  status: 'Active',
  category: 'Sales',
  assigned_user_name: 'Ana Ruiz',
  creation_time: 1_781_000_000,
  vehicles: [{ vehicle_string: '2022 Honda Accord', year: 2022, make: 'Honda', model: 'Accord', vin: 'VIN1', stock_no: 'S1' }],
};

describe('Dealr.cloud datasets', () => {
  it('maps a lead, its detail and the inventory', () => {
    const d = toDatasets({
      leads: [
        {
          lead,
          store: 'Brighton',
          detail: {
            name_first: 'Sam',
            name_last: 'Lee',
            company_name: null,
            emails: [{ email: 'sam@example.com' }],
            phones: [{ number: '555-0101' }],
            address: { street: '1 Main St', city: 'Brighton' },
            activities: [{ type: 'note', message: 'Called, left voicemail', timestamp: 1_781_000_500, user_name: 'Ana Ruiz' }],
            appointments: [{ type: 'Test drive', time: 1_781_100_000, status: 'Scheduled', salesperson: 'Ana Ruiz' }],
            tasks: [{ type: 'call', description: 'Follow up', reminder_time: 1_781_200_000, completed: false, priority: 'high' }],
            trades: [{ vehicle_string: '2015 Toyota Camry', year: 2015, make: 'Toyota', model: 'Camry', odo: 80000, price: 6000 }],
          },
        },
      ],
      vehicles: [{ store: 'Brighton', rows: [{ stock_no: 'S1', vin: 'VIN1', year: 2022, make: 'Honda', model: 'Accord', sale_price: 25000, odo: 12000 }] }],
      stores: ['Brighton'],
      total: 42,
      detailLimit: 5,
      days: 7,
    });
    expect(d.leads[0]).toMatchObject({ full_name: 'Sam Lee', lead_source: 'Website', salesperson: 'Ana Ruiz', vehicle: '2022 Honda Accord', store: 'Brighton' });
    expect(d.customers[0]).toMatchObject({ full_name: 'Sam Lee', email: 'sam@example.com', phone: '555-0101', address: '1 Main St, Brighton' });
    expect(d.vehicles[0]).toMatchObject({ stock_number: 'S1', vin: 'VIN1', price: '25000', mileage: '12000', store: 'Brighton' });
    expect(d.appointments[0]).toMatchObject({ full_name: 'Sam Lee', appointment_type: 'Test drive', status: 'Scheduled' });
    expect(d.tasks[0]).toMatchObject({ full_name: 'Sam Lee', task_type: 'call', description: 'Follow up', completed: 'false', priority: 'high' });
    expect(d.trade_vehicles[0]).toMatchObject({ full_name: 'Sam Lee', vehicle: '2015 Toyota Camry', mileage: '80000', trade_allowance: '6000' });
    expect(d.customer_notes[0]).toMatchObject({ full_name: 'Sam Lee', note_type: 'note', note: 'Called, left voicemail', user_name: 'Ana Ruiz' });
    expect(d.leads[0]!.created_date).toBe(new Date(1_781_000_000 * 1000).toISOString());
    expect(d.dealership).toBe('Brighton');
    expect(d.total_in_list).toBe(42);
  });

  it('says what was capped and what failed', () => {
    const d = toDatasets({
      leads: [
        { lead: { ...lead, id: 2 }, store: 'Brighton' },
        { lead: { ...lead, id: 3 }, store: 'Brighton', errors: ['lead detail: HTTP 500'] },
      ],
      vehicles: [],
      stores: ['Brighton', 'Fort Collins'],
      total: 2,
      detailLimit: 1,
      days: 7,
    });
    expect(d.unavailable.some((u) => u.includes('read for 0 of 2 leads'))).toBe(true);
    expect(d.unavailable.some((u) => u.includes('lead detail: HTTP 500'))).toBe(true);
    expect(d.dealership).toBe('Brighton, Fort Collins');
  });

  it('reports an empty window', () => {
    const d = toDatasets({ leads: [], vehicles: [], stores: [], total: 0, detailLimit: 5, days: 7 });
    expect(d.unavailable).toContain('appointments, tasks, trade_vehicles, customer_notes: no leads in the window');
    expect(d.dealership).toBeNull();
  });
});
