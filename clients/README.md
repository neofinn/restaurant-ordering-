# Client profiles

One copy of the system runs one restaurant business. Everything that belongs
to that business sits in a profile folder here; the code itself names no
client.

```
clients/<id>/
  brand.json   name, logo words, colours, wording, region
  data.js      starting outlets, menu and localities
  index.js     module.exports = { brand: require('./brand.json'), ...require('./data') }
  test/        optional tests for this client's own data (run by npm test)
```

Pick the profile with `CLIENT=<id>` in `.env` (or a path to a profile folder
kept outside this repo). The browser demo is built the same way:
`CLIENT=<id> npm run build:demo`.

## Setting up a new client

1. Copy `clients/sample` to `clients/<new-id>`.
2. Edit `brand.json`:

| Field | What it is | Example |
|---|---|---|
| `id` | Short name used in file names and demo storage | `"spice-route"` |
| `name` | Business name shown everywhere | `"Spice Route"` |
| `logo` | Logo text: first part, highlighted part | `["Spice", "Route"]` |
| `outletPrefix` | Put before outlet names (default `"<name> - "`) | `"Spice Route - "` |
| `menuTitle` | Heading on the WhatsApp menu pictures (default: name in capitals) | `"SPICE ROUTE KITCHEN"` |
| `emoji` | Used in the WhatsApp welcome | `"🍛"` |
| `description` | Search-engine description of the order page | |
| `orderExample` | A typed order the welcome message shows, using real dishes | `"2 butter naan and 1 half dal makhani"` |
| `menuExample` | Shorter one for the foot of the menu pictures | |
| `colors.brand`, `brandDark`, `accent` | Page colours | `"#0f766e"` |
| `colors.menu` | Header colour of the menu pictures | |
| `region.name` | How messages refer to the area | `"Jaipur"` |
| `region.state` | State sent to delivery partners | `"Rajasthan"` |
| `region.bounds` | Box new outlet locations must fall in (catches typos) | `{ "minLat": 26.6, ... }` |
| `upiExample` | Placeholder in the add-outlet form | |
| `demo.*` | Demo only: example address, a place outside the area, example orders | |

3. Replace `data.js`:
   - **outlets**: name, address, map point, phone, hours, UPI ID;
   - **menu**: prices in rupees; a dish in two sizes is two items, `Dish (Half)` and `Dish (Full)`;
   - **localities**: the areas customers type in addresses, each with a map point (needed for typed addresses without GPS).
4. Set `CLIENT=<new-id>` and run `npm test` and `npm start`.

The data is only used to fill an empty database. After launch, outlets, menu,
prices and stock are managed in the head office panel.

Fixed charges (delivery rate card, packing charge, GST, loyalty points) are
set in `.env`; see `.env.example`.
