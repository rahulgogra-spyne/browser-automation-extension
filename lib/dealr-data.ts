// Dealr.cloud: raw API data -> the seven datasets. Pure functions, tested without a browser.
// Raw shapes (mapped in ~/Downloads/extension/extension/config/crm-structures.json, manage-dealr-cloud):
//   GET /api/leads (list, newest first; creation_time is Unix seconds) and GET /api/leads/{id} (detail,
//   which carries phones, emails, address, activities (notes), appointments, tasks and trades).
//   GET /api/inventory/ (vehicles). Each store is chosen per request with the x-dealer-id header.

/** One row of GET /api/leads (only the fields we use). */
export interface LeadRow {
  id: number;
  name?: string | null;
  source_name?: string | null;
  status?: string | null;
  sub_status?: string | null;
  category?: string | null;
  temperature?: string | null;
  assigned_user_name?: string | null;
  creation_time?: number | null;
  vehicles?: { vehicle_string?: string | null; year?: number | string | null; make?: string | null; model?: string | null; vin?: string | null; stock_no?: string | null }[];
  dealer_name?: string | null;
}

/** One row of GET /api/leads/{id} (only the parts we use). */
export interface LeadDetail {
  name_first?: string | null;
  name_last?: string | null;
  company_name?: string | null;
  phones?: { number?: string | null }[];
  emails?: { email?: string | null }[];
  address?: Record<string, unknown> | null;
  activities?: { type?: string | null; message?: string | null; timestamp?: number | string | null; user_name?: string | null }[];
  appointments?: { type?: string | null; time?: number | string | null; status?: string | null; description?: string | null; salesperson?: string | null }[];
  tasks?: { type?: string | null; description?: string | null; reminder_time?: number | string | null; completed?: boolean | null; priority?: string | null }[];
  trades?: { vehicle_string?: string | null; year?: number | string | null; make?: string | null; model?: string | null; trim?: string | null; vin?: string | null; odo?: number | string | null; price?: number | string | null; acv?: number | string | null; payoff?: number | string | null }[];
}

/** One row of GET /api/inventory/ (only the fields we use). */
export interface InventoryRow {
  id?: number;
  stock_no?: string | null;
  vin?: string | null;
  year?: number | string | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  condition?: string | null;
  status?: string | null;
  sale_price?: number | string | null;
  odo?: number | string | null;
  age?: number | string | null;
  in_date?: string | null;
  location?: string | null;
  active_leads_count?: number | string | null;
  vehicle?: string | null;
}

export type Row = Record<string, string | null>;

const text = (v: unknown): string | null => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

/** Unix seconds -> an ISO date, or the text as it came. */
export function when(v: unknown): string | null {
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  return text(v);
}

export function leadName(l: LeadRow | LeadDetail): string | null {
  const d = l as LeadDetail;
  if ('name_first' in d || 'name_last' in d) return text([d.name_first, d.name_last].filter(Boolean).join(' '));
  return text((l as LeadRow).name);
}

export function leadOf(l: LeadRow, store: string | null): Row {
  return {
    full_name: text(l.name),
    lead_source: text(l.source_name),
    lead_status: text(l.status),
    sub_status: text(l.sub_status),
    lead_category: text(l.category),
    temperature: text(l.temperature),
    salesperson: text(l.assigned_user_name),
    vehicle: text(l.vehicles?.[0]?.vehicle_string),
    created_date: when(l.creation_time),
    store,
  };
}

export function customerOf(l: LeadRow, d: LeadDetail | undefined): Row {
  return {
    full_name: leadName(d ?? l),
    company: text(d?.company_name),
    email: text(d?.emails?.[0]?.email),
    email_2: text(d?.emails?.[1]?.email),
    phone: text(d?.phones?.[0]?.number),
    phone_2: text(d?.phones?.[1]?.number),
    address: d?.address ? text(Object.values(d.address).filter(Boolean).join(', ')) : null,
  };
}

export function vehicleOf(v: InventoryRow, store: string | null): Row {
  return {
    stock_number: text(v.stock_no),
    vin: text(v.vin),
    vehicle_year: text(v.year),
    vehicle_make: text(v.make),
    vehicle_model: text(v.model),
    trim: text(v.trim),
    condition: text(v.condition),
    status: text(v.status),
    price: text(v.sale_price),
    mileage: text(v.odo),
    age_days: text(v.age),
    in_date: text(v.in_date),
    location: text(v.location),
    active_leads: text(v.active_leads_count),
    store,
  };
}

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

export interface LeadInput {
  lead: LeadRow;
  store: string;
  detail?: LeadDetail;
  errors?: string[];
}

/** Joins the leads (with their detail where it was read) and the inventory into the seven datasets. */
export function toDatasets(args: { leads: LeadInput[]; vehicles: { store: string; rows: InventoryRow[] }[]; stores: string[]; total: number | null; detailLimit: number; days: number }): Datasets {
  const unavailable: string[] = [];
  const appointments: Row[] = [];
  const tasks: Row[] = [];
  const trade_vehicles: Row[] = [];
  const customer_notes: Row[] = [];
  let detailed = 0;

  for (const { lead, store, detail, errors } of args.leads) {
    const who = leadName(lead);
    if (detail) {
      detailed++;
      for (const a of detail.appointments ?? []) {
        appointments.push({ full_name: who, appointment_type: text(a.type), appointment_date: when(a.time), status: text(a.status), description: text(a.description), salesperson: text(a.salesperson), store });
      }
      for (const t of detail.tasks ?? []) {
        tasks.push({ full_name: who, task_type: text(t.type), description: text(t.description), due_date: when(t.reminder_time), completed: t.completed == null ? null : String(t.completed), priority: text(t.priority), store });
      }
      for (const tr of detail.trades ?? []) {
        trade_vehicles.push({ full_name: who, vehicle: text(tr.vehicle_string), vehicle_year: text(tr.year), vehicle_make: text(tr.make), vehicle_model: text(tr.model), trim: text(tr.trim), vin: text(tr.vin), mileage: text(tr.odo), trade_allowance: text(tr.price), acv: text(tr.acv), payoff: text(tr.payoff), store });
      }
      for (const n of detail.activities ?? []) {
        customer_notes.push({ full_name: who, note_type: text(n.type), note: text(n.message), timestamp: when(n.timestamp), user_name: text(n.user_name), store });
      }
    }
    if (errors?.length) unavailable.push(`${who ?? 'a lead'}: ${errors.join('; ')}`);
  }

  const vehicles: Row[] = args.vehicles.flatMap((v) => v.rows.map((r) => vehicleOf(r, v.store)));

  if (args.leads.length && detailed < args.leads.length) {
    unavailable.push(`appointments, tasks, trade_vehicles, customer_notes: read for ${detailed} of ${args.leads.length} leads (POC limit)`);
  }
  if (!args.leads.length) unavailable.push('appointments, tasks, trade_vehicles, customer_notes: no leads in the window');

  return {
    dealership: args.stores.length ? args.stores.join(', ') : null,
    total_in_list: args.total,
    leads: args.leads.map((l) => leadOf(l.lead, l.store)),
    customers: args.leads.map((l) => customerOf(l.lead, l.detail)),
    vehicles,
    appointments,
    tasks,
    trade_vehicles,
    customer_notes,
    unavailable,
    notes: `Read ${args.leads.length} leads from the last ${args.days} days across ${args.stores.length} store(s); detail for ${detailed}.`,
  };
}
