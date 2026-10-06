// Fake dealership data shared by the mock CRMs. Every person, phone number
// (555-01xx), email (example.com) and VIN here is made up.

const VIN_VALUES = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// Fills in position 9 so the fake VINs pass the North American check digit.
function vin(pattern) {
  const sum = [...pattern].reduce((acc, ch, i) => acc + (i === 8 ? 0 : (/\d/.test(ch) ? Number(ch) : VIN_VALUES[ch]) * VIN_WEIGHTS[i]), 0);
  const check = sum % 11 === 10 ? 'X' : String(sum % 11);
  return pattern.slice(0, 8) + check + pattern.slice(9);
}

export const DEALER = {
  name: 'Sunrise Toyota of Plano',
  phone: '(972) 555-0100',
  email: 'sales@sunrisetoyota.example',
  address: '500 Dealer Pkwy, Plano, TX 75093',
};

export const customers = [
  {
    id: 1001,
    first: 'John', last: 'Doe',
    email: 'john.doe@example.com', cell: '(214) 555-0147', home: '(972) 555-0199', work: '',
    street: '123 Main Street', city: 'Plano', state: 'TX', zip: '75024',
    vehicle: { year: 2024, make: 'Toyota', model: 'Camry XSE', vin: vin('4T1K61AK0RU000147'), stock: 'T24518' },
    source: 'Cars.com', status: 'Active - Working', salesperson: 'Mike Ross', created: '09/21/2026',
    texts: [
      { at: '09/21/2026 10:14 AM', dir: 'in', from: 'John Doe', body: 'Hi, is the Camry XSE on your site still available?' },
      { at: '09/21/2026 10:20 AM', dir: 'out', from: 'Mike Ross', body: 'Hi John, yes it is! Want to come see it this week?' },
      { at: '09/21/2026 10:31 AM', dir: 'in', from: 'John Doe', body: 'Saturday morning works. Can you send the out-the-door price?' },
      { at: '09/21/2026 10:35 AM', dir: 'out', from: 'Mike Ross', body: 'Sent to your email. See you Saturday at 10!' },
    ],
    emails: [
      { at: '09/21/2026 10:34 AM', dir: 'out', from: 'Mike Ross', subject: 'Your Camry XSE quote', body: 'Hi John, attached is the out-the-door price for the 2024 Camry XSE, stock T24518.' },
      { at: '09/22/2026 08:02 AM', dir: 'in', from: 'John Doe', subject: 'RE: Your Camry XSE quote', body: 'Thanks Mike. Does that include the all-weather package?' },
    ],
    calls: [{ at: '09/23/2026 04:10 PM', dir: 'out', duration: '4m 12s', outcome: 'Spoke with customer', notes: 'Confirmed Saturday appointment.' }],
    notes: [{ at: '09/21/2026', author: 'Mike Ross', text: 'Customer prefers email. Trading in a 2018 Honda Civic EX.' }],
  },
  {
    id: 1002,
    first: 'Priya', last: 'Shah',
    email: 'priya.shah@example.com', cell: '(469) 555-0123', home: '', work: '(214) 555-0188',
    street: '48 Legacy Drive Apt 12', city: 'Frisco', state: 'TX', zip: '75034',
    vehicle: { year: 2025, make: 'Toyota', model: 'RAV4 Hybrid XLE', vin: vin('2T3P1RFV0SW000123'), stock: 'T25102' },
    source: 'Dealer Website', status: 'Appointment Set', salesperson: 'Rachel Zane', created: '09/24/2026',
    texts: [
      { at: '09/24/2026 06:45 PM', dir: 'in', from: 'Priya Shah', body: 'Do you have the RAV4 Hybrid in blue?' },
      { at: '09/24/2026 06:52 PM', dir: 'out', from: 'Rachel Zane', body: 'We have one in Blueprint arriving Friday. Want me to hold it?' },
      { at: '09/24/2026 07:03 PM', dir: 'in', from: 'Priya Shah', body: 'Yes please!' },
    ],
    emails: [{ at: '09/25/2026 09:15 AM', dir: 'out', from: 'Rachel Zane', subject: 'RAV4 Hybrid on hold for you', body: 'Hi Priya, the Blueprint RAV4 Hybrid XLE is on hold until Monday.' }],
    calls: [],
    notes: [{ at: '09/24/2026', author: 'Rachel Zane', text: 'Wants blue only. Pre-approved with credit union.' }],
  },
  {
    id: 1003,
    first: 'Carlos', last: 'Mendez',
    email: 'c.mendez@example.com', cell: '(972) 555-0164', home: '(972) 555-0171', work: '',
    street: '9 Oak Hollow Ct', city: 'Allen', state: 'TX', zip: '75002',
    vehicle: { year: 2024, make: 'Toyota', model: 'Tacoma TRD Off-Road', vin: vin('3TMLB5JN0RM000164'), stock: 'T24877' },
    source: 'Walk-in', status: 'Sold', salesperson: 'Harvey Specter', created: '09/12/2026',
    texts: [
      { at: '09/13/2026 11:00 AM', dir: 'out', from: 'Harvey Specter', body: 'Congrats on the new Tacoma, Carlos! Let me know if you need anything.' },
      { at: '09/13/2026 11:42 AM', dir: 'in', from: 'Carlos Mendez', body: 'Thanks! Loving it so far.' },
    ],
    emails: [
      { at: '09/12/2026 05:30 PM', dir: 'out', from: 'Harvey Specter', subject: 'Welcome to the Sunrise Toyota family', body: 'Carlos, thanks for your purchase. Your first service is free at 5,000 miles.' },
    ],
    calls: [
      { at: '09/11/2026 02:05 PM', dir: 'in', duration: '6m 40s', outcome: 'Scheduled test drive', notes: 'Asked about TRD Off-Road availability.' },
      { at: '09/14/2026 10:15 AM', dir: 'out', duration: '1m 05s', outcome: 'Left voicemail', notes: 'Post-sale follow-up.' },
    ],
    notes: [{ at: '09/12/2026', author: 'Harvey Specter', text: 'Delivered. Paid cash, no trade.' }],
  },
  {
    id: 1004,
    first: 'Emily', last: 'Chen',
    email: 'emily.chen@example.com', cell: '(214) 555-0132', home: '', work: '',
    street: '2200 Preston Road', city: 'Plano', state: 'TX', zip: '75093',
    vehicle: { year: 2025, make: 'Toyota', model: 'Highlander Platinum', vin: vin('5TDKDRBH0SS000132'), stock: 'T25230' },
    source: 'TrueCar', status: 'New', salesperson: 'Mike Ross', created: '09/28/2026',
    texts: [{ at: '09/28/2026 09:05 AM', dir: 'out', from: 'Mike Ross', body: 'Hi Emily, thanks for your TrueCar request on the Highlander Platinum. When works for a call?' }],
    emails: [
      { at: '09/28/2026 08:58 AM', dir: 'in', from: 'TrueCar', subject: 'New TrueCar lead: Emily Chen', body: 'Customer is interested in a 2025 Highlander Platinum. Price certificate attached.' },
      { at: '09/28/2026 09:10 AM', dir: 'out', from: 'Mike Ross', subject: 'Your Highlander Platinum', body: 'Hi Emily, here are the details and photos for the Highlander Platinum.' },
    ],
    calls: [],
    notes: [],
  },
  {
    id: 1005,
    first: 'Marcus', last: 'Johnson',
    email: 'marcus.j@example.com', cell: '(469) 555-0158', home: '(469) 555-0166', work: '(972) 555-0177',
    street: '71 Cedar Lane', city: 'McKinney', state: 'TX', zip: '75070',
    vehicle: { year: 2024, make: 'Toyota', model: 'Corolla LE', vin: vin('5YFB4MDE0RP000158'), stock: 'U24391' },
    source: 'Facebook Marketplace', status: 'Lost', salesperson: 'Rachel Zane', created: '09/05/2026',
    texts: [
      { at: '09/05/2026 03:12 PM', dir: 'in', from: 'Marcus Johnson', body: 'Is the Corolla LE price negotiable?' },
      { at: '09/05/2026 03:20 PM', dir: 'out', from: 'Rachel Zane', body: 'There is some room. Can you come in to talk numbers?' },
      { at: '09/09/2026 10:00 AM', dir: 'in', from: 'Marcus Johnson', body: 'Bought elsewhere, thanks anyway.' },
    ],
    emails: [],
    calls: [{ at: '09/06/2026 01:30 PM', dir: 'out', duration: '0m 45s', outcome: 'No answer', notes: '' }],
    notes: [{ at: '09/09/2026', author: 'Rachel Zane', text: 'Lost to competitor on price.' }],
  },
];

