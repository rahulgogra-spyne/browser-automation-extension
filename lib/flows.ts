// One flow per DMS. The product tells the extension which DMS the customer uses (the FE's
// `start` command carries `dms`), and the extension runs that flow. The dealer only signs in.
//
// `goal` is the model's brief. `result` is the JSON schema the model must fill through the
// submit_result tool (strict mode: list every property in `required`, nested objects too, and
// make optional ones nullable, e.g. type: ['string', 'null']).

export interface Flow {
  dms: DmsId;
  /** The DMS's name, as dealers know it. */
  dmsName: string;
  title: string;
  /** Shown before the run, in the dealer's words. */
  summary: string;
  /** The run starts here, in a new tab. */
  startUrl: string;
  /** The DMS's own sites (subdomains included). The run acts and reads only on these. */
  allowedHosts: string[];
  /**
   * What the run may do beyond reading and scrolling: an allowlist, not a blocklist (lib/guard.ts,
   * lib/firewall.ts). Anything not listed is refused.
   */
  allow: {
    /**
     * The flow's pages. The run opens exactly these (query included, so no filters of its own) and
     * acts only on them (whatever query the app itself adds, e.g. a page number).
     */
    urls: string[];
    /** Names of the only controls it may click, e.g. paging. Matched against the whole name. */
    clicks: RegExp;
    /**
     * Requests audited as reads, beyond the ones the page makes while loading itself. Matched
     * against the firewall's whole key (method, host, path, query and body shape; see
     * lib/firewall.ts endpoint()), so an audit names the operation, not just the address.
     */
    readEndpoints?: RegExp[];
  };
  goal: string;
  result: { properties: Record<string, object>; required: string[] };
}

export type DmsId = 'tekion' | 'vinsolutions' | 'cdk' | 'dealr';

const nullableString = (description: string) => ({ type: ['string', 'null'], description });

/** Paging controls: the only clicks a list-reading flow needs. */
const PAGING =
  /^(next|previous|prev|next page|previous page|first page|last page|go to (the )?(next|previous|first|last) page|page \d{1,4}|go to page \d{1,4}|\d{1,4}|[‹›«»<>]|load more|show more)$/i;

// VinSolutions (Cox Automotive CRM, VinConnect): the customer list the dealer's Recent Opportunities
// screen shows. Fields and hosts are the ones mapped in ~/Downloads/extension (config/crm-structures.json,
// crms["vinsolutions-app-coxautoinc-com"], v8). The screen's own search call is the read: POST
// /CarDashboard/bff/search/customers, which the firewall must let through (readEndpoints below).
const VINSOLUTIONS_CUSTOMER = {
  type: 'object',
  properties: {
    full_name: nullableString('Customer name, as shown'),
    company: nullableString('Company name, if the customer is a business'),
    email: nullableString('Primary email'),
    email_2: nullableString('Alternate email'),
    phone_mobile: nullableString('Mobile phone'),
    phone_work: nullableString('Work phone'),
    phone_home: nullableString('Home or evening phone'),
    address: nullableString('Street address'),
    city: nullableString('City'),
    state: nullableString('State'),
    zip: nullableString('Postal code'),
    dealer_name: nullableString('Dealership (rooftop) this lead belongs to'),
    salesperson: nullableString('Sales rep, as shown'),
    lead_source: nullableString('Lead source'),
    lead_status: nullableString('Lead status'),
    vehicle: nullableString('Vehicle as shown (year make model)'),
    vehicle_year: nullableString('Vehicle year'),
    vehicle_make: nullableString('Vehicle make'),
    vehicle_model: nullableString('Vehicle model'),
    stock_number: nullableString('Vehicle stock number'),
    created_date: nullableString('Date the lead was created, as shown'),
  },
  required: [
    'full_name', 'company', 'email', 'email_2', 'phone_mobile', 'phone_work', 'phone_home', 'address', 'city', 'state',
    'zip', 'dealer_name', 'salesperson', 'lead_source', 'lead_status', 'vehicle', 'vehicle_year', 'vehicle_make',
    'vehicle_model', 'stock_number', 'created_date',
  ],
  additionalProperties: false,
};

/** The other VinSolutions datasets. Each row names its customer, so the files can be joined. */
const VINSOLUTIONS_LEAD = {
  type: 'object',
  properties: {
    full_name: nullableString('Customer name, as shown'),
    lead_source: nullableString('Lead source'),
    lead_status: nullableString('Lead status'),
    salesperson: nullableString('Sales rep, as shown'),
    dealer_name: nullableString('Dealership on the lead, if shown'),
    vehicle: nullableString('Vehicle of interest, as shown'),
    created_date: nullableString('Date shown beside the lead status'),
  },
  required: ['full_name', 'lead_source', 'lead_status', 'salesperson', 'dealer_name', 'vehicle', 'created_date'],
  additionalProperties: false,
};

