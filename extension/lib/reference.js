// The CRM's own vocabulary, gathered from what was captured: every distinct
// lead source, lead type, status, salesperson, role, department... with how
// often it was seen. Anything that later writes into the CRM (a lead push
// that has to pick "Lead source" from a dropdown, or assign a salesperson)
// needs these values exactly as the CRM spells them.
//
// One row per (site, kind, field, value), in <prefix>_reference_<date>.csv.
export const REFERENCE_COLUMNS = ['site', 'dataset', 'field', 'value', 'count'];

// Columns whose values are picked from a fixed list in a CRM.
const REFERENCE_KEY =
  /^(lead_source|lead_type|lead_status|status|stage|priority|salesperson|sales_manager|bdc_agent|assigned_to|owner|manager|role|group|department|team|office|store|location|dealer_name|job_title|appointment_type|task_type|preferred_contact_method|condition|body_style|vehicle_make)$/;

// days: { datasets: { kind: [rows] } } (see store.getDay).
export function referenceRows({ datasets = {} }) {
  const counts = new Map();
  for (const [dataset, rows] of Object.entries(datasets)) {
    for (const row of rows) {
      for (const [field, raw] of Object.entries(row)) {
        const value = String(raw ?? '').trim();
        if (!value || value.length > 80 || !REFERENCE_KEY.test(field)) continue;
        const id = [row.site ?? '', dataset, field, value.toLowerCase()].join('\u0001');
        const entry = counts.get(id) ?? { site: row.site ?? '', dataset, field, value, count: 0 };
        entry.count++;
        counts.set(id, entry);
      }
    }
  }
  return [...counts.values()]
    .sort((a, b) => a.site.localeCompare(b.site) || a.dataset.localeCompare(b.dataset) || a.field.localeCompare(b.field) || b.count - a.count || a.value.localeCompare(b.value))
    .map((entry) => ({ ...entry, count: String(entry.count) }));
}
