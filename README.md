# Vets Day Meals SA

A mobile-first directory of Veterans Day meal offers in San Antonio, Texas, plus year-round community food help. It is a static site: plain HTML, CSS, and JavaScript, with [Leaflet](https://leafletjs.com/) and [OpenStreetMap](https://www.openstreetmap.org/) tiles loaded from a CDN. There is no build step.

Veterans Day for this edition is Wednesday, November 11, 2026. Offers vary by location. Call ahead and bring military ID or other proof of service.

## Run it locally

Modules and the data files need a web server. From the repository root:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080/`. Opening `index.html` as a file will not work.

## How the data flows

The sheet id lives in one constant, `SHEET_ID`, in `js/config.js`.

The app reads four tabs from that Google Sheet with the public CSV endpoint:

```text
https://docs.google.com/spreadsheets/d/<SHEET_ID>/gviz/tq?tqx=out:csv&sheet=<TabName>
```

Tabs:

- `Restaurants`
- `Locations` (joined to restaurants on the restaurant name; `Location` is `lat, long`)
- `Community Food Help`
- `About` (key/value rows)

The sheet is shared so anyone with the link can view. If a live request fails (for example while the sheet is still private and returns 401), the app uses the saved CSV files in `data/`:

- `data/restaurants.csv`
- `data/locations.csv`
- `data/community.csv`
- `data/about.csv`

Replace those files when you refresh the bundled snapshot. `data/about.csv` is the fallback for the About tab.

Personal data never goes to the sheet. Favorites, hidden places, private notes, and spots you add are stored in `localStorage` on the device. Download spreadsheet saves a CSV you can open in Excel. Save as PDF opens a print view. Import spreadsheet reads that CSV back onto this device, adding anything that is not already there.

## Enable GitHub Pages

Pages is not turned on by this repository. To publish from the `main` branch at the site root:

1. Push `main`.
2. On GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Set **Branch** to `main` and **Folder** to `/ (root)`.
5. Save.

The site will be served from `https://<owner>.github.io/<repository>/`. Paths in this project are relative, so a project site in a subpath works. A `.nojekyll` file is included so GitHub Pages serves the files as-is.

Do not add a build command. Publish the repository root.

## What’s in the app

- **Map** — a pin for every location that has coordinates, clustered where they are dense, centered on San Antonio. Tap a pin for a card with the offer, a call-ahead warning, and map links.
- **List** — search, Free or Discount, dine-in or takeout, and area. Locations without coordinates or a phone stay in the list, with the restaurant website and Google/Apple Maps as the fallback.
- **Help** — community food organizations.
- **About** — purpose, last updated, and a disclaimer.
- **My Spots** — add, edit, or delete a personal spot (optional latitude/longitude or a Google Maps link). Star favorites, hide places, and keep private notes. Download a spreadsheet or save a PDF to keep a copy, and import that spreadsheet on another phone.

The footer on every view credits Ocultos Labs LLC and aiontrust.