const VINSOLUTIONS_VEHICLE = {
  type: 'object',
  properties: {
    full_name: nullableString('Customer name, as shown'),
    vehicle: nullableString('Vehicle as shown (year make model)'),
    vehicle_year: nullableString('Vehicle year'),
    vehicle_make: nullableString('Vehicle make'),
    vehicle_model: nullableString('Vehicle model'),
    stock_number: nullableString('Vehicle stock number'),
  },
  required: ['full_name', 'vehicle', 'vehicle_year', 'vehicle_make', 'vehicle_model', 'stock_number'],
  additionalProperties: false,
};

/** A dataset row: the customer's name plus the given fields, all nullable strings. */
function VINSOLUTIONS_ITEM(fields: string[]) {
  return {
    type: 'object',
    properties: { full_name: nullableString('Customer name, as shown'), ...Object.fromEntries(fields.map((f) => [f, nullableString(f.replace(/_/g, ' '))])) },
    required: ['full_name', ...fields],
    additionalProperties: false,
  };
}

const VINSOLUTIONS: Flow = {
  dms: 'vinsolutions',
  dmsName: 'VinSolutions',
  title: 'VinSolutions customers',
  summary:
    "Opens VinSolutions, waits for you to sign in if needed, and reads the customers on your Recent Opportunities list. It only reads: it pages and scrolls, and blocks edits and saves.",
  // The Recent Opportunities list (Customers > Recent Opportunities), as VinConnect's hash route. Opening it
  // directly avoids the Customers menu, which the read-only guard can't click (it links to another page).
  startUrl:
    'https://vinsolutions.app.coxautoinc.com/vinconnect/#/CarDashboard/Pages/LeadManagement/ActiveLeadsLayout.aspx?SelectedTab=t_ILM&leftpaneframe=AdvancedSearch2.aspx?qmode=RO&rightpaneframe=HIDE&NoMenu=true',
  allowedHosts: ['coxautoinc.com', 'vinsolutions.com', 'vinmanager.com'],
  allow: {
    urls: [
      'https://vinsolutions.app.coxautoinc.com/vinconnect/#/CarDashboard/Pages/LeadManagement/ActiveLeadsLayout.aspx?SelectedTab=t_ILM&leftpaneframe=AdvancedSearch2.aspx?qmode=RO&rightpaneframe=HIDE&NoMenu=true',
    ],
    clicks: PAGING,
    // The Recent Opportunities screen's own customer search (read only; the list is a search, not a write).
    readEndpoints: [/^POST vinsolutions\.app\.coxautoinc\.com\/CarDashboard\/bff\/search\/customers\b/],
  },
  goal: `Read the Recent Opportunities list in VinConnect (Customers > Recent Opportunities) and fill seven datasets from it: leads, customers, vehicles, appointments, tasks, trade_vehicles and customer_notes.
- Make sure the user is signed in first. If not, hand over with wait_for_user.
- The list opens by itself (the run starts on it). If it doesn't show, wait a moment and read again; do not use the menus. Do not change its date range, filters or dealership.
- Read the list with read_page. If it has more rows (scrolling or pages), collect up to 50 customers, and say in notes if there were more.
- leads: one row per list row (lead status, source, salesperson, vehicle, created date). customers: contact and address per row. vehicles: the vehicle on each row.
- appointments, tasks, trade_vehicles and customer_notes are on each customer's own page, which this run does not open. Return them as empty lists and list each one under unavailable.
- Copy values as shown. If a field isn't shown, leave it null and list the field under unavailable.
- Read only. Do not open, edit, save, or send anything. When you have them, call submit_result.`,
  result: {
    properties: {
      dealership: nullableString('The dealership the list is for, as shown in the app'),
      total_in_list: { type: ['integer', 'null'], description: 'How many customers the list says it has, if it shows a count' },
      leads: { type: 'array', description: 'One per list row', items: VINSOLUTIONS_LEAD },
      customers: { type: 'array', description: 'The customers read, in list order', items: VINSOLUTIONS_CUSTOMER },
      vehicles: { type: 'array', description: 'The vehicle on each row', items: VINSOLUTIONS_VEHICLE },
      appointments: { type: 'array', description: "Empty: on each customer's page (not opened)", items: VINSOLUTIONS_ITEM(['subject', 'when', 'rep', 'status']) },
      tasks: { type: 'array', description: "Empty: on each customer's page (not opened)", items: VINSOLUTIONS_ITEM(['task', 'due', 'status']) },
      trade_vehicles: { type: 'array', description: "Trade-in as the lead page shows it (text, not parsed)", items: VINSOLUTIONS_ITEM(['description', 'detail', 'value']) },
      customer_notes: { type: 'array', description: "Empty: on each customer's page (not opened)", items: VINSOLUTIONS_ITEM(['date', 'author', 'note']) },
      unavailable: { type: 'array', items: { type: 'string' }, description: "Columns or areas this account couldn't see, or sections not opened" },
      notes: { type: 'string', description: 'Anything else worth knowing (e.g. more customers than were read), or an empty string' },
    },
    required: ['dealership', 'total_in_list', 'leads', 'customers', 'vehicles', 'appointments', 'tasks', 'trade_vehicles', 'customer_notes', 'unavailable', 'notes'],
  },
};