export const findCustomer = (id) => customers.find((c) => String(c.id) === String(id));

// The dealership's own staff: the CRM's users (salespeople, managers, BDC
// agents). Made-up people; 555-01xx phones and example.com emails.
export const employees = [
  { id: 1, login: 'admin', first: 'Rachel', last: 'Zane', email: 'rachel.zane@sunrisetoyota.example', phone: '(972) 555-0101', mobile: '(469) 555-0171', title: 'General Sales Manager', group: 'Administrators', department: 'Sales', status: 'Active', hired: '03/14/2019', lastLogin: '09/29/2026 08:12 AM', supervisor: '' },
  { id: 2, login: 'mross', first: 'Mike', last: 'Ross', email: 'mike.ross@sunrisetoyota.example', phone: '(972) 555-0102', mobile: '(469) 555-0172', title: 'Sales Consultant', group: 'Sales', department: 'Sales', status: 'Active', hired: '06/01/2022', lastLogin: '09/29/2026 09:40 AM', supervisor: 'Rachel Zane' },
  { id: 3, login: 'dpaulsen', first: 'Donna', last: 'Paulsen', email: 'donna.paulsen@sunrisetoyota.example', phone: '(972) 555-0103', mobile: '', title: 'BDC Agent', group: 'BDC', department: 'Business Development', status: 'Active', hired: '11/20/2020', lastLogin: '09/28/2026 05:55 PM', supervisor: 'Rachel Zane' },
  { id: 4, login: 'llitt', first: 'Louis', last: 'Litt', email: 'louis.litt@sunrisetoyota.example', phone: '(972) 555-0104', mobile: '(469) 555-0174', title: 'Finance Manager', group: 'Finance', department: 'F&I', status: 'Active', hired: '01/09/2017', lastLogin: '09/27/2026 11:02 AM', supervisor: 'Rachel Zane' },
  { id: 5, login: 'kbennett', first: 'Katrina', last: 'Bennett', email: 'katrina.bennett@sunrisetoyota.example', phone: '(972) 555-0105', mobile: '(469) 555-0175', title: 'Sales Consultant', group: 'Sales', department: 'Sales', status: 'Disabled', hired: '04/03/2023', lastLogin: '07/15/2026 02:20 PM', supervisor: 'Mike Ross' },
];
export const findEmployee = (id) => employees.find((e) => String(e.id) === String(id));
