// The two questions the mapping agent asks the LLM:
//   classifyPages  what each explored page shows (one record, a list, other) and which kind of data
//   mapView        where, in one view of a page, each piece of data sits
// and, for CRMs that navigate by clicks instead of links:
//   chooseClicks   what the screen shows and what to click next to reach the lists
//   mapColumns     which field each column of a data grid holds
// The LLM only points at elements (by snapshot id). The agent turns those
// picks into selectors and checks them itself.
import OpenAI from 'openai';
import { HttpError } from '../errors.js';
import { DATASETS, DATASET_IDS, datasetById, datasetsFrom } from '../../../extension/lib/mapper/datasets.js';

const pick = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'mid', 'value', 'attr', 'regex'],
  properties: {
    key: { type: 'string' },
    mid: { type: 'integer', description: 'Snapshot id of the element holding the value.' },
    value: { type: 'string', description: 'The value exactly as shown on this page.' },
    attr: { type: 'string', description: 'Attribute holding the value, or "" when it is the element text.' },
    regex: { type: 'string', description: 'JavaScript regex with ONE capture group when the element holds more than the value, else "".' },
  },
};

const VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_target', 'summary', 'sections', 'fields', 'collections'],
  properties: {
    is_target: { type: 'boolean', description: 'Whether this view is the kind of page the request describes.' },
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['mid', 'name', 'kind', 'is_open'],
        properties: {
          mid: { type: 'integer' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['tab', 'expander'] },
          is_open: { type: 'boolean', description: 'Its content is visible right now.' },
        },
      },
    },
    fields: { type: 'array', items: pick },
    collections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'container_mid', 'item_mids', 'item_fields'],
        properties: {
          name: { type: 'string' },
          container_mid: { type: 'integer' },
          item_mids: { type: 'array', items: { type: 'integer' } },
          item_fields: { type: 'array', items: pick },
        },
      },
    },
  },
};

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pages'],
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'kind', 'dataset', 'entity'],
        properties: {
          index: { type: 'integer' },
          kind: { type: 'string', enum: ['record', 'list', 'other'] },
          dataset: { type: 'string', enum: [...DATASET_IDS, 'message', 'other'], description: 'The kind of data ONE item of the page is.' },
          entity: {
            type: 'string',
            description: 'What the CRM calls one item, in one lowercase word: contact, lead, customer, user, employee, member, account, company, vendor, opportunity, deal, appointment, meeting, task, vehicle, email, call, note, case, invoice, project, product, report, other.',
          },
        },
      },
    },
  },
};

// The field keys suggested to the model depend on the kind of data being
// mapped: see extension/lib/mapper/datasets.js.
export const FIELD_KEYS = DATASETS.customers.fieldKeys;

const CLICKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['screen', 'clicks'],
  properties: {
    screen: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'dataset', 'title'],
      properties: {
        kind: { type: 'string', enum: ['list', 'record', 'menu', 'other'] },
        dataset: { type: 'string', enum: [...DATASET_IDS, 'other'], description: 'For a list or a record: the kind of data ONE item is.' },
        title: { type: 'string', description: 'What the CRM calls this screen, a few words (e.g. "Active prospects", "Users").' },
      },
    },
    clicks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'toward'],
        properties: {
          id: { type: 'integer', description: 'The id of a clickable element from the input.' },
          toward: { type: 'string', enum: [...DATASET_IDS, 'other'], description: 'The kind of data this click should lead to.' },
        },
      },
    },
  },
};

const COLUMNS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['columns'],
  properties: {
    columns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'key'],
        properties: {
          index: { type: 'integer', description: 'The column number from the input.' },
          key: { type: 'string', description: 'snake_case field key, or "" to leave the column out.' },
        },
      },
    },
  },
};

const clicksPrompt = (datasets) => `You explore a web CRM that has no links: its address never changes and moving around means clicking tiles, menu entries and tabs. A program clicks for you and saves the path, so it can come back later without AI.

Goal: reach every screen that LISTS one of these kinds of data (a table or grid with one row per item):
${datasets.map((d) => `- ${d.id}: ${d.description}`).join('\n')}

Input: the clicks made so far, the kinds whose list was already reached, the text now on screen, and what can be clicked: [id] role "caption" (+ open/closed for menu groups, selected for the current entry).

Return:
- screen: what is showing NOW. kind "list" only when a table or grid of items is visible (even with no rows); "record" for one item in full; "menu" for a launcher, a menu or a navigation page; "other" for dashboards, settings, forms. dataset: for a list or record, the kind of data ONE row/item is (users = the CRM's own logins/employees; customers = people the business deals with; deals = sales in progress; "other" when it is none of the kinds above).
- clicks: up to 6 ids worth clicking next, best first, each a step toward a list not reached yet:
  - an application tile that opens the CRM itself; a closed menu group (Prospects, Customers, Sales, Organizer, Admin, Setup, Users...); an entry that names a list ("All", "Active", "Sold", "Search", "Users", "Employees", "Appointments", "Tasks", "Inventory"...).
  - Several entries of one group that are different lists of the same kind (Active, Inactive, Sold) are all worth it.
  - NEVER pick something that creates, edits, deletes, sends, imports, exports, prints, signs out or changes settings ("Add", "New", "Create", "Wizard", "Save", "Delete", "Send", "Log out", "Preferences"); never help, support ("Customer Care", "Resource Center"), training ("University"), marketing or product-news tiles; never the signed-in user's own menu (an avatar or their initials such as "TS", "My profile", "Account"), notifications, an app switcher grid or a search box; never a column header, a filter, a pager, a row of the list, or the entry already selected.
  - [] when nothing here leads toward a missing list.`;

