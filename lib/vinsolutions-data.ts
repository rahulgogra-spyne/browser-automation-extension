// VinSolutions (VinConnect): raw data -> the seven datasets. Pure functions, so they can be tested
// without a browser. The raw shapes are the ones VinConnect's own screens use (mapped in
// ~/Downloads/extension/config/crm-structures.json, crms["vinsolutions-app-coxautoinc-com"]).
/** What the detail reads found for one customer (the page's own parse; see lib/vinsolutions-run.ts). */
export interface Detail {
  trade_in?: string | null;
  trade_detail?: string | null;
  trade_value?: string | null;
  customer_note?: string | null;
  tasks?: string | null;
  appointments?: { subject?: string | null; recipient?: string | null; when?: string | null }[];
  notes?: { date?: string | null; sender?: string | null; subject?: string | null; body?: string | null }[];
  errors?: string[];
}

/** The Recent Opportunities window the screen uses by default: customers received from this date on. */
export const RECENT_FROM = '2026-10-13';

/** One row of POST /CarDashboard/bff/search/customers (only the fields we use). */
export interface CustomerRow {
  globalCustomerId: number;
  autoLeadId: number;
  dealerId?: number;
  fullName?: string | null;
  companyName?: string | null;
  email?: string | null;
  emailAlt?: string | null;
  cellPhone?: string | null;
  dayPhone?: string | null;
  evePhone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  dealerName?: string | null;
  salesRepDisplay?: string | null;
  leadSourceName?: string | null;
  leadStatusTypeName?: string | null;
  createdLocal?: string | null;
  vehicleDisplay?: string | null;
  vehicleYear?: string | number | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  vehicleStockNumber?: string | null;
}

export type Row = Record<string, string | null>;

const text = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

export function customerOf(r: CustomerRow): Row {
  return {
    full_name: text(r.fullName),
    company: text(r.companyName),
    email: text(r.email),
    email_2: text(r.emailAlt),
    phone_mobile: text(r.cellPhone),
    phone_work: text(r.dayPhone),
    phone_home: text(r.evePhone),
    address: text(r.address),
    city: text(r.city),
    state: text(r.state),
    zip: text(r.postalCode),
    dealer_name: text(r.dealerName),
    salesperson: text(r.salesRepDisplay),
    lead_source: text(r.leadSourceName),
    lead_status: text(r.leadStatusTypeName),
    vehicle: text(r.vehicleDisplay),
    vehicle_year: text(r.vehicleYear),
    vehicle_make: text(r.vehicleMake),
    vehicle_model: text(r.vehicleModel),
    stock_number: text(r.vehicleStockNumber),
    created_date: text(r.createdLocal),
  };
}

export function leadOf(r: CustomerRow): Row {
  return {
    full_name: text(r.fullName),
    lead_source: text(r.leadSourceName),
    lead_status: text(r.leadStatusTypeName),
    salesperson: text(r.salesRepDisplay),
    dealer_name: text(r.dealerName),
    vehicle: text(r.vehicleDisplay),
    created_date: text(r.createdLocal),
  };
}

/** A vehicle only when the row has one. */
export function vehicleOf(r: CustomerRow): Row | null {
  if (!r.vehicleDisplay && !r.vehicleStockNumber) return null;
  return {
    full_name: text(r.fullName),
    vehicle: text(r.vehicleDisplay),
    vehicle_year: text(r.vehicleYear),
    vehicle_make: text(r.vehicleMake),
    vehicle_model: text(r.vehicleModel),
    stock_number: text(r.vehicleStockNumber),
  };
}

/** Everything the run returns: the seven datasets, plus what was missing and why. */
export interface Datasets {
  dealership: string | null;
  total_in_list: number | null;
  leads: Row[];
  customers: Row[];
  vehicles: Row[];
  appointments: Row[];
  tasks: Row[];
  trade_vehicles: Row[];
  customer_notes: Row[];
  unavailable: string[];
  notes: string;
}

/** Joins the rows (from the search) with what the detail reads found for the first customers. */
export function toDatasets(args: {
  rows: CustomerRow[];
  total: number | null;
  dealers: string[];
  details: Record<string, Detail>;
  detailLimit: number;
}): Datasets {
  const { rows, details } = args;
  const unavailable: string[] = [];
  const named = (r: CustomerRow) => text(r.fullName);

  const appointments: Row[] = [];
  const tasks: Row[] = [];
  const trade_vehicles: Row[] = [];
  const customer_notes: Row[] = [];
  let detailed = 0;

  for (const r of rows) {
    const d = details[String(r.globalCustomerId)];
    if (!d) continue;
    detailed++;
    const who = named(r);
    for (const a of d.appointments ?? []) {
      appointments.push({ full_name: who, subject: text(a.subject), when: text(a.when), rep: text(a.recipient), status: null });
    }
    if (d.tasks) tasks.push({ full_name: who, task: d.tasks, due: null, status: null });
    if (d.trade_in || d.trade_detail || d.trade_value) {
      trade_vehicles.push({ full_name: who, description: d.trade_in ?? null, detail: d.trade_detail ?? null, value: d.trade_value ?? null });
    }
    if (d.customer_note) customer_notes.push({ full_name: who, date: null, author: null, note: d.customer_note });
    for (const n of d.notes ?? []) {
      customer_notes.push({ full_name: who, date: text(n.date), author: text(n.sender), note: [text(n.subject), text(n.body)].filter(Boolean).join(': ') || null });
    }
    if (d.errors?.length) unavailable.push(`${who ?? 'a customer'}: ${d.errors.join('; ')}`);
  }

  if (rows.length > args.detailLimit) {
    unavailable.push(`appointments, tasks, trade_vehicles, customer_notes: read for the first ${args.detailLimit} of ${rows.length} customers only (POC limit)`);
  }
  if (rows.length && detailed === 0) unavailable.push('appointments, tasks, trade_vehicles, customer_notes: no customer detail was read');

  return {
    dealership: args.dealers.length ? args.dealers.join(', ') : null,
    total_in_list: args.total,
    leads: rows.map(leadOf),
    customers: rows.map(customerOf),
    vehicles: rows.map(vehicleOf).filter((v): v is Row => v !== null),
    appointments,
    tasks,
    trade_vehicles,
    customer_notes,
    unavailable,
    notes: `Read ${rows.length} customers from the search (from ${RECENT_FROM}); detail reads for ${detailed}.`,
  };
}
