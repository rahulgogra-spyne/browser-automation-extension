# Spyne Lead Capture

A Chrome extension that captures people data from CRMs (and any other web page) into daily CSV files: names, logins, phones, emails, roles, plus any text, email, call and note history shown with them.

**What to capture** is a setting (Settings → *What to capture*): by default the CRM's **internal users, agents and employees** (its Users / Team / Employees pages: login, name, email, phone, job title, role, department, status, last login…); or its **customers, contacts and leads**. The mapping agent looks for the pages of that kind only, and the AI fallback is told to focus on them. Each CRM keeps the target it was mapped with; to switch a CRM, change the setting and map it again.

Most captures use no AI. A **mapping agent** explores each CRM once and learns where each piece of data lives: it dives from the lists it finds into the records behind their links, opens every tab and collapsed panel of a record, and follows message rows to the pages that hold their bodies. It writes what it learns to one **CRM structure config** file on the server. The extension follows those saved rules directly in the page, and on any page that links to mapped records it can capture every one of them.

The agent runs **inside the extension**, in the user's own signed-in browser: open the CRM, click **Map this CRM** in the popup, and it explores in background tabs with your session while the server only answers the LLM questions and stores the result. No credentials are configured anywhere. (For CRMs the server holds credentials for, the same agent can run server-side in Playwright.) Layouts are re-mapped daily and whenever the rules stop fitting a page, which the extension detects and reports. Pages the config doesn't know are read by AI.

```
   extension (the user's signed-in browser)                 backend (holds the OpenAI key)
   ┌──────────────────────────────────────────────┐        ┌──────────────────────────────────┐
   │ mapping agent ── background tabs ──▶ CRM     │        │  /api/mapper/classify, map-view  │
   │   explores: list rows ▶ records ▶ message    │──LLM──▶│     (the two LLM questions)      │
   │   pages; builds CSS/label rules from the     │        │                                  │
   │   LLM's picks; replays them on a 2nd record  │──save─▶│  config/crm-structures.json      │
   └──────────────────────────────────────────────┘        └──────────────┬───────────────────┘
           ▲ daily alarm / failure reports                                │ GET /api/config
           │                                                              ▼
   extension: click ─▶ known CRM page? ── record ─▶ follow the saved rules in the page (tabs, panels,
                           │                        fields, message lists, each message's own page)
                           │              ── list, dashboard, anything linking to records ─▶
                           │                        "Capture all N": each record in a background tab
                           │                          │ didn't fit? report it, use AI once
                           no ─▶ AI extraction ◀──────┘
                                     │
                           popup: review ─▶ Save ─▶ leads_<date>.csv + leads_messages_<date>.csv
```

## What's in the repo

```
extension/                 Chrome MV3 extension (plain JS modules, no build step)
  background.js            capture flow: saved layout -> fallback -> save -> CSVs
  content/crm-runtime.js   in-page runtime: snapshots, selectors, rules, tabs/expanders, links, lists
  lib/mapper/agent.js      THE mapping agent (explore -> classify -> map records, message pages, lists -> validate -> save),
                           written against a browser adapter so it runs here and on the server
  lib/mapper/targets.js    what to capture: internal users/agents/employees, or customers/contacts/leads (entities, link words, field keys)
  lib/mapper/chrome-adapter.js   the adapter over background tabs in the user's browser
  lib/mapper/remote.js     the LLM and config store as seen from the extension (server endpoints)
  content/snapshot.js      page -> compact text for AI extraction (redacts SSN/card numbers)
  lib/crm-config.js        match a page to a CRM + page type; judge whether an extraction worked
  lib/capture.js           popup records -> customer rows + message rows
  lib/messages.js          message history rows (channel, direction, sender, body...)
  lib/                     columns, normalisation, CSV, duplicates, storage, settings
  popup/  options/         review-and-save UI; settings, CRM layouts, saved days
  console/                 the capture window: follows mappings and whole-CRM captures, starts them, lists results
backend/
  config/crm-sites.json    CRMs the agent maps: hosts, start page, sign-in steps
  config/crm-structures.json   THE CRM structure config (generated; mapped from the mocks)
  src/mapper/agent.js      the shared agent run server-side in Playwright (for CRMs with configured credentials)
  src/mapper/llm.js        the two LLM questions (what each page shows; where the data is), also served to the extension
  src/mapper/browser.js    Playwright: launch installed Chrome/Edge, sign in from configured steps, adapter for the agent
  src/mapper/jobs.js       one-at-a-time job queue, daily schedule, failure re-maps, cooldown
  src/mapper/cli.js        npm run map
  src/crm/                 config store (versioned, atomic writes), URL patterns, site registry
  src/app.js               /api/extract (AI), /api/config, /api/extraction-failures, /api/mapper/*
mock-crms/                 dummy CRMs with fake data, shaped like VinSolutions, CDK eLeads and a SugarCRM-family CRM (with a Users module)
scripts/poc-e2e.mjs        full proof of concept: map, capture all, simulate a CRM release
scripts/extension-e2e.mjs  the same loop through the real extension loaded in Edge
tests/                     unit tests; tests/browser: runtime tests in a real headless browser
```

