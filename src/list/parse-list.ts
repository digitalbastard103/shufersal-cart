/**
 * Plain-text shopping list -> structured items.
 *
 * Quantity is only taken from an explicit multiplier (`x2`, `×2`, `*2`, or a
 * leading `2 x`). A bare number stays part of the search text, because in
 * product names it almost always is one: "ביצים L 12", "חלב 3%", "קוקה קולה 1.5".
 */

export type ListItem = {
  /** 1-based line number in the source file, for error messages. */
  line: number;
  raw: string;
  /** Search text. Empty when `productCode` is given. */
  query: string;
  /** An exact Shufersal product code (`P_...`), when the line pins one. */
  productCode?: string;
  /** A מקט (as shown on the Shufersal product page) given on its own: looked up exactly, never fuzzy-matched. */
  sku?: string;
  quantity: number;
  /** A weight in kg for a product sold by weight: "בננה 1.5 ק\"ג", "P_964775 1.5kg". */
  weightKg?: number;
  /** Text after " #" on the line, e.g. the product name next to a pinned code. */
  note?: string;
};

export type ListError = { line: number; raw: string; reason: string };

export type ParsedList = { items: ListItem[]; errors: ListError[] };

/** Anything above this is far more likely a typo than an intended order. */
export const MAX_QUANTITY = 30;

const TRAILING_QTY = /\s*(?:x|×|\*)\s*(\d+)\s*$/i;
/** A trailing weight: 1.5 ק"ג, 1.5 קג, 2 קילו, 0.5kg. */
const TRAILING_WEIGHT = /\s+(\d+(?:[.,]\d+)?)\s*(?:ק["״]?ג|קילו|kg)\s*$/i;
/** The most weight one line may ask for; the site's own ceiling is checked when the product is known. */
export const MAX_WEIGHT_KG = 100;
const LEADING_QTY = /^(\d+)\s*(?:x|×|\*)\s+/i;
/** A Shufersal product code; variants carry a suffix, e.g. P_7296073409441_42. */
const PRODUCT_CODE = /^P_\d+(?:_\d+)?$/i;
/** A multiplier that is present but not a whole number: x1.5, x-2, xabc, 1.5 x ... */
const BAD_TRAILING_QTY = /\s+(?:x|×|\*)\s*(\S+)\s*$/i;
const BAD_LEADING_QTY = /^([-+]?[\d.,]+)\s*(?:x|×|\*)\s+/i;
const NUMBER_LIKE = /^[-+]?[\d.,]+$/;
/** A line that is only a number (4-14 digits) is a מקט. That is the site's own product number - for some products the package barcode, for many a shorter internal number. */
const SKU = /^\d{4,14}$/;

export function parseList(text: string): ParsedList {
  const items: ListItem[] = [];
  const errors: ListError[] = [];

  text.split(/\r?\n/).forEach((source, index) => {
    const line = index + 1;
    // A " #" after an item starts a note: "P_4131074 x2   # Tnuva milk".
    const noteMatch = /\s+#(.*)$/.exec(source);
    const note = noteMatch?.[1]?.trim() || undefined;
    const raw = source.replace(/\s+#.*$/, '').trim();
    if (raw === '' || raw.startsWith('#')) return;

    let rest = raw;
    let quantity = 1;
    let weightKg: number | undefined;

    const weight = TRAILING_WEIGHT.exec(rest);
    if (weight) {
      weightKg = Number(weight[1]!.replace(',', '.'));
      if (!(weightKg > 0 && weightKg <= MAX_WEIGHT_KG)) {
        errors.push({ line, raw, reason: `weight must be above 0 and at most ${MAX_WEIGHT_KG} kg` });
        return;
      }
      rest = rest.slice(0, weight.index).trim();
    }

    const trailing = weightKg === undefined ? TRAILING_QTY.exec(rest) : null;
    const leading = trailing || weightKg !== undefined ? null : LEADING_QTY.exec(rest);
    const match = trailing ?? leading;
    if (match) {
      quantity = Number.parseInt(match[1]!, 10);
      rest = trailing ? rest.slice(0, trailing.index) : rest.slice(match[0].length);
      rest = rest.trim();
    } else {
      // A malformed multiplier must not become part of a fuzzy search. It is
      // always an error after a pinned code or מקט, and after free text when it
      // looks like a number (x1.5, x-2); "xabc" after free text may be a name.
      const badTrailing = BAD_TRAILING_QTY.exec(rest);
      const before = badTrailing ? rest.slice(0, badTrailing.index).trim() : '';
      const pinned = PRODUCT_CODE.test(before) || SKU.test(before);
      if ((badTrailing && (pinned || NUMBER_LIKE.test(badTrailing[1]!))) || BAD_LEADING_QTY.test(rest)) {
        errors.push({ line, raw, reason: `quantity must be a whole number between 1 and ${MAX_QUANTITY}` });
        return;
      }
    }

    if (quantity < 1 || quantity > MAX_QUANTITY) {
      errors.push({ line, raw, reason: `quantity must be between 1 and ${MAX_QUANTITY}` });
      return;
    }
    if (rest === '') {
      errors.push({ line, raw, reason: 'no product text' });
      return;
    }

    if (SKU.test(rest)) {
      items.push({ line, raw, query: '', sku: rest, quantity, ...(weightKg ? { weightKg } : {}), ...(note ? { note } : {}) });
      return;
    }

    if (PRODUCT_CODE.test(rest)) {
      items.push({ line, raw, query: '', productCode: rest.toUpperCase(), quantity, ...(weightKg ? { weightKg } : {}), ...(note ? { note } : {}) });
      return;
    }

    // ':' is the site's query/sort separator ("text:relevance").
    items.push({ line, raw, query: rest.replace(/:/g, ' ').replace(/\s+/g, ' ').trim(), quantity, ...(weightKg ? { weightKg } : {}), ...(note ? { note } : {}) });
  });

  return { items, errors };
}
