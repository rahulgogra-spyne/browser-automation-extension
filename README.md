# Spyne CRM Capture

A Chrome extension with one job: **Capture whole CRM**. For a CRM whose layout it knows, it walks every mapped list page after page, opens every record in a work tab, reads its fields and message history (texts, emails, calls, notes) with the saved rules, writes every value it read to the log in the capture window, and saves the rows to daily CSV files in your Downloads folder as it goes.

No server, no AI, no credentials: it runs in your own signed-in browser.

```
extension/
  manifest.json
  background.js              the capture: lists -> records -> message pages -> CSV
  config/crm-structures.json the CRM layouts (where each list, record, tab, field and message list is)
  content/crm-runtime.js     in-page runtime: follows the rules, opens tabs/panels, pages lists
  content/mark-handlers.js   marks script-attached click handlers so the runtime can press them
  console/                   the capture window: pick a CRM, progress, counts, the log, today's files
  options/                   settings: your name, dealership, download folder, file prefix; saved days
  lib/                       rows, messages, CSV, duplicates, storage, paging, dates
```

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick the `extension/` folder.

## Use

1. Sign in to the CRM in Chrome and open it.
2. Click the extension icon: the **capture window** opens. Its top card names the CRM tab you are on and, when a layout is bundled for it, offers **Capture whole CRM**. You can also pick any bundled CRM from the drop-down.
3. Press **Capture whole CRM**. The CRM pages load one after another in the tab next to the window. The window shows:
   - progress, time elapsed and the counts (found, captured, saved, messages, failed);
   - **Captured in this run**: one line per record;
   - the **log**, with every field and every message of every record as it was read, e.g.

     ```
     13:07:19  Captured John Doe (customers): 14 fields, 8 messages — http://…/customer?GlobalCustomerID=1001
                 full_name: John Doe
                 email: john.doe@example.com
                 phone_mobile: (214) 555-0147
                 lead_status: Active - Working
                 [emails 1] 09/21/2026 10:34 AM · Outbound · Mike Ross — Your Camry XSE quote — Hi John, attached is…
                 [text messages 1] 09/21/2026 10:14 AM · inbound · John Doe — Hi, is the Camry XSE still available?
     13:07:28  Saved 5 record(s) → SpyneLeads/leads_customers_2026-10-06.csv, SpyneLeads/leads_messages_2026-10-06.csv
     ```

     **Save log** writes the log to a text file. Long values are cut at 300 characters in the log only; the CSV has them whole.
4. Records are saved every 10 and at the end. **Cancel** stops the run; what was saved stays.

### Screens that show nothing until you press Search