const COLUMNS_PROMPT = (dataset) => `A data grid in a CRM lists ${dataset.description}. You name its columns so a program can save each row as a record.

Input: the column headers by number, and a few example rows.
Return one entry per column: its number and a snake_case key. Use these keys when they fit: ${dataset.fieldKeys}; otherwise make one from the header ("Activity Date" -> activity_date). A name column holding "Last, First" or a full name is full_name. Return key "" for columns that hold no data about the item (checkboxes, icons, action buttons, row numbers). Each key once.`;

const SNAPSHOT_FORMAT =
  'Input: a simplified DOM, one element per line: [id] tag#id.classes[attributes] "own text". Indentation shows nesting. Several frames may be listed; ids are unique across them.';

const PICK_RULES = `  - mid: the element holding the VALUE, never the label element.
  - value: the value exactly as shown.
  - attr: "" unless the value exists only in an attribute.
  - regex: "" when the element text is exactly the value. Otherwise a JavaScript regex with ONE capture group that extracts the value from the element's full text, written to work for other records too (e.g. text "Plano, TX 75024": city "^([^,]+),", state ",\\s*([A-Z]{2})\\b", zip "(\\d{5}(?:-\\d{4})?)\\s*$"; text "DOE, JOHN": last_name "^([^,]+),", first_name ",\\s*(.+)$").
  - Each key once. Only use ids that appear in the input.`;

// The record prompt is built per kind of data: what counts as the record,
// which field keys to prefer, and what the other kinds are (so a page of
// another kind is turned down instead of being mapped as this one).
const recordPrompt = (dataset) => `You map where data about ${dataset.description} sits on a CRM web page, so a program can extract it later without AI.

${SNAPSHOT_FORMAT}

Return:
- is_target: true if this view shows ${dataset.recordHint}. A page listing many of them is NOT a target. A page that is really one of these other kinds is NOT a target either: ${Object.values(DATASETS)
  .filter((d) => d.id !== dataset.id)
  .map((d) => d.plural)
  .join(', ')}.
- summary: a few words describing the view.
- sections: ONLY when the request asks for them, otherwise []. Clickable tabs, section headers or "show more" controls inside this record that reveal other information about the same record (contact details, texts/SMS, emails, calls, notes, history, activities...). kind "tab" switches the content; kind "expander" opens a collapsed section in place. is_open: the section's content is visible right now. Exclude global navigation that leaves the record, actions (edit, save, send, delete, create, log out) and pagination.
- fields: single values of this record. Use these keys when they fit: ${dataset.fieldKeys}; otherwise a short snake_case key from the page label (e.g. website, timezone, language).
${PICK_RULES}
  - ${dataset.rules}
- collections: repeated entries about this record: text messages/SMS, emails, chats, calls, notes, activities, history.
  - name: text_messages, emails, chat_messages, calls, notes, activities, or history / communications for a mixed list.
  - container_mid: the element wrapping all entries. item_mids: 2-4 example entries, of different kinds when the list mixes them; each id is the element wrapping ONE whole entry, and all entries share the same tag. Skip lists with no entries.
  - item_fields: the values found in the example entries, using keys timestamp, direction, sender, recipient, subject, body, channel, status, duration, outcome, author. Take each key from an example entry that has it. Same mid/value/attr/regex rules; the mid must be inside that example entry, or the entry itself when the value is in its attribute (e.g. data-direction, or a class naming inbound/outbound or the channel: use attr "class").`;

const MESSAGE_PROMPT = `You map where the details of ONE message sit on a CRM web page, so a program can extract them later without AI. The message is an email, text/SMS, chat, call log or note from a customer's history, shown on its own page.

${SNAPSHOT_FORMAT}

Return:
- is_target: true if this view shows one message/email/call/note with its content. A customer record or a list of messages is NOT a target.
- summary: a few words describing the view.
- sections: [] (do not list tabs).
- fields: the message's values, using keys: subject, body (the full text of the message, as one value), timestamp, sender, recipient, direction, channel, status, duration, outcome, author, related_to.
${PICK_RULES}
  - For body pick the element whose text is the whole message text (the smallest element containing all of it).
- collections: [] unless the page shows a thread of several messages (then one collection named thread with item_fields as above).`;