// CDK eLead (Modern Retail CRM). Collected by lib/cdk-elead-run.ts through the signed-in page, not by
// the model: `goal` and `allow` below only describe the flow to the UI and the read-only guard.
const CDK_ELEAD: Flow = {
  dms: 'cdk',
  dmsName: 'CDK eLead',
  title: 'CDK eLead prospects',
  summary:
    'Opens CDK eLead for the store you have selected, waits for you to sign in if needed, and reads the Active prospects of the last 7 days. It only reads.',
  startUrl: 'https://crm.connectcdk.com/evo2/fresh/elead-v45/elead_track/index.aspx',
  allowedHosts: ['connectcdk.com'],
  allow: { urls: ['https://crm.connectcdk.com/evo2/fresh/elead-v45/elead_track/index.aspx'], clicks: PAGING },
  goal: 'Read the CDK eLead prospects of the selected store (collected by lib/cdk-elead-run.ts).',
  result: {
    properties: {
      dealership: nullableString('The eLead store the prospects are from'),
      total_in_list: { type: ['integer', 'null'], description: 'How many prospects the list returned' },
      leads: { type: 'array', items: { type: 'object' } },
      customers: { type: 'array', items: { type: 'object' } },
      vehicles: { type: 'array', items: { type: 'object' } },
      appointments: { type: 'array', items: { type: 'object' } },
      tasks: { type: 'array', items: { type: 'object' } },
      trade_vehicles: { type: 'array', items: { type: 'object' } },
      customer_notes: { type: 'array', items: { type: 'object' } },
      unavailable: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
    required: ['dealership', 'total_in_list', 'leads', 'customers', 'vehicles', 'appointments', 'tasks', 'trade_vehicles', 'customer_notes', 'unavailable', 'notes'],
  },
};

// Dealr.cloud CRM. Collected by lib/dealr-run.ts through the signed-in page, not by the model: `goal`
// and `allow` describe the flow to the UI and the read-only guard only.
const DEALR: Flow = {
  dms: 'dealr',
  dmsName: 'Dealr.cloud',
  title: 'Dealr.cloud leads',
  summary:
    'Opens Dealr.cloud, waits for you to sign in if needed, and reads the leads of the last 7 days in each store you can see, with their vehicles, notes, tasks and appointments. It only reads.',
  startUrl: 'https://manage.dealr.cloud/',
  allowedHosts: ['dealr.cloud'],
  allow: { urls: ['https://manage.dealr.cloud/'], clicks: PAGING },
  goal: 'Read the Dealr.cloud leads of every store the user can see (collected by lib/dealr-run.ts).',
  result: {
    properties: {
      dealership: nullableString('The stores the leads are from'),
      total_in_list: { type: ['integer', 'null'], description: 'How many leads the stores list in total' },
      leads: { type: 'array', items: { type: 'object' } },
      customers: { type: 'array', items: { type: 'object' } },
      vehicles: { type: 'array', items: { type: 'object' } },
      appointments: { type: 'array', items: { type: 'object' } },
      tasks: { type: 'array', items: { type: 'object' } },
      trade_vehicles: { type: 'array', items: { type: 'object' } },
      customer_notes: { type: 'array', items: { type: 'object' } },
      unavailable: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
    required: ['dealership', 'total_in_list', 'leads', 'customers', 'vehicles', 'appointments', 'tasks', 'trade_vehicles', 'customer_notes', 'unavailable', 'notes'],
  },
};

// Tekion repair-order export, as the SOP describes it (lib/tekion-ro-run.ts). The user signs in; the run
// drives the screens with a visible cursor and saves the Excel files to Downloads.
const TEKION_RO: Flow = {
  dms: 'tekion',
  dmsName: 'Tekion',
  title: 'Tekion repair-order export',
  summary:
    'Opens Tekion. Sign in yourself; then the extension opens Services > Repair Order and downloads the Excel file(s) of every repair order, using date filters when Tekion limits a file. It only downloads.',
  startUrl: 'https://app.tekioncloud.com/home',
  allowedHosts: ['tekioncloud.com'],
  allow: { urls: ['https://app.tekioncloud.com/home'], clicks: PAGING },
  goal: 'Export the Tekion repair orders to Excel (collected by lib/tekion-ro-run.ts, not by the model).',
  result: {
    properties: {
      exports: { type: 'array', items: { type: 'object' } },
      unavailable: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['exports', 'unavailable', 'summary'],
  },
};

export const FLOWS: Record<DmsId, Flow> = { tekion: TEKION_RO, vinsolutions: VINSOLUTIONS, cdk: CDK_ELEAD, dealr: DEALR };
export const DEFAULT_DMS: DmsId = 'tekion';

/** The flow for a DMS id from the FE (case-insensitive), or undefined if it isn't supported. */
export function flowFor(dms: unknown): Flow | undefined {
  if (typeof dms !== 'string') return undefined;
  const id = dms.trim().toLowerCase();
  return id && Object.hasOwn(FLOWS, id) ? FLOWS[id as DmsId] : undefined;
}
