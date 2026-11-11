// Static geography of the world: Sunfall and, across the sky, Nightfall. Sunfall's map space is 1000 x 700;
// Nightfall sits further east in the same map space (x 1540-2200), joined to Sunfall by the sky ferry.

export const CITIES = [
  { id: 'sunfall', name: 'Sunfall', tagline: 'a world above the clouds', bounds: [0, 0, 1000, 700] },
  { id: 'nightfall', name: 'Nightfall', tagline: 'the city that never lands', bounds: [1520, 40, 2220, 660] },
];
export const cityById = (id) => CITIES.find((c) => c.id === id);
// The sky ferry: moving house costs a fare, a night out in the other city a ticket.
export const FERRY = { moveFare: 30, ticket: 6, pierSunfall: [990, 400], pierNightfall: [1530, 400] };

export const DISTRICTS = [
  { id: 'flats', name: 'The Terraces', rent: 75, rect: [30, 40, 300, 300], tint: '#3a2f4a', city: 'sunfall' },
  { id: 'hillside', name: 'The Spires', rent: 175, rect: [360, 30, 380, 190], tint: '#2f4a3a', city: 'sunfall' },
  { id: 'neon', name: 'Crystal Row', rent: 150, rect: [770, 40, 200, 420], tint: '#4a2f3f', city: 'sunfall' },
  { id: 'oldtown', name: 'Old Lanterns', rent: 120, rect: [360, 250, 380, 210], tint: '#4a3f2f', city: 'sunfall' },
  { id: 'harbour', name: 'Skyport', rent: 95, rect: [30, 370, 300, 300], tint: '#2f3f4a', city: 'sunfall' },
  { id: 'saltworks', name: 'Cloudworks', rent: 80, rect: [360, 490, 610, 180], tint: '#3f3f3f', city: 'sunfall' },
  // Nightfall: cheaper to live in, heavier on nightlife (two casinos, three bars), riskier with it.
  { id: 'velvet', name: 'Velvet Mile', rent: 110, rect: [1540, 60, 340, 280], tint: '#3a1f4a', city: 'nightfall' },
  { id: 'halo', name: 'Halo Heights', rent: 160, rect: [1900, 60, 300, 280], tint: '#1f2f4a', city: 'nightfall' },
  { id: 'undertow', name: 'The Undertow', rent: 50, rect: [1540, 360, 340, 280], tint: '#2a2433', city: 'nightfall' },
  { id: 'ashdock', name: 'Ashdock', rent: 65, rect: [1900, 360, 300, 280], tint: '#33281f', city: 'nightfall' },
];
export const cityOfDistrict = (id) => DISTRICTS.find((d) => d.id === id)?.city || 'sunfall';
export const districtsOf = (city) => DISTRICTS.filter((d) => d.city === city);

// Places you pay to walk into. `door` is the band an owner may set the price in.
export const VTYPES = {
  bar: { label: 'Bar', door: [6, 20], price: 8, staffTrade: 'bartender', half: 'night', value: 1200 },
  gym: { label: 'Gym', door: [4, 15], price: 6, staffTrade: 'trainer', half: 'aft', value: 1000 },
  casino: { label: 'Casino', door: [10, 40], price: 15, staffTrade: 'dealer', half: 'night', value: 4000 },
  market: { label: 'Night market', door: [3, 12], price: 5, staffTrade: 'vendor', half: 'night', value: 1400 },
  diner: { label: 'Diner', door: [4, 14], price: 7, staffTrade: 'cook', half: 'aft', value: 900 },
  stadium: { label: 'Stadium', door: [8, 30], price: 12, staffTrade: null, half: 'aft', value: 20000, cityOnly: true },
  field: { label: 'Field', door: [8, 30], price: 12, staffTrade: null, half: 'night', value: 20000, cityOnly: true },
};
export const VENUE_TYPES = Object.keys(VTYPES);

// Workplaces that are not venues.
export const WTYPES = {
  docks: { label: 'Docks', half: 'aft' },
  office: { label: 'Office', half: 'aft' },
  yard: { label: 'Freight yard', half: 'aft' },
};

export const TRADES = {
  bartender: { name: 'Bartender', wage: 46, place: 'bar', weight: 22 },
  trainer: { name: 'Trainer', wage: 44, place: 'gym', weight: 12 },
  dealer: { name: 'Dealer', wage: 58, place: 'casino', weight: 12 },
  vendor: { name: 'Market vendor', wage: 40, place: 'market', weight: 18 },
  cook: { name: 'Cook', wage: 43, place: 'diner', weight: 24 },
  docker: { name: 'Docker', wage: 53, place: 'docks', weight: 40 },
  clerk: { name: 'Clerk', wage: 50, place: 'office', weight: 40 },
  driver: { name: 'Driver', wage: 48, place: 'yard', weight: 32 },
};

