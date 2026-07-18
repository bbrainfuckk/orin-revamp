import type { CatalogItem } from './commerce.js';

type ServiceSeed = readonly [name: string, priceCentavos: number, detail?: string];
type CategorySeed = readonly [name: string, services: readonly ServiceSeed[]];
type WhitenCard = {
  title: string;
  subtitle: string;
  image_url: string;
  buttons: Array<{ type: 'postback'; title: string; payload: string }>;
};

const PHOTOS = [
  'https://assets.parlon.ph/Branch%20Photos/2410/360125286_242566238672123_8448684004067423723_n.jpg',
  'https://assets.parlon.ph/Branch%20Photos/2410/368978299_259050900356990_5013846551601526376_n.jpg',
  'https://assets.parlon.ph/Branch%20Photos/2410/352800057_217343441194403_6358335487918821670_n.jpg',
  'https://assets.parlon.ph/Branch%20Photos/2410/373608336_265101969751883_7460251380879717698_n.jpg',
] as const;

const CATEGORIES: readonly CategorySeed[] = [
  ['Nail Care', [
    ['Manicure (Cleaning Only)', 20000],
    ['Manicure (Regular Polish)', 25000],
    ['Manicure (Gel Polish)', 50000],
    ['Pedicure (Cleaning Only)', 20000],
    ['Pedicure (Regular Polish)', 30000],
    ['Pedicure (Gel Polish)', 60000],
    ['Nail Extension', 170000],
    ['Gel Removal', 20000],
    ['Change Polish', 20000],
  ]],
  ['Spa Services', [
    ['Foot Spa', 30000],
    ['Foot Spa + Pedicure', 55000],
    ['Hand Paraffin + Manicure', 55000],
    ['Foot Paraffin + Pedicure', 60000],
    ['Gel Manicure + Foot Spa', 75000],
    ['Gel Pedicure + Foot Spa', 85000],
    ['Manicure + Pedicure + Foot Spa', 80000],
    ['Foot Spa + Paraffin + Pedicure', 85000],
  ]],
  ['Eyelashes', [
    ['Human Hair Extension', 80000],
    ['Silk Extension', 70000],
    ['Lash Lift with Tint', 60000],
  ]],
  ['Threading', [
    ['Eyebrow', 20000],
    ['Upper Lip', 20000],
    ['Underarms', 30000],
  ]],
  ['Picolaser Treatment', [
    ['Face', 349900, 'Package: ₱17,500 (5+3 free)'],
    ['Underarms or Knees', 199900, 'Package: ₱10,000 (5+3 free)'],
    ['Bikini Line', 149900, 'Package: ₱7,500 (5+3 free)'],
    ['Nape', 149900, 'Package: ₱7,500 (5+3 free)'],
    ['Elbow', 99900, 'Package: ₱5,000 (5+3 free)'],
    ['Back', 399900, 'Package: ₱20,000 (5+3 free)'],
    ['Lower Legs', 399900],
    ['Full Sleeves', 399900],
    ['Groin and Butt', 399900, 'Package: ₱20,000 (5+3 free)'],
    ['IPL + Picolaser (Underarms)', 219900, 'Package: ₱11,000 (5+3 free)'],
  ]],
  ['IPL Hair Removal & Skin Rejuvenation', [
    ['Upper Lip · IPL', 29900], ['Upper Lip · Skin Rejuvenation', 29900], ['Upper Lip · IPL + SR', 49900],
    ['Beard · IPL', 59900], ['Beard · Skin Rejuvenation', 59900], ['Beard · IPL + SR', 89900],
    ['Underarms · IPL', 49900], ['Underarms · Skin Rejuvenation', 49900], ['Underarms · IPL + SR', 69900],
    ['Butt Area · IPL', 69900], ['Butt Area · Skin Rejuvenation', 69900], ['Butt Area · IPL + SR', 119900],
    ['Bikini Line · IPL', 79900], ['Bikini Line · Skin Rejuvenation', 79900], ['Bikini Line · IPL + SR', 149900],
    ['Brazilian · IPL', 99900], ['Brazilian · Skin Rejuvenation', 99900], ['Brazilian · IPL + SR', 179900],
    ['Tummy or Back · IPL', 149900], ['Tummy or Back · Skin Rejuvenation', 149900], ['Tummy or Back · IPL + SR', 219900],
    ['Lower Legs · IPL', 169900], ['Lower Legs · Skin Rejuvenation', 169900], ['Lower Legs · IPL + SR', 299900],
    ['Full Sleeves · IPL', 189900], ['Full Sleeves · Skin Rejuvenation', 189900], ['Full Sleeves · IPL + SR', 339900],
    ['Full Legs · IPL', 299900], ['Full Legs · Skin Rejuvenation', 299900], ['Full Legs · IPL + SR', 559900],
  ]],
  ['Facial Services', [
    ['Hydra Glass-skin Facial', 199900],
    ['WhiteN Facial', 39900],
    ['PDT Light', 39900],
    ['Galvanic Collagen Facial', 49900],
    ['Ultrasonic Scrubber Facial', 49900],
    ['WhiteN Facial with PDT', 59900],
    ['Diamond Peel', 59900],
    ['Diamond Peel with Galvanic Facial', 79900],
    ['Diamond Peel with Oxygen Facial', 119900],
  ]],
  ['Wart Removal', [
    ['Face', 99900],
    ['Neck', 99900],
    ['Face and Neck', 199900],
    ['Other Body Parts', 0, 'Quotation starts at ₱499'],
  ]],
  ["Doctor's Procedure", [
    ['Fillers (Face/Body)', 0, 'Quotation starts at ₱7,999'],
    ['Barbie Forehead', 2999900],
    ['Hiko Instant Nose Lift', 999900],
    ["Sclerotherapy 'Vein Removal'", 0, 'Quotation starts at ₱1,500'],
    ['Botox (Forehead, Eyes, Nose, Underarms, Jaw, Hands)', 0, 'Quotation starts at ₱99'],
    ['Alartox', 599900],
    ['Sweatox', 999900],
    ['Barbie Arms (100 units)', 999900],
    ['Mono Threads', 799900],
    ['Fox Eyes', 999900],
    ['Brow Lift', 999900],
    ['PDO Face Lift', 1499900],
  ]],
  ['Thermagen', [
    ['Eyes', 1199900],
    ['Face', 2499900],
    ['Eyes + Face', 3199900],
    ['Arms', 2999900],
    ['Tummy', 2999900],
    ['Thighs', 3499900],
  ]],
  ['HIFU', [
    ['Face and Neck (200 Shots)', 499900, 'Unlimited: ₱9,999'],
    ['Arms (300 Shots)', 599900, 'Unlimited: ₱10,999'],
    ['Tummy or Thighs', 999900, 'Unlimited: ₱14,999'],
  ]],
  ['Korean BB Glow', [
    ['BB Foundation', 249900],
    ['BB Foundation with Blush', 299900],
    ['Blush Add-ons', 50000],
    ['PDT Light', 39900],
    ['BB Foundation 5+2 Package', 1249900],
  ]],
  ['Microneedling', [
    ['Face', 299900, 'Package: ₱11,999 (4+1)'],
    ['Face and Neck', 349900, 'Package: ₱13,999 (4+1)'],
    ['Underarms', 299900, 'Package: ₱11,999 (4+1)'],
    ['Thighs', 449900, 'Package: ₱17,999 (4+1)'],
    ['Buttocks', 449900, 'Package: ₱17,999 (4+1)'],
    ['Tummy', 449900, 'Package: ₱17,999 (4+1)'],
  ]],
  ['Exilis Extreme', [
    ['Bra-line', 149900],
    ['Arms', 199900],
    ['Inner and Outer Thighs', 249900],
    ['Whole Face', 299900],
    ['Tummy', 399900],
  ]],
  ['Gluta Drips', [
    ['Advance Celestial Drip', 249900, 'Packages: 5+1 ₱12,500 · 10+2 ₱25,000'],
    ['Fuji Drip', 169900, 'Packages: 5+1 ₱8,500 · 10+2 ₱17,000'],
    ['Cinderella Drip', 209900, 'Packages: 5+1 ₱10,500 · 10+2 ₱21,000'],
    ['Whitening Gluta Drip', 159900, 'Packages: 5+1 ₱8,000 · 10+2 ₱16,000'],
    ['Anti-Aging Drip', 79900, 'Package: 5+1 ₱5,000'],
    ["Belle's Glow (Push)", 69900, 'Package: 5+1 ₱3,500'],
  ]],
  ['Add-ons', [
    ['Collagen with Vitamin C (1000 mg)', 40000],
    ['Placenta (1000 mg)', 40000],
    ['Stem Cell (1200 mg)', 40000],
    ['Vitamin C (1000 mg)', 30000],
    ['Vitamin B (400 mg)', 30000],
    ['Gluta (4000 mg)', 50000],
    ['L-Carnitine (5000 mg)', 50000],
    ['Whitening Booster', 40000],
  ]],
] as const;

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 42);
const peso = (centavos: number) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(centavos / 100);

