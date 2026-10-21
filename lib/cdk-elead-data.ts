// CDK eLead (Modern Retail CRM, elead v45): raw data -> the seven datasets. Pure functions, tested
// without a browser. Raw shapes: POST /evo2/api/ProspectData/GetProspectList (rows) and the eLead
// history page's two tables, gvOpptyHistory (completed activity) and gvScheduled (tasks and
// appointments). See ~/Downloads/extension/extension/config/crm-structures.json, app-unify-app-connectcdk-com.

/** One row of GetProspectList (only the fields we use). */
export interface ProspectRow {
  PersonId: number;
  DealId?: number | null;
  FirstName?: string | null;
  LastName?: string | null;
  Phone?: string | null;
  Vehicle?: string | null;
  VehicleId?: number | null;
  SalesPerson?: string | null;
  Source?: string | null;
  Company?: string | null;
  DealDate?: string | null;
  Task?: string | null;
  TaskType?: string | null;
  DueDate?: string | null;
  HighPriorityActivity?: string | null;
}

/** One row of a history table: the cells in column order, as text. */
export type TableRow = string[];

/** What the detail reads found for one prospect. */
export interface ProspectDetail {
  completed?: TableRow[];
  scheduled?: TableRow[];
  errors?: string[];
}

export type Row = Record<string, string | null>;

const text = (v: unknown): string | null => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

export function fullName(r: ProspectRow): string | null {
  return text([r.FirstName, r.LastName].filter(Boolean).join(' '));
}

export function leadOf(r: ProspectRow): Row {
  return {
    full_name: fullName(r),
    lead_source: text(r.Source),
    salesperson: text(r.SalesPerson),
    vehicle: text(r.Vehicle),
    deal_date: text(r.DealDate),
    next_task: text(r.Task),
    task_due: text(r.DueDate),
    high_priority: text(r.HighPriorityActivity),
  };
}

export function customerOf(r: ProspectRow): Row {
  return { full_name: fullName(r), company: text(r.Company), phone_mobile: text(r.Phone) };
}

export function vehicleOf(r: ProspectRow): Row | null {
  if (!r.Vehicle) return null;
  return { full_name: fullName(r), vehicle: text(r.Vehicle), vehicle_id: text(r.VehicleId) };
}

/** A scheduled row is an appointment when its activity type says so; anything else is a task. */
export function isAppointment(cells: TableRow): boolean {
  // "Appointment" and "Sales Appointment" are appointments; "Appointment Reminder Call" is a call task.
  return /\bappointment\b/i.test(cells.join(' ')) && !/reminder/i.test(cells.join(' '));
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

export function toDatasets(args: { rows: ProspectRow[]; total: number | null; store: string | null; details: Record<string, ProspectDetail>; detailLimit: number; from: string }): Datasets {
  const { rows, details } = args;
  const unavailable: string[] = [
    'trade_vehicles: eLead keeps trade-ins on a screen this run does not read yet (the prospect list and history have none)',
    'customers.address: not read in this proof of concept (the eLead detail endpoint returns an error for this account)',
  ];
  const appointments: Row[] = [];
  const tasks: Row[] = [];
  const customer_notes: Row[] = [];
  let detailed = 0;

  for (const r of rows) {
    const d = details[String(r.PersonId)];
    if (!d) continue;
    detailed++;
    const who = fullName(r);
    // gvScheduled columns: Due, Type, Assigned To, Comment, (blank), Action.
    for (const cells of d.scheduled ?? []) {
      const [due = null, type = null, assigned = null, comment = null] = cells;
      if (isAppointment(cells)) {
        appointments.push({ full_name: who, subject: text(type), when: text(due), rep: text(assigned), status: text(comment) });
      } else {
        tasks.push({ full_name: who, task: text([type, comment].filter(Boolean).join(': ')), due: text(due), status: text(assigned) });
      }
    }
    // gvOpptyHistory: the first cell is the expand icon; then the date, then the activity text.
    for (const cells of d.completed ?? []) {
      const [date = null, ...rest] = cells;
      const note = text(rest.filter(Boolean).join(' | '));
      if (note) customer_notes.push({ full_name: who, date: text(date), author: null, note });
    }
    if (d.errors?.length) unavailable.push(`${who ?? 'a prospect'}: ${d.errors.join('; ')}`);
  }

  if (rows.length > args.detailLimit) {
    unavailable.push(`appointments, tasks, customer_notes: read for the first ${args.detailLimit} of ${rows.length} prospects only (POC limit)`);
  }
  if (rows.length && detailed === 0) unavailable.push('appointments, tasks, customer_notes: no prospect history was read');

  return {
    dealership: args.store,
    total_in_list: args.total,
    leads: rows.map(leadOf),
    customers: rows.map(customerOf),
    vehicles: rows.map(vehicleOf).filter((v): v is Row => v !== null),
    appointments,
    tasks,
    trade_vehicles: [],
    customer_notes,
    unavailable,
    notes: `Read ${rows.length} prospects (Active, from ${args.from}); history read for ${detailed}.`,
  };
}