Many CRM list screens (CDK Unify's Prospect Search, for one) are empty until a search is run. Two ways to handle them:

- **Capture whole CRM** does it by itself where it can: after replaying the screen's menu clicks it runs the screen's `load` steps (if the layout has any), and when the grid still shows no rows it presses the **Search / Find / Go / Show / Apply / Load** button on screen (never a Create / Edit / Delete), waits, then **learns the grid on screen** from its column headers (no AI) and reads it page after page. The learned grid is remembered for the next run. The log says what happened: `pressed "Search" to load the data`, `learned the grid on screen: 10 rows, columns full_name, email, …`.
- **Capture this tab** is for everything else: open the list yourself in the CRM (menus, filters, Search), then press **Capture this tab** in the capture window. The top card tells you what it sees (`a grid with 25 rows (looks like customers: Name, Email, Cell…)`, or `no data grid yet, but a "Search" button`). It learns the grid, reads it in that tab page after page (don't use the tab meanwhile), and saves. Pick the kind of data in the drop-down next to the button, or leave it on auto-detect. Rows that link into a record page the layout knows are read from their pages, with fields and message history.

### Several dealerships / stores / accounts in one CRM

A CRM login often covers several dealerships, rooftops or accounts whose data is separate, switched with a drop-down in the header (or a "Dealer"/"Store" filter beside the search). On every screen, and on **Capture this tab**, the extension looks for such a switcher: a `<select>` or menu whose caption says dealer / dealership / store / rooftop / location / branch / account / company…, or whose entries read like dealership names. When it finds one it logs `Found 3 stores/dealers ("Dealership"): Sunrise Toyota · Lakeside Honda · Metro Ford` and reads the screen **once per store**: switch, get back to the screen, run its search again, read every page. Each store's rows go to **their own files** (`leads_customers_sunrise-toyota_<date>.csv`, `leads_messages_sunrise-toyota_<date>.csv`…) and carry the store in a `store` column; duplicates are judged within a store.

To steer it, a CRM entry in the layout can set `"stores"`:

- `false`: never switch stores;
- `{ "select": { "css": "#dealerSelect" } }` or `{ "menu": { "control": { "css": "button.store-switcher", "text": "Sunrise Toyota" } } }`: use this switcher;
- `{ "only": ["Sunrise Toyota", "Metro Ford"] }`: capture these stores only.

## Files

Written to `Downloads/<folder>/` (default `SpyneLeads`), rewritten on every save:

| File | One row per | Key columns |
|---|---|---|
| `leads_<kind>[_<store>]_<date>.csv` (`customers`, `users`, `deals`…) | record | `site, store, crm_record_id`, every field read, `messages_count, page_url, record_id` |
| `leads_messages[_<store>]_<date>.csv` | text / email / call / note | `store, customer, customer_record_id` (→ `record_id` above), `channel, timestamp, direction, sender, recipient, subject, body, duration, outcome, message_id` |
| `leads_reference[_<store>]_<date>.csv` | distinct value | every lead source, status, salesperson… seen, with counts |

`_<store>` is present when the rows came from one store of a multi-store CRM.

Re-running the same day updates existing rows (same `crm_record_id`) instead of duplicating them; messages already saved (same `message_id`) are skipped. Everything is stored in the extension first, so a failed file write loses nothing: **Write CSV again** in the capture window, or **Settings → Saved days**.

## The layouts

`extension/config/crm-structures.json` holds one entry per CRM, matched by host. Each entry lists its page types with a `role`:

- `list`: a page listing records (the row element, each row's link, which record page type the links lead to);
- `record`: one record (the views to open — the page as is, then each tab or collapsed panel — with a rule list per field and per message list; a list whose entries have pages of their own names that page type in `detailPageType`);
- `message`: an email, call or note on its own page (its fields, `body` included);
- `screen`: for CRMs that navigate by clicks only: the `path` of clicks that leads to a grid, optional `load` steps to run there, and the grid (`table`; `null` to learn it on screen). Load steps: `{ "click": { "text": "Search" } }`, `{ "fill": { "label": "Last name", "value": "%" } }` (or `"css"` instead of `"label"`; add `"enter": true` to press Enter), `{ "wait": 1500 }`. Example:

  ```json
  { "id": "prospect_search_screen", "role": "screen", "entity": "Prospect Search", "dataset": "customers",
    "path": [{ "label": "CRM", "nav": { "css": "div.bPuebU", "text": "CRM" } }, { "label": "Prospects", "nav": { "text": "Prospects" } }, { "label": "Active", "nav": { "text": "Active" } }],
    "load": [{ "fill": { "label": "Last name", "value": "%" } }, { "click": { "text": "Search" } }],
    "table": null }
  ```

  A `nav` step needs only `text` (the caption); `css` narrows it when two things share a caption. Column headers become row keys (`Name` → `full_name`, `Cell` → `phone_mobile`, `Stock #` → `stock_number`, anything else slugified).

Rules are CSS selectors (with ` >>> ` to step into shadow roots and address-less frames), label lookups, and regexes; each field has fallbacks. A record the layout does not fully fit (a tab gone, a required field empty) is still saved with whatever was read and counted under **layout partly fit** in the window.

To add or change a CRM, edit the file and reload the extension (`chrome://extensions` → ↻). The bundled file was produced by the mapping agent of the earlier version of this project, which is kept in git history (commit "Snapshot before stripping down").

## CDK Unify (`app-unify.app.connectcdk.com`)

The bundled entry matches `app-unify.app.connectcdk.com` and `crm.connectcdk.com`. Its screens start from the launcher (`/applications`), press the **CRM** card (which opens the CRM in a new tab; the capture follows it in its work tab), then the menu entries: **Vehicle Search** (inventory grid, read as is) and **Prospects → Active** / **Prospects** (empty until **Search** is pressed: the capture presses it, learns the results grid from its headers, and reads it page after page). If the account has several dealerships, the dealership switcher in the CRM's header is used and each dealership is captured to its own files.

If a screen does not come out right, open it yourself in the CRM with the filters you want and use **Capture this tab**; the log says what was found (`Found N stores…`, `pressed "Search"…`, `learned the grid…`), and the `path` / `load` / `stores` settings of the entry can be tuned from that. **Describe this tab** writes to the log what the extension sees on the open CRM tab — every frame with its grids (columns, row count, first row), the Search button it would press, store switcher candidates, selects and buttons — which is what to send when a screen comes out wrong. A capture also writes that report by itself when a menu step is not found or a screen shows no grid.

A grid that reads only a few rows with most columns empty (a search-criteria form laid out as a table, or a grid not loaded yet) is treated as not loaded: Search is pressed and the better reading kept. Rows made mostly of input boxes are never taken for data.

## Limits

- Caps per run: 200 pages per list, 5,000 records, 15 message pages per record; the log keeps the last 4,000 lines (the CSV holds everything).
- Store switching is done on screens (click-driven lists) and on Capture this tab; URL-based lists of a multi-store CRM are read for the store the browser is on.
- A list that only loads more rows when actually seen on screen, or a virtualised grid that recycles rows, is read as far as it shows.
- A CRM whose first-run screen (time-zone confirmation, announcements) hides its lists must be past that screen in your browser before capturing.
