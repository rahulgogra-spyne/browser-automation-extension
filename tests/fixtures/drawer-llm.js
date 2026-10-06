// A scripted stand-in for the mapping agent's LLM on the Drawer CRM mock
// (mock-crms/drawer.js): it answers from the snapshot text alone, the way the
// real one is asked to (element ids, values as shown). No network, no cost.

// Snapshot lines: [{ mid, depth, desc, text }] ("  [12] dd.value \"Plano\"").
function parseSnapshot(text) {
  return text.split('\n').flatMap((line) => {
    const m = line.match(/^(\s*)\[(\d+)\] (.*?)(?: ("(?:[^"\\]|\\.)*"))?$/);
    return m ? [{ mid: Number(m[2]), depth: m[1].length / 2, desc: m[3], text: m[4] ? JSON.parse(m[4]) : '' }] : [];
  });
}
// The lines inside the element on line i.
const inside = (lines, i) => {
  const out = [];
  for (let j = i + 1; j < lines.length && lines[j].depth > lines[i].depth; j++) out.push(lines[j]);
  return out;
};
const pick = (key, line, extra = {}) => ({ key, mid: line.mid, value: line.text, attr: '', regex: '', ...extra });

const LABEL_KEYS = { 'First Name': 'first_name', 'Last Name': 'last_name', Email: 'email', Mobile: 'phone_mobile', City: 'city', Vehicle: 'vehicle' };
export const fakeLLM = {
  model: 'scripted',
  async classifyPages(shapes) {
    // A person's own page (/crm/person/<id>) is a record; every other page a list.
    return { pages: shapes.map((shape, index) => ({ index, kind: /\/person\/\d+/.test(shape.urls?.[0] ?? shape.url) ? 'record' : 'list', dataset: 'customers', entity: 'contact' })) };
  },
  async mapColumns() {
    throw new Error('not scripted: use the headers');
  },
  // A launcher (CDK Unify-style): open the "Modern Retail CRM" card when it
  // is offered (it is only offered when the cards were found clickable); the
  // contacts grid it leads to is a list of customers.
  async chooseClicks({ clickables, text }) {
    const card = clickables.find((c) => /\bModern Retail CRM$/.test(c.text)); // its caption may start with its icon's text
    if (card) return { screen: { kind: 'menu', dataset: 'other', title: 'Applications' }, clicks: [{ id: card.id }] };
    if (/\bContacts\b/.test(text)) return { screen: { kind: 'list', dataset: 'customers', title: 'Contacts' }, clicks: [] };
    return { screen: { kind: 'other', dataset: 'other', title: '' }, clicks: [] };
  },
  async mapView(frames, { label }) {
    const lines = parseSnapshot(frames.map((f) => f.text).join('\n'));
    const answer = { is_target: true, summary: 'a contact in the drawer', sections: [], fields: [], collections: [] };
    if (label.includes('section "Messages"')) {
      const i = lines.findIndex((l) => l.desc.startsWith('ul.msg-list'));
      if (i < 0) return answer;
      const items = inside(lines, i).filter((l) => l.desc.startsWith('li.msg'));
      const first = lines.indexOf(items[0]);
      const body = inside(lines, first).find((l) => l.desc.startsWith('p.msg-body'));
      const time = inside(lines, first).find((l) => l.desc.startsWith('span.msg-time'));
      answer.collections.push({
        name: 'text_messages',
        container_mid: lines[i].mid,
        item_mids: items.slice(0, 2).map((l) => l.mid),
        item_fields: [pick('body', body), pick('timestamp', time), { key: 'direction', mid: items[0].mid, value: 'inbound', attr: 'data-direction', regex: '' }],
      });
      return answer;
    }
    for (const [i, line] of lines.entries()) {
      if (line.desc.startsWith('dt') && LABEL_KEYS[line.text] && lines[i + 1]?.desc.startsWith('dd')) answer.fields.push(pick(LABEL_KEYS[line.text], lines[i + 1]));
      // A person's page shows their latest email and last note in frames of their own.
      if (line.desc.startsWith('div.email-text') && line.text) answer.fields.push(pick('last_email_body', line));
      if (line.desc.startsWith('div.note-text') && line.text) answer.fields.push(pick('last_note', line));
      if (/\[role="tab"\]/.test(line.desc)) answer.sections.push({ mid: line.mid, name: line.text, kind: 'tab', is_open: /aria-selected="true"/.test(line.desc) });
    }
    return answer;
  },
};