// [id, type, name, district, x, y, forSalePrice|null]
export const PLACES = [
  ['v1', 'bar', 'The Low Tide', 'harbour', 140, 470, null],
  ['v2', 'bar', 'Copper Kettle', 'oldtown', 470, 330, null],
  ['v3', 'bar', 'Afterglow', 'neon', 860, 130, null],
  ['v4', 'bar', 'Last Light', 'flats', 210, 120, 700],
  ['v5', 'gym', 'Iron Pier', 'harbour', 250, 600, null],
  ['v6', 'gym', 'Summit Club', 'hillside', 640, 90, null],
  ['v7', 'casino', 'The Meridian', 'neon', 870, 330, null],
  ['v8', 'market', 'Lantern Market', 'oldtown', 620, 400, null],
  ['v9', 'diner', 'Rusty Spoon', 'saltworks', 480, 560, null],
  ['v10', 'diner', 'Daybreak Diner', 'hillside', 450, 150, 600],
  ['v11', 'diner', 'Noodle Barge', 'harbour', 90, 610, 500],
  ['v12', 'stadium', 'Sunfall Arena', 'saltworks', 880, 580, null],
  ['v13', 'field', 'Skyline Field', 'harbour', 240, 440, null],
  ['w1', 'docks', 'Cloudworks Quay', 'saltworks', 800, 610, null],
  ['w2', 'office', 'Exchange Tower', 'oldtown', 560, 290, null],
  ['w3', 'yard', 'Freight Yard', 'saltworks', 640, 540, null],
  // Nightfall
  ['v14', 'bar', 'The Velvet Room', 'velvet', 1640, 160, null],
  ['v15', 'casino', 'The Black Orchid', 'velvet', 1800, 240, null],
  ['v16', 'bar', 'Neon Gutter', 'velvet', 1600, 280, 650],
  ['v17', 'casino', 'Halo Casino', 'halo', 2080, 160, null],
  ['v18', 'gym', 'Halo Athletic', 'halo', 1960, 280, null],
  ['v19', 'bar', 'Low Moon', 'undertow', 1640, 440, null],
  ['v20', 'market', 'Midnight Market', 'undertow', 1800, 520, null],
  ['v21', 'diner', 'All-Night Diner', 'undertow', 1600, 600, 550],
  ['w4', 'docks', 'Ashdock Wharf', 'ashdock', 2120, 560, null],
  ['w5', 'office', 'Obsidian Exchange', 'halo', 2120, 280, null],
  ['w6', 'yard', 'Ember Yard', 'ashdock', 1960, 480, null],
];
export const placeCity = (p) => cityOfDistrict(p.district);

export const FIRST = ['Mara', 'Teo', 'Ines', 'Rafe', 'Odile', 'Juno', 'Cass', 'Hollis', 'Wren', 'Dario', 'Petra', 'Silas', 'Noor', 'Emil', 'Lux', 'Bram', 'Ada', 'Kit', 'Ottilie', 'Remy', 'Sol', 'Vera', 'Ezra', 'Maeve', 'Idris', 'Lena', 'Tomas', 'Yara', 'Felix', 'Greta', 'Hugo', 'Iris', 'Jonah', 'Kaia', 'Leon', 'Mina', 'Nils', 'Orla', 'Pablo', 'Quinn', 'Rosa', 'Saul', 'Tess', 'Uma', 'Vito', 'Willa', 'Xavi', 'Zora'];
export const LAST = ['Okafor', 'Halloway', 'Vance', 'Moreau', 'Sato', 'Brennan', 'Castell', 'Duarte', 'Eklund', 'Farrow', 'Gage', 'Hart', 'Ilves', 'Jarrow', 'Kemp', 'Lind', 'Marsh', 'Nakamura', 'Oyelaran', 'Pike', 'Quarry', 'Rook', 'Stroud', 'Thorne', 'Ueda', 'Varga', 'Webb', 'Yeats', 'Zeller', 'Abara', 'Bastos', 'Crane', 'Delacroix', 'Ferro', 'Grieve', 'Holm'];

export const LINES = {
  bar: ['one drink then home', 'cheap pints and loud friends', 'needed a drink after that shift', 'the jukebox was broken again', 'met an old friend at the bar', 'stayed for one more round'],
  gym: ['ran until my legs gave out', 'lifted heavier than last week', 'a slow session, still went', 'clearing my head on the treadmill'],
  casino: ['cards tonight, I can afford it', 'chasing last weeks losses', 'the house always wins, mostly', 'one hand of blackjack, honest'],
  market: ['dumplings from the lantern stalls', 'browsing stalls with nothing to buy', 'street food and people watching', 'bought spices I will never use'],
  field: ['game night at Skyline Field', 'cheering on the home team', 'ten dollars on the Gulls', 'overtime again, what a game'],
  stadium: ['big match at the Arena today', 'a fiver on the home side', 'singing in the stands all afternoon', 'the derby, could not miss it'],
  diner: ['a late breakfast and strong coffee', 'eggs and gossip at the counter', 'the cook knows my order now', 'cheap soup, good company'],
  in: ['a quiet night in', 'saving money this week', 'too tired to go out', 'cooking at home tonight'],
  rent: ['rent day hurts again', 'paid rent, wallet feels light', 'landlord wants more every week'],
  wage: ['payday, finally', 'long shift but the pay landed', 'wages in, spirits up'],
  broke: ['nothing left until payday', 'counting coins again', 'skipping dinner to make rent'],
};
