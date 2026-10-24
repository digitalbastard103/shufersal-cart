# Shufersal website endpoints

Everything here was recorded from real browser sessions on
`https://www.shufersal.co.il` (October 2026) with personal data removed. These
are the website's **internal** endpoints (SAP Commerce / "Hybris"), not a
published API: they can change at any time. When something breaks, record a
new HAR and update this file first (see CONTRIBUTING.md).

"Source" says how each contract is known:
**captured** = seen in a recorded request/response;
**JS** = found in the site's own JavaScript, then **verified live** read-only.

## Conventions

- Base: `https://www.shufersal.co.il`. All paths below start with `/online/he`.
- Session: cookies (set by login, rotated on responses). `HttpSession` keeps
  them in a jar.
- AJAX calls send `X-Requested-With: XMLHttpRequest`.
- **CSRF:** every page has `<meta name="_csrf" content="<uuid>">`. JSON POSTs
  send it as the `csrftoken` header; form POSTs send it as the `CSRFToken` field.
- Errors: a refused request comes back as 403/429. The tool stops; it never retries.

## Login

### `GET /login` — captured
Login page HTML; carries the CSRF meta tag.

### `POST /j_spring_security_check` — captured
Spring Security form login. `Content-Type: application/x-www-form-urlencoded`.

| Field | Value |
|---|---|
| `fail_url` | `/login/?error=true` |
| `j_username` | account email |
| `j_password` | password |
| `remember-me` | `True` |
| `CSRFToken` | from the login page |

- Success: `302 → /login?redirect_url=… → 302 → /A` (home).
- Failure: `302 → /login/?error=true`.
- The recorded login had **no captcha and no SMS code**; the account data
  after login showed `strongAuth: false`.
- The site's code does contain OTP flows (`/otp/send/…`, `/otp/validate`) and a
  reCAPTCHA widget on the *checkout re-authentication* form, so either could
  appear on login in the future. The tool treats any non-success as a
  rejection and does not retry.

### `GET /authentication/get-status-includes-otp` — captured
JSON `true` / `false`: whether the browser session is logged in.

### `GET /checkout/address/list` — captured
JSON array of saved addresses (personal data). Used **only** as the signed-in
probe: non-empty array = signed in. Never printed or stored.

## Search

### `GET /search/results?q=<text>:relevance&limit=<n>` — captured
`:relevance` is the sort suffix, so strip `:` from user text.

**Exact lookup by מקט (verified live):** searching for a product's `sku`
(the מקט shown on its product page, also the digits of its `P_` code) returns
exactly that product — e.g. `q=4131074` → only `P_4131074`. Where the מקט is
the package barcode, the barcode works too; otherwise the barcode is not
searchable. `ean` was `null` on every product checked. Searching for the
literal text `P_4131074` does **not** work (it is treated as words).

JSON (abridged; values illustrative):

```jsonc
{
  "results": [{
    "code": "P_7296073219347",           // product code used everywhere else
    "sku": "7296073219347",              // the מקט; searchable exactly
    "ean": null,
    "name": "לחם אחיד פרוס",
    "brandName": "שופרסל",
    "unitDescription": "…",               // size/pack text, free-form
    "sellingMethod": { "code": "BY_UNIT" }, // BY_UNIT | BY_WEIGHT | BY_PACKAGE
    "stock": { "stockLevelStatus": { "code": "inStock" } }, // or "outOfStock"
    "price": { "value": 8.38, "formattedValue": "8.38 ₪" }
    // …~100 more fields
  }],
  "pagination": { "totalNumberOfResults": 482 }
}
```

## Cart

All cart endpoints answer with **mini-cart HTML**. Each line is:

```html
<article class="miglog-prod miglog-sellingmethod-by_unit …"
         data-product-code="P_4130800" data-entry-number="3" data-entry-qty="2.0">
  … <h3 class="… miglog-prod-name"><a …>מיץ תפוזים טבעי</a></h3>
  … <input data-miglog-sellingmethod = "BY_UNIT" …>        <!-- method when not on the article -->
  … <p class="miglog-text2 miglog-prod-totalPrize "> 23.80<span>₪</span></p>
</article>
```

