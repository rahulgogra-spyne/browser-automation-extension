import { describe, expect, it } from 'vitest';
import { isAppointment, toDatasets, type ProspectRow } from '../lib/cdk-elead-data';

const row: ProspectRow = {
  PersonId: 7,
  FirstName: 'Jamie',
  LastName: 'Doe',
  Phone: '(651) 468-9070',
  Vehicle: '2024 Ford Transit-350',
  VehicleId: 99,
  SalesPerson: 'Duffy, P',
  Source: 'Spyne',
  Company: null,
  DealDate: '10/15/26',
  Task: 'Call back',
  DueDate: '10/16/26',
  HighPriorityActivity: null,
};

describe('CDK eLead datasets', () => {
  it('maps a prospect row to lead, customer and vehicle fields', () => {
    const d = toDatasets({ rows: [row], total: 1, store: 'eLead store 16654', details: {}, detailLimit: 5, from: 'the last 7 days' });
    expect(d.leads[0]).toMatchObject({ full_name: 'Jamie Doe', lead_source: 'Spyne', salesperson: 'Duffy, P', vehicle: '2024 Ford Transit-350', deal_date: '10/15/26' });
    expect(d.customers[0]).toEqual({ full_name: 'Jamie Doe', company: null, phone_mobile: '(651) 468-9070' });
    expect(d.vehicles).toEqual([{ full_name: 'Jamie Doe', vehicle: '2024 Ford Transit-350', vehicle_id: '99' }]);
    expect(d.dealership).toBe('eLead store 16654');
    expect(d.total_in_list).toBe(1);
  });

  it('splits scheduled rows into appointments and tasks by their type', () => {
    expect(isAppointment(['10/16/26 9:00 AM', 'Sales Appointment', 'Duffy, P', ''])).toBe(true);
    expect(isAppointment(['10/16/26', 'Call', 'Duffy, P', 'Left a message'])).toBe(false);
    expect(isAppointment(['10/16/26', 'Appointment Reminder Call', 'Duffy, P', ''])).toBe(false);
    expect(isAppointment(['10/16/26', 'Appointment', 'Duffy, P', ''])).toBe(true);

    const d = toDatasets({
      rows: [row],
      total: 1,
      store: null,
      detailLimit: 5,
      from: 'the last 7 days',
      details: {
        '7': {
          scheduled: [
            ['10/16/26 9:00 AM', 'Sales Appointment', 'Duffy, P', 'Test drive'],
            ['10/16/26', 'Call', 'Duffy, P', 'Follow up'],
          ],
          completed: [['10/14/26 12:21 PM', 'Active - New', 'TeleLink - Google', 'Sanchez, N']],
        },
      },
    });
    expect(d.appointments).toEqual([{ full_name: 'Jamie Doe', subject: 'Sales Appointment', when: '10/16/26 9:00 AM', rep: 'Duffy, P', status: 'Test drive' }]);
    expect(d.tasks).toEqual([{ full_name: 'Jamie Doe', task: 'Call: Follow up', due: '10/16/26', status: 'Duffy, P' }]);
    expect(d.customer_notes).toEqual([{ full_name: 'Jamie Doe', date: '10/14/26 12:21 PM', author: null, note: 'Active - New | TeleLink - Google | Sanchez, N' }]);
    expect(d.trade_vehicles).toEqual([]);
    expect(d.unavailable.some((u) => u.includes('trade_vehicles'))).toBe(true);
  });

  it('says what was capped and what failed', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...row, PersonId: i + 1, FirstName: `P${i}` }));
    const d = toDatasets({ rows: many, total: 7, store: null, detailLimit: 2, from: 'the last 7 days', details: { '1': { errors: ['history: HTTP 500'] } } });
    expect(d.unavailable.some((u) => u.includes('first 2 of 7'))).toBe(true);
    expect(d.unavailable.some((u) => u.includes('history: HTTP 500'))).toBe(true);
  });
});
