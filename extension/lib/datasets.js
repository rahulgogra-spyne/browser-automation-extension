// The kinds of data captured from a CRM, whatever the vendor. Each kind is
// mapped on its own (its record page, its lists) and saved to its own daily
// file. Shared by the extension (Settings, the mapping agent it runs, the
// files it writes) and the backend (the LLM prompts).
//
//   person        rows are people: duplicates are matched by email/phone
//   identityKeys  a mapped record must yield at least one of these on every
//                 example, or the layout is not trusted
//   contactKeys   ...and, for people, one of these when the example had one
const PERSON_CONTACT = ['email', 'phone_mobile', 'phone_home', 'phone_work', 'phone'];

export const DATASETS = {
  users: {
    id: 'users',
    label: 'Internal users, agents and employees',
    plural: 'users',
    person: true,
    description: "the CRM's own people: internal users, agents, employees, salespeople, team members, administrators",
    hint: 'pages of logins, roles, permissions, groups, "last login" dates',
    listWords: /\b(users?|employees?|agents?|staff|team|members?|directory|salespeople|sales reps?|reps?|admins?|administrators?|personnel|colleagues?)\b/i,
    fieldKeys:
      'first_name, last_name, full_name, login, email, phone_mobile, phone_work, phone, job_title, role, department, team, office, manager, status, ' +
      'employee_id, hire_date, last_login, created_date, address, city, state, zip',
    recordHint: "ONE internal user's, employee's or agent's profile (login, name, email, phone, role, department, status...)",
    rules: "The record's own details are the data: login, name, email, phones, job title, role/permissions group, department, team, supervisor, status (active/disabled), dates. Skip the names of other people who merely appear as creators/modifiers of the record.",
    identityKeys: ['first_name', 'last_name', 'full_name', 'name', 'login', 'username'],
    contactKeys: PERSON_CONTACT,
  },
  customers: {
    id: 'customers',
    label: 'Customers, contacts and leads (people)',
    plural: 'customers',
    person: true,
    description: 'the people the business deals with: customers, contacts, leads, prospects, clients, co-buyers',
    hint: 'a person with contact details, addresses, communication preferences, and their message history',
    listWords: /\b(contacts?|leads?|customers?|people|clients?|prospects?|buyers?)\b/i,
    fieldKeys:
      'first_name, last_name, full_name, email, phone_mobile, phone_home, phone_work, phone, address, city, state, zip, country, ' +
      'company, job_title, preferred_contact_method, do_not_call, do_not_email, do_not_text, co_buyer, ' +
      'lead_source, lead_type, lead_status, salesperson, bdc_agent, vehicle_year, vehicle_make, vehicle_model, vin, stock_number, trade_in, created_date',
    recordHint: "ONE customer's record (a contact, lead, customer or prospect: their details, messages, notes...)",
    rules: "Skip the business's own details and its staff other than the assigned salesperson/owner/BDC agent.",
    identityKeys: ['first_name', 'last_name', 'full_name', 'name', 'company'],
    contactKeys: PERSON_CONTACT,
  },
  deals: {
    id: 'deals',
    label: 'Sales leads, deals and opportunities',
    plural: 'deals',
    person: false,
    description: "sales leads, deals and opportunities: one customer's interest in buying (source, type, status/stage, vehicle, amount, salesperson)",
    hint: 'an opportunity/deal/sales-lead page with stage or status, amount, source, close date, the customer it belongs to',
    listWords: /\b(opportunit(y|ies)|deals?|sales leads?|pipeline|quotes?|proposals?|desking)\b/i,
    fieldKeys:
      'deal_name, customer_name, company, lead_source, lead_type, lead_status, stage, amount, probability, close_date, created_date, ' +
      'salesperson, bdc_agent, sales_manager, vehicle_year, vehicle_make, vehicle_model, vin, stock_number, trade_in, next_step, description',
    recordHint: 'ONE sales lead, deal or opportunity (its name, the customer, stage/status, source, amount, vehicle, who it is assigned to)',
    rules: "Take the customer as customer_name (one value) and the assigned people as salesperson / bdc_agent / sales_manager; do not map the customer's own contact details here unless the page shows nothing else about them.",
    identityKeys: ['deal_name', 'name', 'title', 'subject', 'customer_name', 'opportunity_name', 'lead_status', 'stage'],
    contactKeys: [],
  },
  appointments: {
    id: 'appointments',
    label: 'Appointments and meetings',
    plural: 'appointments',
    person: false,
    description: 'appointments, meetings, visits and scheduled events with customers',
    hint: 'one appointment/meeting/event page with a start time, a status, who it is with and who it is assigned to',
    listWords: /\b(appointments?|meetings?|events?|calendar|agenda|schedule|visits?|test drives?)\b/i,
    fieldKeys: 'subject, appointment_type, start_time, end_time, duration, status, location, customer_name, assigned_to, created_by, created_date, related_to, description, outcome',
    recordHint: 'ONE appointment, meeting or scheduled event (subject, start/end time, status, the customer, who it is assigned to)',
    rules: 'Take the customer as customer_name and the staff member as assigned_to.',
    identityKeys: ['subject', 'title', 'name', 'start_time', 'appointment_type', 'customer_name'],
    contactKeys: [],
  },
  tasks: {
    id: 'tasks',
    label: 'Tasks and action items',
    plural: 'tasks',
    person: false,
    description: 'tasks, action items, to-dos and follow-ups assigned to staff',
    hint: 'one task/to-do/follow-up page with a due date, a status or priority, and who it is assigned to',
    listWords: /\b(tasks?|to-?dos?|action items?|follow-?ups?|reminders?|activities)\b/i,
    fieldKeys: 'subject, task_type, due_date, status, priority, assigned_to, customer_name, related_to, created_by, created_date, completed_date, description',
    recordHint: 'ONE task, action item or follow-up (subject, due date, status, priority, who it is assigned to, the customer it concerns)',
    rules: 'Take the customer as customer_name and the staff member as assigned_to.',
    identityKeys: ['subject', 'title', 'name', 'task_type', 'due_date'],
    contactKeys: [],
  },
  vehicles: {
    id: 'vehicles',
    label: 'Vehicles and inventory',
    plural: 'vehicles',
    person: false,
    description: 'vehicles: inventory units and the vehicles customers own, want or trade in',
    hint: 'one vehicle/inventory page with VIN, stock number, year/make/model, price or mileage',
    listWords: /\b(vehicles?|inventory|stock|cars?|units?)\b/i,
    fieldKeys: 'vin, stock_number, vehicle_year, vehicle_make, vehicle_model, trim, body_style, exterior_color, interior_color, mileage, price, msrp, condition, status, location, engine, transmission, fuel_type',
    recordHint: 'ONE vehicle (VIN, stock number, year, make, model, trim, colour, mileage, price, status)',
    rules: 'Features and options lists are not fields; skip photos and marketing text.',
    identityKeys: ['vin', 'stock_number', 'vehicle_model', 'vehicle_make', 'name', 'title'],
    contactKeys: [],
  },
};

