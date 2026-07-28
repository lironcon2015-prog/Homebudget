// ===== CATEGORY ICON SET (Lucide-style monochrome SVG) =====
// Category icons can be stored two ways on `cat.icon`:
//   - 'ic:<id>'  → an entry in CAT_ICON_META, rendered as inline SVG tinted
//                  with the category colour (the polished, consistent look).
//   - any other  → a legacy emoji string, rendered as-is (back-compat).
// catIconHTML() handles both, so old data keeps working with no migration.
// Paths are 24×24, stroke-based (stroke="currentColor", fill="none"), so a
// single `color` drives the whole glyph.

const CAT_ICON_META = {
  // --- בית ודיור ---
  home:        { he: 'בית',         kw: 'home house דיור',          svg: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
  building:    { he: 'בניין',       kw: 'building apartment דירה',  svg: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>' },
  lightbulb:   { he: 'נורה',        kw: 'light bulb חשמל חשבון',    svg: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>' },
  zap:         { he: 'חשמל',        kw: 'zap electric power',       svg: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>' },
  droplet:     { he: 'מים',         kw: 'water droplet מים',        svg: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>' },
  flame:       { he: 'גז/הסקה',     kw: 'flame gas heat גז',        svg: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>' },
  wifi:        { he: 'אינטרנט',     kw: 'wifi internet net',        svg: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/>' },
  phone:       { he: 'טלפון',       kw: 'phone call טלפון',         svg: '<path d="M13.83 16.57a1 1 0 0 0 1.21-.3l.36-.47A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.47.35a1 1 0 0 0-.29 1.23 14 14 0 0 0 6.39 6.39z"/>' },
  smartphone:  { he: 'נייד',        kw: 'smartphone mobile cell',   svg: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>' },
  wrench:      { he: 'תחזוקה',      kw: 'wrench tools repair תיקון',svg: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>' },

  // --- מזון ---
  cart:        { he: 'עגלת קניות',  kw: 'cart grocery סופר מזון',   svg: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>' },
  utensils:    { he: 'מסעדה',       kw: 'utensils food restaurant', svg: '<path d="M3 2v7c0 1.1.9 2 2 2a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>' },
  coffee:      { he: 'קפה',         kw: 'coffee cafe קפה',          svg: '<path d="M10 2v2M14 2v2M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/>' },
  pizza:       { he: 'פיצה',        kw: 'pizza fastfood',           svg: '<path d="M15 11h.01M11 15h.01M16 16h.01M2 16l20 6-6-20A20 20 0 0 0 2 16"/><path d="M5.71 17.11a17 17 0 0 1 11.4-11.4"/>' },
  apple:       { he: 'פרי/בריא',    kw: 'apple fruit healthy',      svg: '<path d="M12 6.5V3a1 1 0 0 1 1-1"/><path d="M18.63 8.13C19.5 9 20 10.13 20 11.5c0 3-2 6-4 8-1 1-2 1.5-4 1.5s-3-.5-4-1.5c-2-2-4-5-4-8C4 8.46 6 6.5 8.5 6.5c1.5 0 2.5.5 3.5 1 1-.5 2-1 3.5-1"/>' },

  // --- תחבורה ---
  car:         { he: 'רכב',         kw: 'car auto רכב תחבורה',      svg: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>' },
  fuel:        { he: 'דלק',         kw: 'fuel gas petrol דלק',      svg: '<line x1="3" x2="15" y1="22" y2="22"/><line x1="4" x2="14" y1="9" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2 2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/>' },
  bus:         { he: 'אוטובוס',     kw: 'bus transit ציבורית',      svg: '<path d="M8 6v6M15 6v6M2 12h19.6M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>' },
  plane:       { he: 'טיסה',        kw: 'plane flight travel חופשה',svg: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>' },
  bike:        { he: 'אופניים',     kw: 'bike bicycle אופניים',     svg: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>' },

  // --- קניות ---
  bag:         { he: 'שקית קניות',  kw: 'bag shopping קניות',       svg: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>' },
  package:     { he: 'חבילה',       kw: 'package online משלוח',     svg: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>' },
  shirt:       { he: 'ביגוד',       kw: 'shirt clothing ביגוד',     svg: '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>' },
  gift:        { he: 'מתנה',        kw: 'gift present מתנה',        svg: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>' },
  tag:         { he: 'תווית/מבצע',  kw: 'tag price sale מבצע',      svg: '<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.41l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".75" fill="currentColor"/>' },

  // --- בריאות וכושר ---
  health:      { he: 'בריאות',      kw: 'heart pulse health בריאות',svg: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>' },
  pill:        { he: 'תרופות',      kw: 'pill medicine תרופה',      svg: '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/>' },
  hospital:    { he: 'רפואה',       kw: 'hospital cross medical רפואה',svg: '<path d="M11 2a2 2 0 0 0-2 2v5H4a2 2 0 0 0-2 2v2c0 1.1.9 2 2 2h5v5c0 1.1.9 2 2 2h2a2 2 0 0 0 2-2v-5h5a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-5V4a2 2 0 0 0-2-2h-2z"/>' },
  dumbbell:    { he: 'כושר',        kw: 'gym fitness dumbbell כושר', svg: '<path d="M14.4 14.4 9.6 9.6"/><path d="m21.5 21.5-1.4-1.4"/><path d="M3.9 3.9 2.5 2.5"/><path d="M6.4 12.77 3.57 9.94a2 2 0 0 1 0-2.83l1.06-1.06a2 2 0 0 1 2.83 0l2.83 2.83"/><path d="m17.6 11.23 2.83 2.83a2 2 0 0 1 0 2.83l-1.06 1.06a2 2 0 0 1-2.83 0L13.7 17.66"/>' },

  // --- כספים ---
  wallet:      { he: 'ארנק',        kw: 'wallet money ארנק',        svg: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>' },
  banknote:    { he: 'שטר',         kw: 'banknote cash money מזומן', svg: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>' },
  vault:       { he: 'חיסכון',      kw: 'vault safe savings חיסכון כספת', svg: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M12 7v1.5M12 15.5V17M17 12h-1.5M8.5 12H7"/>' },
  trendingup:  { he: 'השקעה/עלייה', kw: 'trending up invest רווח',  svg: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>' },
  landmark:    { he: 'בנק',         kw: 'bank landmark בנק',         svg: '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>' },
  card:        { he: 'אשראי',       kw: 'credit card אשראי',        svg: '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>' },
  coins:       { he: 'מטבעות',      kw: 'coins money מטבע',          svg: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>' },
  percent:     { he: 'ריבית',       kw: 'percent interest ריבית',    svg: '<line x1="19" x2="5" y1="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>' },
  receipt:     { he: 'קבלה/מס',     kw: 'receipt tax bill מס קבלה',  svg: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>' },
  briefcase:   { he: 'משכורת/עבודה',kw: 'briefcase work salary משכורת',svg: '<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>' },

  // --- פנאי ---
  gamepad:     { he: 'גיימינג',     kw: 'gamepad gaming משחק',       svg: '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59c-.01.05-.01.1-.02.15C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.41.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.54-.6-6.58-.69-7.26-.01-.05-.01-.1-.02-.15A4 4 0 0 0 17.32 5z"/>' },
  film:        { he: 'סרטים',       kw: 'film movie cinema סרט',     svg: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M17 7.5h4M3 12h18M3 16.5h4M17 16.5h4"/>' },
  music:       { he: 'מוזיקה',      kw: 'music song מוזיקה',         svg: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' },
  book:        { he: 'ספרים/לימוד', kw: 'book read לימוד ספר',       svg: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>' },
  umbrella:    { he: 'נופש',        kw: 'umbrella beach vacation נופש',svg: '<path d="M12 12v8a2 2 0 0 0 4 0"/><path d="M5 12a7 7 0 0 1 14 0z"/><path d="M12 2v1"/>' },
  star:        { he: 'מועדף',       kw: 'star favorite מועדף',       svg: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' },

  // --- כללי ---
  graduation:  { he: 'חינוך',       kw: 'graduation education חינוך לימודים',svg: '<path d="M21.42 10.92a1 1 0 0 0-.02-1.84L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.83l8.57 3.91a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>' },
  baby:        { he: 'ילדים',       kw: 'baby kids children ילדים',  svg: '<path d="M9 12h.01M15 12h.01M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5"/><path d="M19 6.3a9 9 0 0 1 1.8 3.9 2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1"/>' },
  paw:         { he: 'חיות מחמד',   kw: 'paw pet dog cat חיות',      svg: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.05Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10z"/>' },
  shield:      { he: 'ביטוח',       kw: 'shield insurance ביטוח',    svg: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>' },
  scissors:    { he: 'טיפוח',       kw: 'scissors barber grooming תספורת',svg: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>' },
  calendar:    { he: 'מנוי/תאריך',  kw: 'calendar subscription מנוי',svg: '<path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>' },
  refresh:     { he: 'העברה',       kw: 'refresh transfer העברה',    svg: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>' },
  file:        { he: 'מסמך/אחר',    kw: 'file document other אחר',   svg: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8M16 17H8M10 9H8"/>' },

  // --- UI glyphs (status, affordances, document categories) ---
  // Same registry so `ic:<id>` resolves identically for a category icon and a
  // status marker; they're kept out of CAT_ICON_GROUPS so the category picker
  // grid stays a list of *categories*, not of app chrome.
  check:       { he: 'הצלחה',       kw: 'check ok success',          svg: '<path d="M20 6 9 17l-5-5"/>' },
  xmark:       { he: 'כשל',         kw: 'x fail error',              svg: '<path d="M18 6 6 18M6 6l12 12"/>' },
  alert:       { he: 'אזהרה',       kw: 'alert warning אזהרה',       svg: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>' },
  clock:       { he: 'בתהליך',      kw: 'clock pending wait',        svg: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },
  cloud:       { he: 'ענן',         kw: 'cloud drive sync',          svg: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 19z"/>' },
  cloudcheck:  { he: 'מסונכרן',     kw: 'cloud synced ok',           svg: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 19z"/><path d="m9 15 2 2 4-4"/>' },
  clouddown:   { he: 'הורדה מהענן', kw: 'cloud download',            svg: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 19"/><path d="M12 13v8M8.5 17.5 12 21l3.5-3.5"/>' },
  upload:      { he: 'העלאה',       kw: 'upload להעלות',             svg: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8 12 3 7 8"/><path d="M12 3v13"/>' },
  bug:         { he: 'באג',         kw: 'bug issue תקלה',            svg: '<path d="M8 2 9.5 4M16 2 14.5 4"/><rect width="12" height="12" x="6" y="6" rx="6"/><path d="M6 12H2M22 12h-4M6.5 8 3 6M17.5 8 21 6M6.5 16 3 18M17.5 16 21 18"/>' },
  paperclip:   { he: 'מסמך מצורף',  kw: 'clip attachment מסמך',      svg: '<path d="M13.2 9.8 8.5 14.5a2 2 0 0 0 2.8 2.8l6.4-6.4a4 4 0 1 0-5.7-5.7l-6.4 6.4a6 6 0 0 0 8.5 8.5l4.4-4.4"/>' },
  folder:      { he: 'תיקייה',      kw: 'folder תיקייה כללי',        svg: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>' },
  scroll:      { he: 'מסמך משכנתא', kw: 'scroll deed mortgage',      svg: '<path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>' },
  signature:   { he: 'חתימה/חוזה',  kw: 'signature contract חוזה',   svg: '<path d="M3 17c3.5 0 3.5-10 7-10s3.5 10 7 10c1.5 0 2.5-1 3-2"/><path d="M2 21h20"/>' },
  institution: { he: 'רשות/מיסים',  kw: 'institution tax מס',        svg: '<path d="M3 9h18M4 9V7l8-4 8 4v2"/><path d="M6 9v9M10 9v9M14 9v9M18 9v9"/><path d="M2 21h20"/>' },
  pencil:      { he: 'עריכה',       kw: 'edit pencil',               svg: '<path d="M21.17 6.83a2.83 2.83 0 0 0-4-4L3.6 16.4a2 2 0 0 0-.5.86l-1.07 3.7a.5.5 0 0 0 .62.62l3.7-1.07a2 2 0 0 0 .86-.5z"/><path d="m15 5 4 4"/>' },
  trash:       { he: 'מחיקה',       kw: 'delete trash',              svg: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>' },
  download:    { he: 'הורדה',       kw: 'download',                  svg: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>' },
  message:     { he: 'הערה',        kw: 'note comment הערה',         svg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
  sparkles:    { he: 'AI',          kw: 'ai magic sparkles',         svg: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m5.6 5.6 2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>' },
  gear:        { he: 'הגדרות',      kw: 'settings gear הגדרות',      svg: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
  link:        { he: 'קישור',       kw: 'link url',                  svg: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' },
  eye:         { he: 'הצגה',        kw: 'eye show view',             svg: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>' },
  eyeoff:      { he: 'הסתרה',       kw: 'hide eye-off',              svg: '<path d="M10.7 5.1A9 9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9 9 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>' },
  pin:         { he: 'נעיצה',       kw: 'pin bookmark',              svg: '<path d="M12 17v5"/><path d="M9 10.8V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6.8a2 2 0 0 0 .6 1.4l1.7 1.7a1 1 0 0 1-.7 1.7H6.4a1 1 0 0 1-.7-1.7l1.7-1.7a2 2 0 0 0 .6-1.4z"/>' },
  chart:       { he: 'דוח',         kw: 'chart report export',       svg: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16v-4M12 16V8M17 16v-6"/>' },
  search:      { he: 'חיפוש',       kw: 'search find',               svg: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>' },
  printer:     { he: 'הדפסה',       kw: 'print printer',             svg: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>' },
  mail:        { he: 'מייל',        kw: 'mail email gmail',          svg: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>' },
  bot:         { he: 'AI',          kw: 'bot ai robot',              svg: '<rect width="18" height="12" x="3" y="8" rx="2"/><path d="M12 2v6M8 14h.01M16 14h.01"/><path d="M2 14h1M21 14h1"/>' },
  key:         { he: 'מפתח',        kw: 'key token api',             svg: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.3-8.3 3 3-2 2-2-2-2.2 2.2 2 2-2 2-2-2"/>' },
  camera:      { he: 'מצלמה',       kw: 'camera photo screenshot',   svg: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>' },
  broom:       { he: 'ניקוי',       kw: 'clean sweep broom',         svg: '<path d="M13 11 20 4"/><path d="M14 9.5 16.5 12"/><path d="M9.5 12.5 4 18l2 2 5.5-5.5"/><path d="M11 10.5a3.5 3.5 0 0 1 4.9 4.9L11 10.5z"/>' },
  siren:       { he: 'התראה',       kw: 'alert siren anomaly',       svg: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 21h14"/><path d="M12 2v2M4.9 6.3 3.5 5M19.1 6.3 20.5 5"/>' },
  lifebuoy:    { he: 'שחזור',       kw: 'restore recovery backup',   svg: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.9 4.9 4.2 4.2M14.9 14.9l4.2 4.2M14.9 9.1l4.2-4.2M4.9 19.1l4.2-4.2"/>' },
  trendingdown:{ he: 'ירידה',       kw: 'trending down decline',     svg: '<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>' },
  flask:       { he: 'ניסוי',       kw: 'flask lab test',            svg: '<path d="M10 2v7.5L4.6 18A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-3L14 9.5V2"/><path d="M8.5 2h7M7 15h10"/>' },
  monitor:     { he: 'מערכת',       kw: 'monitor system device',     svg: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>' },
  sun:         { he: 'בהיר',        kw: 'sun light theme',           svg: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
  moon:        { he: 'כהה',         kw: 'moon dark theme',           svg: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>' },
}

// Ordered groups for the picker. Each references ids from CAT_ICON_META.
const CAT_ICON_GROUPS = [
  { label: 'בית ודיור',     ids: ['home','building','lightbulb','zap','droplet','flame','wifi','phone','smartphone','wrench'] },
  { label: 'מזון',          ids: ['cart','utensils','coffee','pizza','apple'] },
  { label: 'תחבורה',        ids: ['car','fuel','bus','plane','bike'] },
  { label: 'קניות',         ids: ['bag','package','shirt','gift','tag'] },
  { label: 'בריאות וכושר',  ids: ['health','pill','hospital','dumbbell'] },
  { label: 'כספים',         ids: ['wallet','banknote','vault','trendingup','landmark','card','coins','percent','receipt','briefcase'] },
  { label: 'פנאי',          ids: ['gamepad','film','music','book','umbrella','star'] },
  { label: 'כללי',          ids: ['graduation','baby','paw','shield','scissors','calendar','refresh','file'] },
]

// Renamed glyphs. Stored category icons ('ic:<id>') live in user data, so an
// id can never simply disappear — it resolves here instead.
const CAT_ICON_ALIAS = { piggy: 'vault' }

function _catIconSvg(id, size = 18) {
  const m = CAT_ICON_META[id] || CAT_ICON_META[CAT_ICON_ALIAS[id]]
  if (!m) return ''
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block">${m.svg}</svg>`
}

// Primary render helper — use everywhere a category icon is shown in HTML.
// Returns inline tinted SVG for 'ic:*' icons, the raw emoji otherwise.
function catIconHTML(cat, size = 18) {
  if (!cat) return ''
  const ic = cat.icon || ''
  if (ic.indexOf('ic:') === 0) {
    const svg = _catIconSvg(ic.slice(3), size)
    if (svg) return `<span class="cat-ic" style="color:${cat.color || 'currentColor'}">${svg}</span>`
  }
  return ic ? `<span class="cat-emoji">${ic}</span>` : ''
}

// Status / affordance glyph outside the category system. The app carries no
// emoji, so every "✅/⚠/☁" style marker goes through here; `color` is a CSS
// colour (usually a var) and `label` becomes the accessible name.
function uiIcon(id, size = 16, color = 'currentColor', label = '') {
  const svg = _catIconSvg(id, size)
  if (!svg) return ''
  const a = label ? ` role="img" aria-label="${String(label).replace(/"/g, '&quot;')}"` : ''
  return `<span class="ui-ic" style="color:${color}"${a}>${svg}</span>`
}

// Text-only fallback for <option> contexts (selects can't hold SVG). Legacy
// emoji still show; SVG-keyed icons yield '' so only the name renders.
function catIconText(cat) {
  if (!cat) return ''
  const ic = cat.icon || ''
  return ic.indexOf('ic:') === 0 ? '' : ic
}

// ===== ICON PICKER UI =====
// Self-contained markup: a hidden input (<inputId>) holds the chosen value,
// a live preview + search box sit above a grouped grid of SVG buttons. Both
// the add-category form and the edit modal embed this.
function iconPickerMarkup(inputId, value) {
  const cur = value || ''
  const previewHTML = catIconHTML({ icon: cur, color: 'var(--accent)' }, 24) || '<span style="color:var(--text-muted);font-size:.8rem">בחר אייקון</span>'
  const groups = CAT_ICON_GROUPS.map(g => {
    const btns = g.ids.map(id => {
      const m = CAT_ICON_META[id]; if (!m) return ''
      const val = 'ic:' + id
      const sel = val === cur ? ' selected' : ''
      const kw = `${m.he} ${m.kw}`.replace(/"/g, '')
      return `<button type="button" class="icon-pick-btn${sel}" data-kw="${kw}" title="${m.he}" onclick="selectCatIcon('${inputId}','${val}',this)">${_catIconSvg(id, 22)}</button>`
    }).join('')
    return `<div class="icon-pick-group"><div class="icon-pick-group-label">${g.label}</div><div class="icon-pick-row">${btns}</div></div>`
  }).join('')
  return `
    <input type="hidden" id="${inputId}" value="${cur}">
    <div class="icon-picker">
      <div class="icon-picker-head">
        <span class="icon-picker-preview" id="${inputId}_prev">${previewHTML}</span>
        <input type="text" class="icon-picker-search" placeholder="חיפוש אייקון…" oninput="filterIconPicker('${inputId}',this.value)">
      </div>
      <div class="icon-picker-grid" id="${inputId}_grid">${groups}</div>
    </div>`
}

function selectCatIcon(inputId, value, btn) {
  const inp = document.getElementById(inputId)
  if (inp) inp.value = value
  const grid = document.getElementById(inputId + '_grid')
  if (grid) grid.querySelectorAll('.icon-pick-btn.selected').forEach(b => b.classList.remove('selected'))
  if (btn) btn.classList.add('selected')
  const prev = document.getElementById(inputId + '_prev')
  if (prev) prev.innerHTML = catIconHTML({ icon: value, color: 'var(--accent)' }, 24)
}

function filterIconPicker(inputId, term) {
  const grid = document.getElementById(inputId + '_grid')
  if (!grid) return
  const t = String(term || '').trim().toLowerCase()
  grid.querySelectorAll('.icon-pick-group').forEach(g => {
    let any = false
    g.querySelectorAll('.icon-pick-btn').forEach(b => {
      const show = !t || (b.getAttribute('data-kw') || '').toLowerCase().includes(t)
      b.style.display = show ? '' : 'none'
      if (show) any = true
    })
    g.style.display = any ? '' : 'none'
  })
}

// ===== MIGRATION: seed SVG icons for existing categories =====
// System categories map by id (precise); user categories map best-effort by
// their current emoji. Anything unmapped keeps its emoji and still renders.
const _SYS_CAT_ICON = {
  cat_food: 'cart', cat_rest: 'utensils', cat_transport: 'car', cat_fuel: 'fuel',
  cat_rent: 'home', cat_bills: 'lightbulb', cat_health: 'hospital', cat_clothing: 'shirt',
  cat_leisure: 'gamepad', cat_insurance: 'shield', cat_bank: 'landmark', cat_online: 'package',
  cat_invest_out: 'vault', cat_other_exp: 'file', cat_salary: 'briefcase', cat_extra: 'banknote',
  cat_taxback: 'receipt', cat_invest: 'trendingup', cat_other_inc: 'file', cat_transfer: 'refresh',
}
const _EMOJI_CAT_ICON = {
  '🛒': 'cart', '🍽️': 'utensils', '🍽': 'utensils', '🚗': 'car', '⛽': 'fuel',
  '🏠': 'home', '🏡': 'home', '💡': 'lightbulb', '⚡': 'zap', '💧': 'droplet',
  '🔥': 'flame', '📶': 'wifi', '📱': 'smartphone', '☎️': 'phone', '📞': 'phone',
  '🍔': 'utensils', '🍕': 'pizza', '☕': 'coffee', '🍎': 'apple', '🚌': 'bus',
  '✈️': 'plane', '🚲': 'bike', '🛍️': 'bag', '📦': 'package', '👕': 'shirt',
  '🎁': 'gift', '🏷️': 'tag', '❤️': 'health', '💊': 'pill', '🏥': 'hospital',
  '💪': 'dumbbell', '🏋️': 'dumbbell', '👛': 'wallet', '💵': 'banknote', '💴': 'banknote',
  '💰': 'vault', '🐷': 'vault', '📈': 'trendingup', '🏦': 'landmark', '💳': 'card',
  '🪙': 'coins', '🧾': 'receipt', '💼': 'briefcase', '🎮': 'gamepad', '🎬': 'film',
  '🎵': 'music', '🎶': 'music', '📚': 'book', '📖': 'book', '⛱️': 'umbrella',
  '🏖️': 'umbrella', '⭐': 'star', '🎓': 'graduation', '👶': 'baby', '🐾': 'paw',
  '🛡️': 'shield', '✂️': 'scissors', '📅': 'calendar', '🔄': 'refresh', '📋': 'file',
  '📑': 'receipt', '🔧': 'wrench', '🛠️': 'wrench',
}
function migrateCategoryIconsToSvg_v1() {
  if (localStorage.getItem('migration_cat_icons_svg_v1') === '1') return
  if (typeof getCategories !== 'function') return
  const cats = getCategories()
  let changed = false
  for (const c of cats) {
    if (!c || (c.icon && c.icon.indexOf('ic:') === 0)) continue
    let id = c.system ? _SYS_CAT_ICON[c.id] : null
    if (!id && c.icon) id = _EMOJI_CAT_ICON[c.icon.trim()]
    if (id && CAT_ICON_META[id]) { c.icon = 'ic:' + id; changed = true }
  }
  if (changed) DB.set('finCategories', cats)
  localStorage.setItem('migration_cat_icons_svg_v1', '1')
}

// Rewrites renamed ids in stored categories so the icon picker still shows the
// current selection (rendering already works through CAT_ICON_ALIAS).
function migrateRenamedCatIcons_v1() {
  if (localStorage.getItem('migration_cat_icon_rename_v1') === '1') return
  if (typeof getCategories !== 'function') return
  const cats = getCategories()
  let changed = false
  for (const c of cats) {
    const id = c && c.icon && c.icon.indexOf('ic:') === 0 ? c.icon.slice(3) : ''
    if (id && CAT_ICON_ALIAS[id]) { c.icon = 'ic:' + CAT_ICON_ALIAS[id]; changed = true }
  }
  if (changed) DB.set('finCategories', cats)
  localStorage.setItem('migration_cat_icon_rename_v1', '1')
}
