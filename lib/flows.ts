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

export type DmsId = 'tekion' | 'vinsolutions';

const nullableString = (description: string) => ({ type: ['string', 'null'], description });

/** Paging controls: the only clicks a list-reading flow needs. */
const PAGING =
  /^(next|previous|prev|next page|previous page|first page|last page|go to (the )?(next|previous|first|last) page|page \d{1,4}|go to page \d{1,4}|\d{1,4}|[‹›«»<>]|load more|show more)$/i;

const TEKION: Flow = {
  dms: 'tekion',
  dmsName: 'Tekion',
  title: 'Tekion repair orders',
  summary:
    "Opens your Tekion repair-order list, waits for you to sign in if needed, and reads the repair orders on it. It only reads: it pages and scrolls, and blocks edits and saves.",
  startUrl: 'https://app.tekioncloud.com/ro/repair-orders/ro-list',
  allowedHosts: ['tekioncloud.com', 'tekion.com'],
  allow: { urls: ['https://app.tekioncloud.com/ro/repair-orders/ro-list'], clicks: PAGING },
  goal: `Read the repair orders (ROs) in this dealership's Tekion RO list.
- Make sure the user is signed in first. If not, hand over with wait_for_user. If Tekion asks which dealership or site to use after sign-in, ask the user to pick it, also with wait_for_user.
- Use the list as it opens, with its default filters and sort. Do not change filters, open an RO for editing, or click anything that changes an RO.
- Read the table with read_page. If the list loads more rows as you scroll, or has pages, collect up to 50 ROs, scrolling or paging as needed, and say in notes if there were more.
- Copy values as shown (dates, amounts). If a column isn't shown or this account can't see it, leave that field null for every RO and list the column under unavailable.
- Read only. When you have them, call submit_result.`,
  result: {
    properties: {
      dealership: nullableString('The dealership or site the list is for, as shown in the app'),
      total_in_list: { type: ['integer', 'null'], description: 'How many ROs the list says it has, if it shows a count' },
      repair_orders: {
        type: 'array',
        description: 'The ROs read, in list order',
        items: {
          type: 'object',
          properties: {
            ro_number: { type: 'string' },
            status: nullableString('As shown, e.g. Open, In Progress, Ready, Closed'),
            customer: nullableString('Customer name'),
            vehicle: nullableString('Year, make and model'),
            vin: nullableString('Vehicle identification number'),
            advisor: nullableString('Service advisor'),
            opened: nullableString('Date or time opened, as shown'),
            promised: nullableString('Promised date or time, as shown'),
            total: nullableString('RO total, as shown'),
          },
          required: ['ro_number', 'status', 'customer', 'vehicle', 'vin', 'advisor', 'opened', 'promised', 'total'],
          additionalProperties: false,
        },
      },
      unavailable: { type: 'array', items: { type: 'string' }, description: "Columns or areas this account couldn't see" },
      notes: { type: 'string', description: 'Anything else worth knowing (e.g. more ROs than were read), or an empty string' },
    },
    required: ['dealership', 'total_in_list', 'repair_orders', 'unavailable', 'notes'],
  },
};

// The first step every VinSolutions (Cox Automotive CRM) flow needs: who is signed in, where.
const VINSOLUTIONS: Flow = {
  dms: 'vinsolutions',
  dmsName: 'VinSolutions',
  title: 'VinSolutions account check',
  summary:
    "Opens VinSolutions, waits for you to sign in if needed, and reads which user and dealership you're signed in as. It only reads.",
  startUrl: 'https://vinsolutions.signin.coxautoinc.com/',
  allowedHosts: ['coxautoinc.com', 'vinsolutions.com', 'vinmanager.com'],
  allow: { urls: ['https://vinsolutions.signin.coxautoinc.com/'], clicks: PAGING },
  goal: `Find out which VinSolutions user and dealership this browser is signed into.
- Make sure the user is signed in first. If not, hand over with wait_for_user.
- If the account can switch between several dealerships, report the active one and list the others you can see. Do not switch.
- Read only. Do not create, edit, send or delete anything.
- When you have the answer, call submit_result.`,
  result: {
    properties: {
      signed_in: { type: 'boolean' },
      user_name: { type: ['string', 'null'], description: 'Name of the signed-in user as shown in the app' },
      dealership: { type: ['string', 'null'], description: 'Active dealership (rooftop)' },
      other_dealerships: { type: 'array', items: { type: 'string' }, description: 'Other dealerships this user can switch to' },
      unavailable: { type: 'array', items: { type: 'string' }, description: "Things this account couldn't access" },
      notes: { type: 'string', description: 'Anything else worth knowing, or an empty string' },
    },
    required: ['signed_in', 'user_name', 'dealership', 'other_dealerships', 'unavailable', 'notes'],
  },
};

export const FLOWS: Record<DmsId, Flow> = { tekion: TEKION, vinsolutions: VINSOLUTIONS };
export const DEFAULT_DMS: DmsId = 'tekion';

/** The flow for a DMS id from the FE (case-insensitive), or undefined if it isn't supported. */
export function flowFor(dms: unknown): Flow | undefined {
  if (typeof dms !== 'string') return undefined;
  const id = dms.trim().toLowerCase();
  return id && Object.hasOwn(FLOWS, id) ? FLOWS[id as DmsId] : undefined;
}
