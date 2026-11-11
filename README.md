# Vets Day Meals SA

A mobile-first directory of Veterans Day meal offers in San Antonio, Texas, plus year-round community food help. It is a static site: plain HTML, CSS, and JavaScript, with [Leaflet](https://leafletjs.com/) and a free [OpenFreeMap](https://openfreemap.org/) basemap (OpenStreetMap data, no API key). There is no build step.

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

- `Restaurants` (an optional `Image`, `Image URL`, `Logo`, or `Photo` column is used when it is filled)
- `Locations` (joined to restaurants on the restaurant name; `Location` is `lat, long`; optional `Image URL` is the card photo when it is filled)
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

- **Map** — named pins on a light OpenFreeMap (Bright) basemap, clustered as “6 places” when zoomed out. CARTO’s Voyager tiles now require a paid key, so they are not used. On a phone, tap a pin to open that place on the Card tab. On a wider screen, tap a pin for a popup.
- **Card** — a compact scrolling feed. Each card has a small photo (a sheet image link when one is filled, otherwise the restaurant logo, otherwise a map thumbnail or initials), the offer clamped to two lines, a one-line call-ahead note, and Call, Google Maps, Apple Maps, and favorite on one row.
- **List** — one compact row per place. Tap a row for the same details.
- **Menu** — the icon at the top left holds the filters, About, and the copyright line. Help is its own tab. My Spots is a switch at the top of List. The refresh icon reloads the public sheet.
- **My Spots** — add, edit, or delete a personal spot. Download a spreadsheet or save a PDF, and import that spreadsheet on another phone.

On a phone the copyright sits in the menu and on About, so the map can use the full screen. On a wider screen it also stays at the bottom of the page.
