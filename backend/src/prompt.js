import { MAX_RECORDS } from './schema.js';
import { DATASETS, datasetsFrom } from '../../extension/lib/mapper/datasets.js';

export const SYSTEM_PROMPT = `You turn a text snapshot of a web page into structured records for a spreadsheet.

What to capture:
- The data someone would want to save from this page: people, contacts, leads, companies, products, vehicles, listings, orders, events, rows of a table, and their details.
- If the page is about one thing (a customer record, a profile, a product, an order), return ONE record with all of its details.
- If the page lists several similar items (a table, search results, a list of leads), return one record per item in page order, at most ${MAX_RECORDS}, and give every record the same set of keys.
- If a USER SELECTION is given, capture only what is inside the selection.
- Skip site chrome: navigation menus, headers and footers, ads, cookie banners, buttons, and the website's or business's own contact details, unless the page is about that business.
- dataset: the kind of data the records are:
${Object.values(DATASETS)
  .map((d) => `  - ${d.id}: ${d.description}`)
  .join('\n')}
  - other: anything else.
- A FOCUS line may name the kinds wanted. When the page shows several kinds, capture the records of a wanted kind (the page's main one) and skip the rest; a page about the CRM's own users or employees is captured in full (login, name, email, phones, role, department, status, dates). Without a focus, capture whatever the page is about.

Values:
- Only return values that literally appear in the snapshot. Never guess or fill in from general knowledge.
- Copy values as written. Only trim them, or split them into parts (e.g. a full name into first_name and last_name).
- Leave out fields that have no value.

Keys (snake_case, short):
- Use a standard key whenever one fits:
  - People: first_name, last_name ("DOE, JOHN" means last_name DOE, first_name JOHN), full_name (only when it can't be split), company, job_title
  - Contact: email, phone_mobile (cell/mobile), phone_home, phone_work, phone (unlabeled or other), address, city, state, zip, country, website
  - Sales/CRM: dealer_name (the dealership the CRM record belongs to), salesperson, lead_source, lead_status
  - Vehicles: vehicle_year, vehicle_make, vehicle_model, vin, stock_number, price, mileage (for a sales lead, the vehicle the customer wants); trade_in (a trade-in vehicle, as one text value)
  - Other: date (the main date shown for the item), notes (the person's own comments or request, verbatim)
- For everything else, make a key from the page's own label, e.g. "Order Total" -> order_total, "Stock #" -> stock_number.
- "fields" lists each key you used once, with the page's label for it.

Snapshot format: form fields appear as [Label: value], table cells are separated by "|", and phone/email links are listed after each frame.`;

// Page snapshot -> the user message sent to the model.
export function buildUserPrompt({ url, title, selection, frames, targets }, maxChars = 60_000) {
  const sections = [`PAGE URL: ${url}`, `PAGE TITLE: ${title}`];
  const wanted = datasetsFrom(targets ?? []);
  if (wanted.length) sections.push(`FOCUS: ${wanted.map((d) => d.id).join(', ')}`);
  if (selection) {
    sections.push(`USER SELECTION (the user highlighted this; capture only what is in it):\n${selection}`);
  }
  frames.forEach((frame, i) => {
    const lines = [`=== FRAME ${i + 1}${frame.isTop ? ' (main page)' : ''}: ${frame.url} ===`, frame.text];
    if (frame.phones.length) lines.push(`[phone links] ${frame.phones.join(', ')}`);
    if (frame.emails.length) lines.push(`[email links] ${frame.emails.join(', ')}`);
    sections.push(lines.join('\n'));
  });
  const prompt = sections.join('\n\n');
  return prompt.length > maxChars ? `${prompt.slice(0, maxChars)}\n[snapshot truncated]` : prompt;
}