export const WHITEN_CATEGORIES = CATEGORIES.map(([name, services], categoryIndex) => {
  const categoryId = slug(name);
  const imageUrl = PHOTOS[categoryIndex % PHOTOS.length];
  const items = services.map(([itemName, priceCentavos, detail], itemIndex): CatalogItem => ({
    id: `whiten_${categoryId}_${itemIndex}`,
    name: itemName,
    kind: 'service',
    description: [name, detail].filter(Boolean).join(' · '),
    priceCentavos,
    quoteOnly: priceCentavos === 0,
    stock: -1,
    variants: [],
    imageUrl,
    active: true,
  }));
  return { id: categoryId, name, imageUrl, items };
});

const ITEMS = new Map(WHITEN_CATEGORIES.flatMap((category) => category.items.map((item) => [item.id, item])));

export function whitenItemById(id: string) {
  return ITEMS.get(id) || null;
}

function genericTemplate(recipientId: string, elements: WhitenCard[]) {
  return {
    recipient: { id: recipientId },
    messaging_type: 'RESPONSE',
    message: { attachment: { type: 'template', payload: { template_type: 'generic', elements } } },
  };
}

export function buildWhitenCategoryCatalog(recipientId: string, page = 0) {
  const perPage = 9;
  const pages = Math.ceil(WHITEN_CATEGORIES.length / perPage);
  const current = Math.max(0, Math.min(pages - 1, page));
  const elements: WhitenCard[] = WHITEN_CATEGORIES.slice(current * perPage, (current + 1) * perPage).map((category) => ({
    title: category.name,
    subtitle: `${category.items.length} available services`,
    image_url: category.imageUrl,
    buttons: [{ type: 'postback', title: 'View services', payload: `ORIN_WHITEN:CATEGORY:${category.id}:0` }],
  }));
  elements.push({
    title: `Whiten service menu · ${current + 1} of ${pages}`,
    subtitle: current + 1 < pages ? 'Continue to the remaining service categories.' : 'Return to the first group of categories.',
    image_url: PHOTOS[(current + 1) % PHOTOS.length],
    buttons: [{ type: 'postback', title: current + 1 < pages ? 'More categories' : 'First categories', payload: `ORIN_WHITEN:CATEGORIES:${current + 1 < pages ? current + 1 : 0}` }],
  });
  return genericTemplate(recipientId, elements);
}