export const DATASET_IDS = Object.keys(DATASETS);
// Rows whose kind is unknown (an unmapped page read by AI that is none of the above).
export const OTHER_DATASET = 'other';

// Names used before there were several kinds.
const LEGACY = { staff: 'users' };
export const datasetById = (id) => DATASETS[LEGACY[id] ?? id] ?? null;

// A list of ids (settings, a request body, a saved config) -> known datasets, in the standard order.
export function datasetsFrom(ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => datasetById(id)?.id).filter(Boolean));
  return DATASET_IDS.filter((id) => wanted.has(id)).map((id) => DATASETS[id]);
}

// Layouts mapped before page types carried a dataset: the CRM's old single
// target, else what the entity word says.
const ENTITY_WORDS = {
  users: /^(user|employee|agent|staff|member|admin|administrator|salesperson|rep|representative|technician|manager)$/,
  deals: /^(opportunity|deal|quote|proposal)$/,
  appointments: /^(appointment|meeting|event|visit)$/,
  tasks: /^(task|todo|to-do|action item|follow-up|followup)$/,
  vehicles: /^(vehicle|car|inventory|unit)$/,
};
export function datasetOfPageType(pageType, crm = null) {
  if (datasetById(pageType?.dataset)) return datasetById(pageType.dataset).id;
  if (datasetById(crm?.target)) return datasetById(crm.target).id;
  const entity = String(pageType?.entity ?? '').toLowerCase().trim();
  for (const [id, re] of Object.entries(ENTITY_WORDS)) if (re.test(entity)) return id;
  return 'customers';
}

// The kinds a saved CRM layout covers.
export function datasetsOfCrm(crm) {
  if (Array.isArray(crm?.targets) && crm.targets.length) return datasetsFrom(crm.targets).map((d) => d.id);
  const found = new Set((crm?.pageTypes ?? []).filter((pt) => pt.role === 'record').map((pt) => datasetOfPageType(pt, crm)));
  if (!found.size && datasetById(crm?.target)) found.add(datasetById(crm.target).id);
  return DATASET_IDS.filter((id) => found.has(id));
}

// A short title for one captured row, whatever its kind.
const TITLE_KEYS = ['full_name', 'name', 'deal_name', 'subject', 'title', 'login', 'customer_name', 'company', 'vin', 'stock_number', 'email'];
export function rowTitle(fields) {
  const get = (key) => (Array.isArray(fields) ? fields.find((f) => f.key === key)?.value : fields?.[key]) || '';
  const person = [get('first_name'), get('last_name')].filter(Boolean).join(' ');
  const vehicle = [get('vehicle_year'), get('vehicle_make'), get('vehicle_model')].filter(Boolean).join(' ');
  return get('full_name') || person || TITLE_KEYS.map(get).find(Boolean) || vehicle || '';
}