const classifyPrompt = (datasets) => `You classify pages explored in a CRM.
kind:
- record: the page shows ONE item in full (a customer/contact/lead/user profile, one opportunity, one appointment, one task, one vehicle, one email...).
- list: the page lists many items of one kind (a table or list of contacts, users, opportunities, appointments, tasks, vehicles, emails...). A page with a small list of recent items among other widgets (a dashboard) is "other".
- other: dashboards, calendars shown as a grid, reports, settings, sign-in, blank pages.
dataset: the kind of data ONE item of the page is:
${datasets.map((d) => `- ${d.id}: ${d.description} (${d.hint}).`).join('\n')}
- message: one email, text/SMS, call log, chat or note (an entry of somebody's history).
- other: anything else (companies/accounts, invoices, products, cases, campaigns, reports, settings...).
Tell the CRM's OWN people (users) apart from the people the business deals with (customers): logins, roles, permissions and "last login" mean users. A "lead" that is a person with contact details is customers; a lead/opportunity that is a sale in progress (stage, amount, source, vehicle) is deals.
entity: what the CRM itself calls ONE item on the page, in one lowercase word (contact, lead, customer, user, employee, opportunity, deal, appointment, meeting, task, vehicle, email, call, note, account, case, invoice, product, report, other).
Return every page index once.`;

export function createMapperLLM({ apiKey, model }) {
  const client = new OpenAI({ apiKey, timeout: 180_000, maxRetries: 1 });

  async function ask(name, schema, system, user) {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      });
    } catch (error) {
      if (error instanceof OpenAI.APIError) throw new HttpError(502, `OpenAI request failed (${error.status ?? 'network'}): ${error.message}`);
      throw error;
    }
    const message = completion.choices[0]?.message;
    if (message?.refusal) throw new Error(`The model declined: ${message.refusal}`);
    return JSON.parse(message?.content ?? '{}');
  }

  return {
    model,
    // pages: [{ url, title, text, rowGroups: [{ count, shape }] }]
    classifyPages(pages, { datasets = DATASET_IDS } = {}) {
      const kinds = datasetsFrom(datasets);
      const list = pages
        .map((p, i) => {
          const lists = (p.rowGroups ?? []).map((g) => `${g.urls.length} links to ${g.shape}`).join('; ');
          return `#${i} ${p.url}\ntitle: ${p.title}${lists ? `\nrepeated row links: ${lists}` : ''}\ntext: ${p.text.slice(0, 700)}`;
        })
        .join('\n\n');
      return ask('page_kinds', CLASSIFY_SCHEMA, classifyPrompt(kinds.length ? kinds : Object.values(DATASETS)), list);
    },
    // A screen of a click-driven CRM: what it shows and what to click next.
    // clickables: [{ id, text, role, expanded, selected, area, frame }]
    chooseClicks({ datasets = DATASET_IDS, path = [], found = [], text = '', clickables = [] }) {
      const kinds = datasetsFrom(datasets);
      const lines = clickables.map(
        (c) => `[${c.id}] ${c.role}${c.area ? ` in ${c.area}` : ''} ${JSON.stringify(c.text)}${c.expanded === true ? ' (open)' : c.expanded === false ? ' (closed)' : ''}${c.selected ? ' (selected)' : ''}`,
      );
      const user = [
        `CLICKS SO FAR: ${path.length ? path.map((p) => JSON.stringify(p)).join(' > ') : '(none: the start page)'}`,
        `LISTS ALREADY REACHED: ${found.length ? found.join(', ') : 'none'}`,
        `TEXT ON SCREEN:\n${text.slice(0, 3500)}`,
        `CLICKABLE:\n${lines.join('\n')}`,
      ].join('\n\n');
      return ask('next_clicks', CLICKS_SCHEMA, clicksPrompt(kinds.length ? kinds : Object.values(DATASETS)), user);
    },
    // The columns of a grid: headers ["Customer", …], rows [[cell, …], …].
    mapColumns({ dataset = 'customers', headers = [], rows = [] }) {
      const user = `COLUMNS:\n${headers.map((h, i) => `${i}: ${JSON.stringify(h)}`).join('\n')}\n\nEXAMPLE ROWS:\n${rows.map((r) => r.map((c, i) => `${i}=${JSON.stringify(String(c).slice(0, 60))}`).join('  ')).join('\n')}`;
      return ask('grid_columns', COLUMNS_SCHEMA, COLUMNS_PROMPT(datasetById(dataset) ?? DATASETS.customers), user);
    },
    // mode "record" (one record of the kind named by target, a dataset id) or
    // "message" (one email/call/note page).
    mapView(frames, { label, askSections = false, mode = 'record', nudge = '', target = 'customers' }) {
      const body = frames.map((f) => `=== FRAME ${f.index}: ${f.url}\n${f.text}`).join('\n\n');
      const request = askSections
        ? 'Map every field and every list visible in this view, AND list the sections (tabs/expanders) of this record.'
        : 'Map every field and every list visible in this view. Return sections as [].';
      const system = mode === 'message' ? MESSAGE_PROMPT : recordPrompt(datasetById(target) ?? DATASETS.customers);
      return ask('view_map', VIEW_SCHEMA, system, `VIEW: ${label}\n${request}${nudge ? `\n${nudge}` : ''}\n\n${body}`);
    },
  };
}