### `GET /cart/load?restoreCart=true` — captured
The current cart (mini-cart HTML).

### `POST /cart/addGrid?cartContext[openFrom]=LIST&cartContext[recommendationType]=REGULAR` — captured
The site's "add all to cart". JSON body, `csrftoken` header:

```json
[{ "productCode": "P_4130800", "quantity": 2, "frontQuantity": 2,
   "sellingMethod": "BY_UNIT", "comment": "", "longTail": false }]
```

Returns the updated mini-cart. (`POST /cart/add` adds a single product with
`{productCodePost, productCode, sellingMethod, qty, frontQuantity, comment,
affiliateCode}`; also captured, no longer used.)

### `POST /cart/update?…` — captured
Change a quantity or remove a line. Form body `quantity=<n>&CSRFToken=<t>`.
Query, in this order:

| Change quantity | Remove |
|---|---|
| `entryNumber=<n>` | `entryNumber=<n>` |
| `qty=<n>` | `qty=0` |
| `sellingMethod=BY_UNIT` | `sellingMethod=` (empty) |
| `comment=` | — |
| `cartContext[openFrom]=CART` | `cartContext[openFrom]=CART` |
| `cartContext[recommendationType]=REGULAR` | `cartContext[recommendationType]=REGULAR` |
| — | `cartContext[action]=remove` |

**`entryNumber` shifts after every removal** (lines after it are renumbered).
Always take it from a cart read made just before the request.

### `GET /cart/cartsummary` — captured
Cart page HTML. The amount to pay, after cart-level promotions:

```html
<div class="totalPrice … miglog-cart-summary-totalprice"> 312.40 ₪ …
… סה”כ חסכת: ₪ 18.60
<span … id="cartTotalItems">28</span>
```

The mini-cart from `cart/load` carries the same class with a different,
pre-promotion number — use this page's figure.

## Delivery windows

### `GET /timeSlot/preselection/getHomeDeliverySlots?amount=1.0&prescription=false` — captured
`{ "YYYYMMDD": [slot, …], … }` for the default address. A slot:

```jsonc
{ "code": "100000001", "fromHour": 1793520000000, "toHour": 1793527200000,
  "fromHourString": "2026/11/01 10:00", "selectable": true,
  "price": { "formattedValue": "35.90 ₪" }, "deliveryZone": { "code": "area_…" } /* … */ }
```

### `GET /timeSlot/preselection/getSelectedTimeslot` — captured
The chosen slot, or the same shape with all fields `null` when none.
(A visit to checkout was seen to clear the selection.)

### `POST /timeSlot/preselection/postHomeDeliverySlot` — captured
JSON `{ "homeDeliveryTimeSlot": <the slot object exactly as listed> }`,
`csrftoken` header → `true`. Pre-selects only; nothing is ordered.

## Order history

### `GET /my-account/orders` — captured
`{ activeOrders: [...], closedOrders: [...] }`; each has `code`,
`createdString` ("2026/03/02 10:15"), `totalPrice.value`, `totalItems`,
and personal fields (address, payment, email) that the tool never reads.

### `GET /my-account/orders/<code>` — captured
Order with `entries[]`: `{ quantity, product: { code, name, sellingMethod: {code},
stock, deliveryItem } }`.

- `deliveryItem: true` marks delivery-fee lines (e.g. "משלוח שופרסל אונליין");
  they are not products.
- For `BY_PACKAGE`/`BY_WEIGHT`, `quantity` is not units (350 = 350 g).

## Saved lists

### `GET /wishlist/getUserWishlists` — captured
`[{ shoppingListId, name, entriesNumber, … }]` (no items).

### `GET /wishlist/getWishlist?listId=<id>` — JS, verified live
`{ name, entries: [{ quantity, unitOfMeasure: "BY_UNIT", product: { productCode,
isOutOfStock, isInCart, product: { name, … } } }] }`.

## Not used, on purpose

- `/checkout/*` (beyond the signed-in probe), `/checkout/payment/paymentModes`,
  `/cart/checkout/auth`: checkout and payment are out of scope.
- `/otp/*`, captcha endpoints: never automated.
