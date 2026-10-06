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

## Files

Written to `Downloads/<folder>/` (default `SpyneLeads`), rewritten on every save:

| File | One row per | Key columns |
|---|---|---|
| `leads_<kind>_<date>.csv` (`customers`, `users`, `deals`…) | record | `site, crm_record_id`, every field read, `messages_count, page_url, record_id` |
| `leads_messages_<date>.csv` | text / email / call / note | `customer, customer_record_id` (→ `record_id` above), `channel, timestamp, direction, sender, recipient, subject, body, duration, outcome, message_id` |
| `leads_reference_<date>.csv` | distinct value | every lead source, status, salesperson… seen, with counts |

Re-running the same day updates existing rows (same `crm_record_id`) instead of duplicating them; messages already saved (same `message_id`) are skipped. Everything is stored in the extension first, so a failed file write loses nothing: **Write CSV again** in the capture window, or **Settings → Saved days**.

## The layouts

`extension/config/crm-structures.json` holds one entry per CRM, matched by host. Each entry lists its page types with a `role`:

- `list`: a page listing records (the row element, each row's link, which record page type the links lead to);
- `record`: one record (the views to open — the page as is, then each tab or collapsed panel — with a rule list per field and per message list; a list whose entries have pages of their own names that page type in `detailPageType`);
- `message`: an email, call or note on its own page (its fields, `body` included);
- `screen`: for CRMs that navigate by clicks only: the path of clicks that leads to a grid, and the grid's columns.

Rules are CSS selectors (with ` >>> ` to step into shadow roots and address-less frames), label lookups, and regexes; each field has fallbacks. A record the layout does not fully fit (a tab gone, a required field empty) is still saved with whatever was read and counted under **layout partly fit** in the window.

To add or change a CRM, edit the file and reload the extension (`chrome://extensions` → ↻). The bundled file was produced by the mapping agent of the earlier version of this project, which is kept in git history (commit "Snapshot before stripping down").

## Limits

- Caps per run: 200 pages per list, 5,000 records, 15 message pages per record; the log keeps the last 4,000 lines (the CSV holds everything).
- A list that only loads more rows when actually seen on screen, or a virtualised grid that recycles rows, is read as far as it shows.
- A CRM whose first-run screen (time-zone confirmation, announcements) hides its lists must be past that screen in your browser before capturing.