## Quick start (with the mock CRMs)

The short version for a real CRM: start the backend, load the extension, open the CRM you are signed in to, click the icon, click **Map this CRM**, wait 2–4 minutes. From then on the popup reads records and lists with the saved layout.

You need Node 22.9+ and Chrome or Edge.

```bash
npm run mock-crms                    # VinSolutions-style :4101, CDK-style :4102, SugarCRM-family :4103, Drawer CRM :4104
cd backend && npm install && npm start
```

Then load the extension:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `extension/`.
3. In **Settings**, set the server API key if `EXTENSION_API_KEY` is set.

**Try it:**

1. Open `http://localhost:4103/app/` (press Save on its one-time time-zone screen), click the extension icon and then **Map this CRM**. The popup shows the stages (exploring, working out which pages show people, mapping a record and its sections, message pages, lists, checking on a second record, saving), what it is doing right now, the time elapsed and how long is left; the icon shows a **MAP** badge meanwhile, and reopening the popup brings the progress back. After about 90 seconds it reports the layout it saved (a contact record, the email page behind its History rows, the contacts list).
2. Now on the home dashboard the popup says "links to 4 contacts · saved layout v1" and offers **Capture all 4**; on a contact record it shows the fields, texts, calls and emails (with bodies fetched from each email's page); on the contacts list it offers **Capture all**.
3. **Capture whole CRM** is the main button on any page of a mapped CRM: it walks every page of every mapped people list, reads each record with the saved layout (no AI) and saves as it goes. It runs in its own **capture window**: the extension's console page as the first tab (live status, progress, every record captured, the log, today's files, Cancel) and one reusable work tab beside it where the CRM pages are loaded one after another, so no tabs pop open and vanish and nothing needs reopening. The capture window also starts mappings and captures itself (pick a mapped CRM, or paste a CRM address), and the popup has a **Capture window** link. On the mock that is all 5 contacts across the list's pages. **This page only** takes just the records linked from the current page. If no list was mapped, the whole-CRM capture first looks for the CRM's list pages itself (no AI: pages whose rows link into the mapped record type), learns and saves them, and walks them; failing that it walks onward from the listing you are on, page after page. The capture window's header shows whether the server is reachable and up to date.
   AI is used in exactly two cases: the first mapping of a CRM, and when a saved layout stops fitting. During a whole-CRM capture a failing record triggers one re-map of that page type from the browser; any record that still cannot be read with rules is read by AI so nothing is lost (the popup reports "layout re-mapped" and "N read by AI").
4. Captures read with a saved layout are **saved as they are read**: the popup confirms "Saved John Doe · 9 messages → leads_<date>.csv" and its Save button only re-arms ("Save changes") if you edit a value. Only AI-read pages (unmapped sites, or a layout that failed) wait for your review before saving.
5. The capture window follows the CRM tab you are working in: its top card names the site, says whether it is mapped, and offers **Map this CRM** or **Capture whole CRM** for it; the address box is prefilled with that tab. A finished job stays on screen until **Done**, and starting a new job clears the previous one. The two mocks on :4101 and :4102 are already mapped in the shipped config.