export function buildWhitenServiceCatalog(recipientId: string, categoryId: string, page = 0) {
  const category = WHITEN_CATEGORIES.find((entry) => entry.id === categoryId);
  if (!category) return null;
  const perPage = 9;
  const pages = Math.ceil(category.items.length / perPage);
  const current = Math.max(0, Math.min(pages - 1, page));
  const elements: WhitenCard[] = category.items.slice(current * perPage, (current + 1) * perPage).map((item) => ({
    title: item.name.slice(0, 80),
    subtitle: `${item.quoteOnly ? 'Quotation required' : peso(item.priceCentavos)}${item.description ? ` · ${item.description}` : ''}`.slice(0, 80),
    image_url: item.imageUrl,
    buttons: [{
      type: 'postback',
      title: item.quoteOnly ? 'Request quote' : 'Book & pay',
      payload: `ORIN_COMMERCE:ADD:${item.id}:0`,
    }],
  }));
  elements.push({
    title: `${category.name} · ${current + 1} of ${pages}`,
    subtitle: current + 1 < pages ? 'Continue through this service category.' : 'Choose another Whiten service category.',
    image_url: category.imageUrl,
    buttons: [{
      type: 'postback',
      title: current + 1 < pages ? 'More services' : 'All categories',
      payload: current + 1 < pages ? `ORIN_WHITEN:CATEGORY:${category.id}:${current + 1}` : 'ORIN_WHITEN:CATEGORIES:0',
    }],
  });
  return genericTemplate(recipientId, elements);
}

export function parseWhitenAction(payload: string) {
  const categories = /^ORIN_WHITEN:CATEGORIES:(\d{1,2})$/.exec(payload);
  if (categories) return { type: 'categories' as const, page: Number(categories[1]) };
  const category = /^ORIN_WHITEN:CATEGORY:([a-z0-9_]{1,48}):(\d{1,2})$/.exec(payload);
  return category ? { type: 'category' as const, categoryId: category[1], page: Number(category[2]) } : null;
}
