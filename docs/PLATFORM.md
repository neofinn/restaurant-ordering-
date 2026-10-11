# Platform mode: many restaurants, your gateway and riders, weekly payouts

One server runs any number of restaurants, the way Swiggy and Zomato do for
money and delivery, but each restaurant keeps **its own branded ordering site**:

| Address | What it is |
|---|---|
| `order.example.com/` | Marketplace: restaurants that deliver to the customer, nearest first. Each links to the restaurant's site with the location filled in. |
| `order.example.com/platform/` | Platform admin: restaurants, ledger, weekly payouts, Connections. |
| `<slug>.order.example.com` or the restaurant's own domain | The restaurant's customer app, outlet panel (`/outlet/`) and head office (`/admin/`), the same as a single-restaurant install, minus Connections. |
| `order.example.com/webhooks/*` | One webhook URL each for Razorpay, WhatsApp, Shadowfax, Porter and Borzo. Every call is passed to the restaurant it is about. |

Start it with `npm run platform`. The single-restaurant server (`npm start`)
still works unchanged for clients who want their own install.

## How the money moves

1. The customer pays through **the platform's Razorpay** (pay-first, as before).
2. When the order is **delivered**, the ledger records it:

   | | |
   |---|---|
   | food value | items + packing |
   | commission | food value × the restaurant's commission % |
   | GST on commission | 18% (`COMMISSION_GST_PCT`) |
   | TDS 194-O | food value × `TDS_194O_PCT` (0.1%) |
   | PG fee | order total × `RESTAURANT_PG_FEE_PCT` (0 = platform absorbs it) |
   | food GST | kept by the platform to deposit under section 9(5) (`PLATFORM_PAYS_FOOD_GST=on`), or passed to the restaurant |
   | delivery fee | the platform's when its riders deliver; the restaurant's when it uses its own rider |
   | **payout** | food + passed-on GST + own-rider fee − commission − GST on it − PG fee − TDS |

   For a cash order the restaurant already has the money, so the row is
   `payout − total`: usually negative, and taken off its next payout.
3. **Razorpay Route:** if the restaurant has a linked account, its payout is
   transferred to it straight away **on hold**. The money waits at Razorpay in
   the restaurant's name, not in your bank account.
4. **Every Monday** (06:00 IST, automatically, or *Close week* in Weekly
   payouts) each restaurant gets a statement for Monday to Sunday: orders,
   commission, TDS, cash it kept, adjustments, net payable.
5. **Release** (one click per restaurant): what it owes is taken back from the
   held transfers (partial reversals) and the rest is released; Razorpay pays it
   to the restaurant's bank on its next settlement cycle. If the restaurant owes
   more than it earned, the balance moves into next week's statement.
6. Anything Route can't pay (no linked account yet, PhonePe or plain UPI
   payments, positive adjustments) is listed in the **bank payout file** (CSV
   for your bank's bulk upload). Enter the UTR to mark it paid.

Each restaurant's statement downloads as CSV from Weekly payouts. A refund
made after delivery (from the Razorpay dashboard) is entered as an adjustment
on the restaurant (Restaurants → *Add adjustment*).

## Setting up

1. **DNS:** A records for `order.example.com` and `*.order.example.com` to the
   server. A restaurant on its own domain points that domain at the server too.
2. **HTTPS:** a wildcard certificate for `*.order.example.com` needs the DNS
   challenge (`certbot certonly --manual --preferred-challenges dns -d order.example.com -d '*.order.example.com'`,
   or a DNS plugin for your DNS host). nginx: `server_name order.example.com *.order.example.com;`
   proxying everything to the Node port, with `proxy_set_header Host $host;`.
   *`deploy/setup.sh` still sets up a single-restaurant server; the wildcard
   steps are manual for now.*
3. **.env:** `PLATFORM_DOMAIN`, `PLATFORM_ADMIN_TOKEN`, `SETTINGS_KEY`,
   `PUBLIC_BASE_URL=https://order.example.com`, the rates (see `.env.example`),
   and run with `npm run platform` (pm2: `pm2 start npm --name platform -- run platform`).
4. **Owner PIN** for Platform admin → Connections: `npm run owner-pin -- --platform`.
5. **Razorpay** (Connections): key ID, secret, webhook secret. Webhook
   `https://order.example.com/webhooks/razorpay`, event `payment_link.paid`.
   Ask Razorpay to enable **Route** on the account.
6. **Riders** (Connections): Shadowfax / Porter / Borzo keys. Callback URLs on
   `order.example.com/webhooks/<partner>`. Every restaurant's orders use these
   accounts, cheapest-plus-fastest partner per order, as before.
7. **WhatsApp** (optional): one Meta app and token for the platform; each
   restaurant that wants WhatsApp ordering gets its own number in your WhatsApp
   Business Account. Put that number's *phone number ID* on the restaurant
   (Restaurants tab); webhook `order.example.com/webhooks/whatsapp`.

## Adding a restaurant

Platform admin → **Add restaurant**: web address name (the subdomain), name,
commission %, colour, first outlet (address, map point from Google Maps, phone,
hours), business details (GSTIN, PAN, FSSAI), payout details, and the menu
pasted as CSV (`Category,Name,Price,Veg,Description`). You get the head office
link and a login token to hand over (shown once; *New head office token*
replaces it).

Then, for Route:
1. Razorpay Dashboard → Route → **Add linked account** for the restaurant (its
   KYC and bank account). Copy its ID (`acc_…`).
2. Paste it on the restaurant in Restaurants → **Check Route account** (should say *activated*).

Until then its payouts go in the bank payout file.

The restaurant manages its own outlets, menu, prices, stock, staff PINs and
orders in its head office, exactly as on a single install. **Paused**
restaurants keep their site but take no orders and drop off the marketplace.

## Taxes and compliance (confirm with your CA)

- **GST on food, section 9(5):** an e-commerce operator that collects payment
  for restaurant services pays the 5% GST itself. The ledger keeps that GST
  aside (*food GST to deposit*). Set `PLATFORM_PAYS_FOOD_GST=off` if your CA
  advises otherwise.
- **TDS, section 194-O:** deducted on each restaurant's sales and shown on the
  statement (0.1% by default; a restaurant without a PAN attracts a higher rate).
- **GST on commission:** 18%, on your invoice to the restaurant. Monthly
  commission invoices are not generated yet; the statements have the numbers.
- **Holding money:** with Route the customer's money waits at Razorpay under the
  restaurant's name, which avoids the platform holding third-party funds itself.

## Not in this version yet

- Charges that are still the same for every restaurant: packing, minimum
  order, delivery rate card, delivery range (from `.env`).
- One cart across restaurants on the marketplace: the marketplace hands the
  customer to one restaurant's site.
- Monthly GST invoices for commission, and payouts through a payouts API (RazorpayX).
- `deploy/setup.sh` for the wildcard domain.