The CDK mock is at `http://localhost:4102/login`. Sign in as `demo.sales` / `mock-crm-2026`.

The SugarCRM-family mock (`http://localhost:4103/app/`) signs you in by itself, then shows a one-time "confirm your time zone" screen: press Save. Its contacts list (`?module=Contacts&action=index`) is a mapped list: the popup offers **Capture all 3**, opens each contact in the background, reads its panels, and fetches each email's body from the email's own page.

**Watch it repair itself:**

1. Simulate a CRM release:

   ```bash
   curl -X POST "http://localhost:4101/__admin/layout?variant=2"
   ```

2. Capture a customer. The popup says the saved layout didn't fit and that AI read the page this time. The backend log shows the re-map running.
3. About a minute later, capture again. It says "saved layout v2, no AI". **Settings → CRM layouts** shows the version history.

## The CRM structure config

`backend/config/crm-structures.json` holds one entry per CRM. Each entry lists its page types, each with a `role`:

- `record` (one person of the CRM's target: a user/employee, or a contact/lead): the views to visit (the page as opened, then each tab or collapsed panel) with a rule list for every field and message list; a list whose entries link to their own pages names that page type in `detailPageType`
- `message` (an email, call or note on its own page): its fields, `body` included
- `list` (a page listing people): the row element, each row's link and title, and the record page type the links lead to

The entry also records its `target` (`staff` or `customers`). Re-maps (daily, or of one failing page) keep it; a mapping the user asks for follows the current setting.

Abridged, real output:

```json
"vinsolutions": {
  "version": 1, "mappedAt": "…", "mappedBy": "mapper-agent (gpt-…)",
  "match": { "hosts": ["localhost:4101"] },
  "pageTypes": [{
    "id": "customer", "role": "record", "entity": "customer",
    "urlRegex": "^/vinconnect/customer\\?GlobalCustomerID=([^/?&#]+)(?=$|[?&#])",
    "frame": { "urlRegex": "^/CarDashboard/Pages/CRM/CustomerDashboard\\.aspx\\?GlobalCustomerID=…" },
    "required": ["first_name", "last_name"], "expectOneOf": ["email", "phone_mobile"],
    "views": [
      { "name": "General", "activate": { "css": "a.rtsLink", "text": "General" },
        "fields": {
          "phone_mobile": [{ "css": "#ctl00_ContentPlaceHolder1_lblCellPhone" }, { "label": "Cell Phone" }],
          "city": [{ "css": "#ctl00_ContentPlaceHolder1_lblCityStateZip", "regex": "^([^,]+)," }] } },
      { "name": "Texting", "activate": { "css": "a.rtsLink", "text": "Texting" },
        "collections": { "text_messages": {
          "container": "#ctl00_ContentPlaceHolder1_divSmsThread", "item": ":scope > div",
          "fields": { "direction": [{ "css": ":scope", "attr": "class" }], "body": [{ "css": ":scope div.sms-text" }] } } } }
    ],
    "samples": ["…?GlobalCustomerID=1001", "…?GlobalCustomerID=1002"],
    "validation": { "ok": true, "first": { "fields": 20, "collections": { "text_messages": 4 } } }
  }],
  "history": [{ "version": 1, "reason": "first mapping" }]
}
```

A list page type (from the SugarCRM-family mock), whose pattern ignores paging and sorting parameters:

```json
{ "id": "contact_list", "role": "list", "entity": "contact", "recordPageType": "contact",
  "urlRegex": "^/app/(?=[?#])(?=[^#]*[?&]module=Contacts(?:&|#|$))(?=[^#]*[?&]action=index(?:&|#|$))",
  "items": { "container": "#contacts-table", "item": ":scope > div.of-data-table-row.row-editable",
             "fields": { "link": [{ "css": ":scope a.of-link", "attr": "href" }], "title": [{ "css": ":scope a.of-link" }] } } }
```

- **The `urlRegex` capture group is the CRM's own record id.** It goes in the `crm_record_id` column, and duplicate detection uses it first.
- **Each field has fallback rules.** A stable id or `data-*` selector comes first, then the visible label. If one breaks, the other often still works.

### How the agent maps a CRM

1. **Explore.** From the extension it uses the browser's own session (server-side, it signs in with the steps in `crm-sites.json`). It then explores within the CRM's hosts, preferring record-looking URLs over menus: on every page it groups the links that sit in repeated rows (the rows of a list) and dives into a couple of them, so a list of contacts leads to contact records. Script-driven navigation (`onclick`, `data-href`) and links that open a new tab count as links. It visits two URLs per URL shape, skips paging/sorting variants, and never follows edit, create, delete, export or log-out links. Each page is read only once its content has stopped changing, so slow single-page apps are seen fully rendered.
2. **Classify.** The LLM says what each kind of page shows: one item or a list, and of what (user, employee, contact, lead, email, opportunity…), told apart by what the page shows (logins, roles, permissions, last login → the CRM's own users; deals, sources, vehicles → customers). Only pages of the target's kind go on; the others are listed in the log. Record pages whose URLs share a pattern (like a single-page app's tab routes) become one page type.
3. **Map a record.** On a person's record, the agent snapshots every frame into a compact DOM with an id per element. The LLM says which element holds each value, which elements are the entries of each message list, and which controls are tabs, collapsed panels (expanders) or tabs that lead to pages of their own (links). The agent opens every closed one (navigating there and back for link-tabs) and repeats this. Panels already open are read as they are and never toggled shut; link-tab pages are not mistaken for records of their own.
4. **Follow message rows.** When a message list's entries link to their own pages (an email whose body is on its page), the agent opens one, maps it as a `message` page type (subject, body, sender, recipient, timestamp…), and validates it on a second entry.
5. **Map the lists.** On a page that lists people, it learns the row element and each row's link to the record page type. Lists are the pages the LLM calls lists plus any explored page whose repeated rows link into a mapped record type; while exploring, links that look like a list of the target ("Users", "Team", "Employees"; or "Contacts", "Leads", "Return to List"; `action=index`, `/list`) are followed early. Start the mapping from the list you want (e.g. the Users page) when the CRM's menus are large: the explorer dives into that list's rows first.
6. **Build rules itself.** The agent writes the selectors: stable ids and `data-*`/`aria-label` attributes first, then classes, adding classes when siblings share an attribute and falling back to position. Ids that look generated (`last_name_pq6dxjzw`, hex hashes, long numbers) and state classes (`active`, `highlighted`, `odd`) are never used. It adds label rules, and a regex when a value shares an element with other text. **A rule is kept only if it reads back exactly the value the LLM saw.** If the LLM pointed at a label, the agent uses the value next to it; if two keys got the same rule (city and zip both pointing at the whole address), only the first is kept.
7. **Validate on a second record.** It replays the whole page type on another record of the same kind. It saves only if no tab is missing and names came back on both. Otherwise the previous rules stay.

### CRMs that navigate by clicks (one address for everything)

Some CRMs never change the address: a launcher page opens the CRM inside a frame (often from another host), a side menu switches screens, and lists are script-driven grids. Nothing there can be reached or recognised by URL, so when the link-based exploration finds no record page, the agent explores by clicking instead:

1. It lists what is on screen and what can be clicked, in every frame big enough to be the application, and asks the AI what the screen shows and which tiles, menu groups and entries lead toward a list of a wanted kind. It never clicks anything that creates, edits, deletes, sends, imports, exports or signs out. Up to 30 clicks, 6 deep; sibling entries (Active, Inactive, Sold…) are all tried. Clickable means a link or button, a menu/tab role, an `onclick`, a click handler the app attached by script (found in the page's own world after the page has drawn what it fetched), or a hand-made focusable control (`tabindex="0"`: launcher cards are often plain divs like that). The AI is told never to pick the signed-in user's own menu (avatar, initials), notifications, or help/support/training cards; a pick that the app re-drew while the AI was deciding is found again by its caption.
   A card that opens its application in a new tab (a launcher such as CDK Unify's, whose "Modern Retail CRM" card opens the CRM on a host of its own) is followed in the same work tab: the new tab's address is loaded there and the new tab closed, during mapping and capture alike; the CRM's host is added to the launcher's.
2. On a list screen it learns the grid: the row element, the column headers, and (one AI question) which field each column holds. The screen is saved as a `screen` page type: the path of clicks that leads to it (each step a selector plus the caption, replayable without AI) and the grid's columns. The frame's host is added to the CRM's hosts.
3. When the rows link to a page with an address (a link, or an onclick that opens a window), that page is mapped like any record and its rows are captured from there, with every field and message list; otherwise the grid's own columns are the record.

Capturing a screen replays the clicks in a work tab, reads the grid, presses the pager's "next" and reads again until it stops changing. If the saved grid rules read nothing, AI reads what is on screen that once, so the capture still yields rows.

What it needs from the CRM: menu captions that stay the same, a grid with header cells (`th` or `columnheader`), and a "next" control for paging. Lists that are empty under the CRM's default filter cannot be learned (there are no rows to learn from): open them with a wider filter before mapping. Re-mapping a screen that stopped fitting is not done yet.

### Records that open in place (no address of their own)

Many CRMs open a record in a drawer, a dialog or a side pane over the list when a row is clicked, without changing the address; others open the record's page, but only from script (the row holds no link). Whenever a list's rows hold no link (a list page that links to no record page, or a screen reached by clicks), the agent clicks the first row and looks at what happened:

- **Something appeared** (a drawer, dialog or pane): only that panel is shown to the AI and mapped as the record, with its own tabs and message lists. The agent works out how to close it again (its ×/Close/Back control, else Escape) and checks the layout on a second row, which must show different values (a panel that keeps the first row's values is not following the rows). The screen saves it as its `detail`: what to click in a row (`open`), the panel's selector, its views and `close`.
- **The address changed:** that page is mapped as an ordinary record, and the screen keeps `rowOpen` (what to click in a row) and `recordPageType`.

What is clicked in a row: a link naming the record or a View/Open button, else the first cell with text, else the row itself; never an action (Delete, Edit, Email, Call…), a `mailto:`/`tel:` link or a button it can't name. Capturing walks the grid page after page: for a panel, each row is opened, read with the saved rules (inside the panel only, so a column header never passes for a label), merged with the row's columns and closed; for script-opened pages, each row is clicked, its address noted, and the list brought back (the browser's Back, else the list's address, its clicks and "next" again), and the pages are captured like any record. A panel layout that stops fitting a row saves that row's columns only and says so in the capture log; it is not re-mapped by itself yet.

Try it on the Drawer CRM mock (`http://localhost:4104/crm/`: contacts whose drawer has Overview and Messages tabs; `/crm/people`: rows that open `/crm/person/<id>` by script; `/crm/leads` and `/crm/leads-classic`: lists whose pager is a button, see Paging below; `/crm/contacts-scroll`: a list that grows as its own box is scrolled; each `/crm/person/<id>` shows the latest email in a `srcdoc` frame and the last note in an `about:blank` frame written by script).

### When it re-maps

- **Daily:** CRMs mapped from the browser are re-mapped by the extension once a day while the browser is open; server-mapped CRMs every `MAP_INTERVAL_HOURS` (24 by default), retried hourly after a failure.
- **On failure:** the extension considers a capture failed when a tab or panel isn't found, a required field or every contact field is missing, or an email/phone doesn't look like one. It then posts the page's URL and the problem to `/api/extraction-failures`, with field names only and no customer data. The re-map of just that page type (the failing page plus a previous sample) runs from the browser for CRMs mapped there, otherwise on the server; the extension picks up the new version on its next capture. Duplicate reports collapse into one job, and a page re-mapped in the last 10 minutes isn't re-mapped again.
- **Manually:** **Settings → CRM layouts → Re-map now**, or from the command line:

  ```bash
  npm run map -- vinsolutions
  ```

  Add `--url <page>` to re-map one page, or `--headed` to watch the browser.

## Adding a real CRM

From the browser: sign in to the CRM, open it, click the icon and **Map this CRM**. Nothing else is needed; the CRM appears under **Settings → CRM layouts**, re-maps daily while the browser is open, and re-maps a page from the browser when its rules stop fitting.

To have the **server** map it instead (unattended, with credentials it holds), add an entry to `backend/config/crm-sites.json`, or keep your own registry file outside the repo and point `CRM_SITES_PATH` at it (the config file can move too, with `CRM_CONFIG_PATH`):

```json
{
  "id": "vinsolutions",
  "name": "VinSolutions",
  "match": { "hosts": ["*.vinsolutions.com", "vinsolutions.app.coxautoinc.com"] },
  "startUrl": "<a lead list page after sign-in>",
  "login": {
    "url": "<sign-in page>",
    "steps": [
      { "fill": "#username", "env": "VIN_USER" },
      { "fill": "#password", "env": "VIN_PASSWORD" },
      { "click": "button[type=submit]" }
    ],
    "successUrlIncludes": "<part of the URL after sign-in>"
  }
}
```

Step types: `{ "fill", "env" }` types a credential from that environment variable, `{ "click" }` presses a button, `{ "goto" }` opens a page, `{ "wait": ms }` pauses, and `{ "manual": "message" }` pauses a `--headed` run so you can sign in yourself (MFA, bot checks): press Enter in the terminal when done. Add `"optional": true` to a step that may not be needed, such as a one-time "confirm your time zone" screen some CRMs show after the first sign-in. `startUrl` can be any page reachable after sign-in: a dashboard whose widgets link to records works, a contact or lead list works best.

Put the credentials in `backend/.env`, then run the mapper with a visible browser so you can watch the first mapping:

```bash
npm run map -- vinsolutions --headed
```

Sign-ins with MFA/TOTP need an extra step type. The `browser-automation` repo already does TOTP for DriveCentric.

### Example: a public SugarCRM-family demo

For a demo you can sign in to in Chrome (e.g. `demo.1crmcloud.com`), no configuration is needed: sign in, open its contacts list, click the icon and **Map this CRM**. The registry entry below is only for running the agent on the server instead, with the demo's own username and password, and nothing about it lives in the code:

```json
{ "sites": [{
  "id": "onecrm-demo", "name": "1CRM demo",
  "match": { "hosts": ["demo.1crmcloud.com"] },
  "startUrl": "https://demo.1crmcloud.com/app/?module=Contacts&action=index",
  "login": {
    "url": "https://demo.1crmcloud.com/app/",
    "steps": [
      { "wait": 6000 },
      { "fill": "input[type=text]", "env": "ONECRM_USER" },
      { "fill": "input[type=password]", "env": "ONECRM_PASSWORD" },
      { "click": "button:has-text('Login')" },
      { "goto": "https://demo.1crmcloud.com/app/?module=Contacts&action=index" },
      { "click": "button:has-text('Save')", "optional": true },
      { "wait": 4000 }
    ],
    "successUrlIncludes": "/app/"
  },
  "crawl": { "maxPages": 14, "perPattern": 2 }
}] }
```

```bash
ONECRM_USER=… ONECRM_PASSWORD=… CRM_SITES_PATH=~/crm-sites.local.json npm run map -- onecrm-demo --headed
```

If the demo's sign-in refuses an automated browser, replace the two `fill` steps and the `click` with `{ "manual": "Sign in to the demo in the browser window" }`, run with `--headed`, sign in by hand and press Enter.

Then load the extension, open any contact on the demo and click the icon: it reads the record with the saved layout; on the contacts list, or on the home dashboard whose inbox links to contacts, it offers **Capture all N** and reads every linked contact in the background.

The quickest way to map a CRM you can open in a browser, without editing any file:

```bash
npm run map -- --new "https://demo.1crmcloud.com/app/?module=Contacts&action=index"
```

It opens a visible browser at that URL, waits for you to sign in (and to dismiss any first-time screen) and press Enter in the terminal, then explores and maps the CRM and adds it to the registry with a manual sign-in step. Replace that step with `fill`/`click` steps later for unattended daily re-maps.

## Crawl everything (proof of concept)

**Crawl everything (POC)** in the popup ignores the mapped layouts, the AI and the "What to capture" setting: from the page you are on it goes through the whole site the way a person browsing it would, and saves everything every page shows.

- **Where it goes:** every link within the site's hosts; safe menus, tabs and cards (a screen with no address of its own is reached again by replaying the clicks that led to it; a card that opens the application in a new tab, even on another host, is followed in the work tab and that host crawled too); every grid row with no link (its drawer or dialog read and closed again, or the page it opens queued); every page of a grid, by its "next" control. Menu and header entries are clicked once for the whole crawl, tabs and cards once per page.
- **What it reads, with no AI:** every table as rows named by their column headers, every label/value pair (`<dl>`, labelled form fields, "Label:" text with its value beside it, two-column tables), the page's text and its links; inside shadow roots and frames with no address too. SSNs and card numbers are blanked and password/SSN/card fields skipped.
- **What it never presses:** anything that adds, edits, deletes, sends, emails, calls, exports, prints, assigns, approves, cancels, marks, schedules, archives, updates or signs out, and no pager or sorting control outside its grid.
- **Files** (in the download folder, rewritten every 10 pages): `crawl_values_<date>.csv`, one value per line (`page_url, click_path, source, table, row, label, value`), and `crawl_pages_<date>.csv`, one line per page or state read (`page_url, click_path, source, row, title, frames, fields, table_rows, text`).
- **Limits:** 400 pages and states per crawl, 20 clicks queued per page, 6 clicks deep, 40 rows opened and 20 pages per grid. A page that shows exactly what an earlier one did is not read again. The capture window shows its progress and can cancel it.

## CSV output

Files are written to `Downloads/<folder>/` each time you save:

| File | One row per | Key columns |
|---|---|---|
| `leads_<date>.csv` | customer | `site, crm_record_id`, names, contact, address, vehicle, lead fields, `messages_count`, `record_id` |
| `leads_messages_<date>.csv` | text / email / call / note | `customer, customer_record_id` (→ `record_id` above), `channel, timestamp, direction, sender, subject, body, duration, outcome, message_id` |

A whole-CRM capture saves every 10 records; re-running it the same day updates the existing rows (same `crm_record_id`) instead of duplicating them.

- **Customer rows:** capturing the same record again the same day updates its row instead of adding one.
- **Message rows:** messages already saved (same `message_id`) are skipped.
- **Customer-file columns:** the union of what was captured that day.
- **Storage:** everything is stored in the extension first, so a failed file write loses nothing. If Excel has a file open, close it and click **Write CSV again**.

## Tests

```bash
npm test
```

52 unit tests covering URL patterns (record and list, short ids), config matching, extraction checks, the config store, the job queue, the routes, CSV output and message rows.

```bash
npm run test:browser
```

28 tests of the in-page runtime and the explorer in headless Chrome against the mocks: records that open in a drawer or by script (found, mapped with a scripted LLM, read page after page), pagers with no address (a script-driven button beside a decoy "Next", an ASP.NET postback), frames with no address (`srcdoc`, `about:blank`) read inside their page, a list scrolled inside its own box, web-component pages (fields, tabs, timelines and lists in nested shadow roots), tabs in iframes, hash-routed tabs, empty tabs, label lookups, zebra-striped lists, layout changes, an optional sign-in step past an interstitial, diving from list rows and `onclick` rows into records, new-tab links, list description, collapsed panels, and message links. No LLM is used.

```bash
node --env-file=backend/.env scripts/poc-e2e.mjs
```

The full loop with the real agent (a few OpenAI calls). It checks every captured value against the mock data, before and after a simulated release of each CRM.

```bash
node --env-file=backend/.env scripts/extension-e2e.mjs
```

The same loop through the real extension loaded in Edge, plus the SugarCRM-family mock: mapped from the browser for customers (a contacts list, "capture all", email bodies fetched from the emails' own pages, the whole CRM), then switched to **internal users** and mapped again from its Users page: the user list with its paging, each user's card and its "Access rights" link-tab, 5 users captured and saved with login, role, department, status and dates.

```bash
npm run e2e:no-ai
```

The real extension without OpenAI (a scripted stand-in answers the agent's questions) on the Drawer CRM mock: "Capture whole CRM" opens every contact's drawer across both grid pages, reads both drawer tabs and closes it (never pressing a row's Delete); on `/crm/people` clicks each row, notes the page it opens, comes back and captures every person from their own page; and on `/crm/leads` and `/crm/leads-classic` walks all three pages by pressing the pager's "next" (a script-driven button, an ASP.NET postback), never the setup wizard's "Next" on the same page; each person's email body and note are read from inside the frames that show them; and `/crm/contacts-scroll` is scrolled inside its own box, in the background work tab, until all five contacts are there.

Popup UI work: serve the repo root and open `/tests/preview/popup-harness.html`. Add `?config`, `?fallback`, `?multi`, `?empty` or `?error` to see each state.

## Privacy

- The OpenAI key stays on the backend.
- **AI extraction:** SSNs, card numbers, and SSN/card/licence/date-of-birth/password form fields are removed in the browser before anything is sent.
- **Mapping agent:** it sends DOM snapshots of CRM pages to the server and on to OpenAI, including the data of the one or two sample customers it maps with. Captures that use a saved layout send nothing.
- **Logs:** the server logs hosts, sizes, field names and counts, never customer data.

## Known limits of the proof of concept

- **Web components (shadow DOM):** fields, tabs, message lists and people lists inside shadow roots are mapped and read; a rule steps into a component's shadow root with ` >>> ` (`crm-record >>> crm-field[data-field="email"] >>> span.form-value`). Closed shadow roots are reachable from the extension only (via `chrome.dom`), not from the server-side agent in Playwright.
- **Tabs and frames:** a frame with no address of its own (`srcdoc`, no `src`, or `about:blank` filled in by script: email viewers often show a message's body this way) is read as part of its page, and rules step into it with ` >>> ` as into a shadow root; frames with an address are read on their own as before. A sandboxed frame without `allow-same-origin`, or one from another origin with no address, cannot be read. Tabs and panels must live in the same frame as the record's data. Tabs that are pages of their own (Dolibarr-style links such as "Contacts/Addresses", "Projects") are followed: their page is mapped and, at capture time, opened in a work tab and read; the user's own tab is never navigated away.
- **Click-driven CRMs:** a screen is found again by its click path; a renamed or moved menu entry breaks it until the CRM is mapped again. Rows with no link are opened by clicking them (see "Records that open in place"); a record that opens in an iframe dialog is not followed into it. Only one grid per screen is read.
- **Record ids:** ids in URLs are long numbers, UUIDs or hashes, or a short number behind a parameter that names an id (`user/card.php?id=5`, `?record=12`, `?socid=7`); a short number elsewhere (`/v2/`) is kept literally.
- **Paging:** "Capture whole CRM" follows a list's pages through its URL parameters (`list_offset`/`limit`, `page=`, `start`/`count`, also in hash routes) or its "Next"/"›" link; a pager with no address for the next page (a script-driven "next" button, an ASP.NET `__doPostBack` link that reloads the page) is pressed in the work tab, page after page, until the rows stop changing. Only a "next" control near the list counts (the nearest one around it, or the page's only pager), never another "Next" on the page; `javascript:` links are followed from the page's own world, since Chrome ignores them when an extension clicks them. It expands lists that grow in place ("Show more"/"Load more" buttons, infinite scroll) before reading them; it scrolls whatever holds the rows (a scrolling box inside the page, or the page itself), and click-driven screens with no pager are expanded the same way. A list that only loads more when it is actually seen on screen (an IntersectionObserver in a background tab) or that recycles its rows as it scrolls (a virtualised grid) is still read as far as it shows. Hash routes with or without a leading slash (`#/customers`, `#Contact/view/<id>`) are understood. Message lists inside a record are read as shown (no "load more"). Caps: 200 pages per list, 5,000 records per run, 15 message pages per record.
- **Message pages:** up to 15 message pages are opened per record; entries beyond that keep what the list showed.
- **Sign-in:** the agent types credentials from environment variables; sites that guard sign-in with a bot check (a demo's "automatic" sign-in that only works in a normal browser, CAPTCHAs) need the real username/password form to be reachable.
- **The agent runs on the backend machine,** which needs Chrome or Edge and network access to the CRMs. The extension still runs in the user's own signed-in browser.
