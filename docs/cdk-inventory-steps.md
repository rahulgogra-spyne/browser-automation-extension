# CDK Global: Total Inventory Excel export (verified steps)

These are the steps the CDK inventory run follows (`lib/cdk-inventory-run.ts`). Each step was run by hand in Claude in Chrome on 23 Oct 2026 and checked on screen. The selectors come from the CRM markup copied in DevTools.

| # | Step | Where | How it is matched | Verified by hand |
|---|------|-------|-------------------|------------------|
| 1 | Open CDK, sign in (user) | `https://launch.cdkunify.com/` | Waits for the applications page | Yes. Passes straight through when signed in. |
| 2 | Open Modern Retail CRM | Applications page, card "Modern Retail CRM" | Card text | Yes. Opens on Preferences with Saxon Auto Group. |
| 3 | Change store to Inver Grove Ford (16654) | Top-right store box | Read-only autocomplete: `input[data-testid="autocomplete-menu-input-field"]`; option text `Inver Grove Ford (16654)` | Yes. The session stayed signed in. |
| 4 | Open sidebar Reports | Left sidebar, section "Reports" | `h3.Home_LeftNavigation_MainMenu[title="Reports"]` (open only if All is not showing) | Yes. |
| 5 | Click All | Sidebar, under Reports | `a[onclick="goTo('Reports/ReportMenu.aspx',null,0);return false;"]` | Yes. The Report Menu loads in the main panel after about 10 s. |
| 6 | Scroll main panel to Inventory | Main panel only (not the sidebar) | Mouse wheel over the middle of the CRM screen, right of the sidebar | Yes. The sidebar does not move. |
| 7 | Open Total Inventory | Main panel, group "Inventory" (`tr.SectionHeader#Inventory`), link | `a[href*="TotalInventory.aspx"]` | Yes. Opens "Inventory Management". |
| 8 | Export Entire Inventory to Excel | Top-right of the grid: export icon, then dialog option | Icon `img#exportButton[alt="export"]`; dialog `button` containing "Entire Inventory" | Yes. Downloads a CSV of 311 rows to Downloads (17:13 and 17:39 runs). |

## Notes

- The file is CSV, not .xlsx. It opens directly in Excel.
- The Inventory group in the Report Menu can be open or folded. Step 7 opens it only when Total Inventory is not showing.
- The sidebar "Inventory" item (which expands Pricing Rules / Vehicle Search / Vehicle Reports) is not the report group. Do not click it.
- Known weak point: the extension finds controls inside nested CRM frames and measures their position. Steps 4 to 8 depend on that. The clicks were verified by hand, but the extension's frame lookup has not been verified end to end.
