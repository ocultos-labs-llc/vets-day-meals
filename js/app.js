import {
  APP_TITLE,
  BANNER,
  CALLOUT,
  FALLBACK_DISCLAIMER,
  NO_PHONE,
  SA_CENTER,
  SHEET_ID,
  SHEET_TABS,
  SNAPSHOTS,
} from "./config.js?v=20261111";
import { parseCsv } from "./csv.js?v=20261111";
import {
  appleHref,
  areaOptions,
  buildPlaces,
  closestMiles,
  field,
  formatAddress,
  formatMiles,
  googleHref,
  labelize,
  looksLikeTable,
  milesBetween,
  parseAbout,
  parseLatLng,
  placeMatches,
  safeHttp,
  sortPlaces,
  spotToPlace,
  telHref,
} from "./logic.js?v=20261111";
import { loadPersonal, savePersonal } from "./store.js?v=20261111";
import {
  importSummary,
  mergeSpreadsheet,
  parseSpreadsheet,
  spreadsheetRows,
  toCsv,
} from "./personal-file.js?v=20261111";

const VIEWS = ["map", "card", "list", "help", "about", "mine"];
const VIEW_TITLES = { map: "Map", card: "Card", list: "List", help: "Help", about: "About", mine: "My Spots" };
let listMode = "all";
const NAME_ZOOM = 14;

const personal = loadPersonal();
let directory = [];
let communityRows = [];
let aboutEntries = [];
let dirSource = "snapshot";
let helpSource = "snapshot";
let aboutSource = "snapshot";
let loaded = false;
let failed = false;
let focusTarget = null;
let origin = null;
let map = null;
let cluster = null;
let userLayer = null;
let lastFocus = null;
let toastTimer = 0;

document.title = APP_TITLE;
const titleEl = document.getElementById("app-title");
if (titleEl) titleEl.textContent = APP_TITLE;
document.querySelectorAll("[data-banner]").forEach((el) => {
  el.textContent = BANNER;
});

function h(tag, props = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  const list = Array.isArray(kids) ? kids : [kids];
  for (const kid of list) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function extA(href, text, className) {
  return h("a", {
    href,
    class: className || "",
    target: "_blank",
    rel: "noopener noreferrer",
    text,
  });
}

function toast(nodeOrText) {
  const el = document.getElementById("toast");
  el.replaceChildren(nodeOrText instanceof Node ? nodeOrText : document.createTextNode(String(nodeOrText)));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}

function persist() {
  try {
    savePersonal(personal);
    return true;
  } catch {
    toast("Couldn't save on this device (storage is blocked or full).");
    return false;
  }
}

function sheetUrl(tab) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", redirect: "manual" });
    // A private sheet redirects to a login page. Stop there so the browser
    // does not follow it into a cross-origin CORS error. A public sheet returns the CSV.
    if (res.type === "opaqueredirect" || !res.ok) throw new Error("unavailable");
    const text = await res.text();
    if (!text || /^\s*</.test(text)) throw new Error("html");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function loadTable(tab, path, header) {
  try {
    const text = await fetchText(sheetUrl(tab), 4000);
    const rows = parseCsv(text);
    if (!looksLikeTable(rows, header)) throw new Error("shape");
    return { rows, source: "live" };
  } catch {
    const text = await fetchText(path, 4000);
    return { rows: parseCsv(text), source: "snapshot" };
  }
}

async function loadDirectory() {
  try {
    const [restaurantsText, locationsText] = await Promise.all([
      fetchText(sheetUrl(SHEET_TABS.restaurants), 4000),
      fetchText(sheetUrl(SHEET_TABS.locations), 4000),
    ]);
    const restaurants = parseCsv(restaurantsText);
    const locations = parseCsv(locationsText);
    if (!looksLikeTable(restaurants, "Restaurant") || !looksLikeTable(locations, "Restaurant")) {
      throw new Error("shape");
    }
    return { restaurants, locations, source: "live" };
  } catch {
    const [restaurantsText, locationsText] = await Promise.all([
      fetchText(SNAPSHOTS.restaurants, 4000),
      fetchText(SNAPSHOTS.locations, 4000),
    ]);
    return {
      restaurants: parseCsv(restaurantsText),
      locations: parseCsv(locationsText),
      source: "snapshot",
    };
  }
}

function sourceLineText() {
  if (!loaded) return failed ? "The directory could not be loaded." : "Loading the directory…";
  if (dirSource === "live") return "Updated from the public sheet.";
  return "Showing the saved copy bundled with this app. The live sheet was unavailable.";
}

function setSourceLines() {
  const text = sourceLineText();
  document.querySelectorAll("[data-source-line]").forEach((el) => {
    el.textContent = text;
  });
}

function allPlaces() {
  return directory.concat(personal.spots.map(spotToPlace));
}

function readFilters() {
  return {
    q: document.getElementById("q").value,
    offer: document.getElementById("offer").value,
    service: document.getElementById("service").value,
    area: document.getElementById("area").value,
    favorites: document.getElementById("fav-only").getAttribute("aria-pressed") === "true",
    favoriteIds: personal.favorites,
    hiddenIds: personal.hidden,
  };
}

function clip(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function offerChip(label) {
  const value = (label || "").toLowerCase();
  let cls = "chip";
  if (value.includes("free") && value.includes("discount")) cls = "chip chip-either";
  else if (value.includes("discount")) cls = "chip chip-discount";
  else if (value.includes("free")) cls = "chip chip-free";
  if (!label) return null;
  return h("span", { class: cls, text: label });
}

function callAheadBadge() {
  return h("span", { class: "chip chip-ahead", text: "Call ahead" });
}

function noPhoneLine(loc) {
  const website = directoryWebsite(loc);
  const maps = googleHref(loc);
  const p = h("p", { class: "no-phone" });
  p.append("No phone listed - check the restaurant's ");
  if (website) {
    p.append(h("a", { href: website, target: "_blank", rel: "noopener noreferrer", text: "website" }));
  } else {
    p.append("website");
  }
  p.append(" or ");
  p.append(h("a", { href: maps, target: "_blank", rel: "noopener noreferrer", text: "Google Maps" }));
  p.append(" before you go");
  return p;
}

function directoryWebsite(loc) {
  const place = placeForLoc(loc);
  return place ? place.website : "";
}

function placeForLoc(loc) {
  return allPlaces().find((place) => place.locations.some((item) => item.id === loc.id)) || null;
}

function mapsRow(loc) {
  const row = h("div", { class: "maps" });
  row.append(h("a", {
    class: "btn btn-ghost",
    href: googleHref(loc),
    target: "_blank",
    rel: "noopener noreferrer",
    text: "Google Maps",
    "aria-label": `Google Maps for ${loc.name} (opens in a new tab)`,
  }));
  row.append(h("a", {
    class: "btn btn-ghost",
    href: appleHref(loc),
    target: "_blank",
    rel: "noopener noreferrer",
    text: "Apple Maps",
    "aria-label": `Apple Maps for ${loc.name} (opens in a new tab)`,
  }));
  return row;
}

function buildCallout(loc) {
  const box = h("div", { class: "callout" });
  box.append(h("p", { class: "callout-title", text: CALLOUT }));
  const tel = telHref(loc.phone);
  if (tel) {
    box.append(h("a", {
      class: "btn btn-call",
      href: tel,
      text: `Call ${loc.phone}`,
      "aria-label": `Call ${loc.name} at ${loc.phone}`,
    }));
  } else {
    box.append(noPhoneLine(loc));
  }
  return box;
}

function noteBox(id) {
  const details = h("details", { class: "note" });
  if (personal.notes[id]) details.open = true;
  details.append(h("summary", { text: "Private note" }));
  const area = h("textarea", {
    "data-note-id": id,
    maxlength: "2000",
    "aria-label": "Private note, saved only on this device",
  });
  area.value = personal.notes[id] || "";
  area.addEventListener("input", () => {
    const value = area.value;
    if (value.trim()) personal.notes[id] = value;
    else delete personal.notes[id];
    persist();
    document.querySelectorAll("[data-note-id]").forEach((other) => {
      if (other !== area && other.getAttribute("data-note-id") === id) other.value = value;
    });
  });
  details.append(area);
  return details;
}

function favoriteButton(id, { compact = false } = {}) {
  const on = !!personal.favorites[id];
  return h("button", {
    type: "button",
    class: compact ? "chip-btn" : "btn btn-ghost",
    "data-fav-id": id,
    "data-fav-style": compact ? "icon" : "text",
    "aria-pressed": on ? "true" : "false",
    "aria-label": on ? `Remove ${lookupName(id)} from favorites` : `Save ${lookupName(id)} as a favorite`,
    text: compact ? (on ? "★" : "☆") : (on ? "★ Favorited" : "☆ Favorite"),
    onclick: () => onFavorite(id),
  });
}

function onFavorite(id) {
  if (personal.favorites[id]) delete personal.favorites[id];
  else personal.favorites[id] = true;
  const on = !!personal.favorites[id];
  persist();
  document.querySelectorAll("[data-fav-id]").forEach((el) => {
    if (el.getAttribute("data-fav-id") === id) {
      el.setAttribute("aria-pressed", on ? "true" : "false");
      const icon = el.getAttribute("data-fav-style") === "icon";
      el.textContent = icon ? (on ? "★" : "☆") : (on ? "★ Favorited" : "☆ Favorite");
      el.setAttribute("aria-label", on ? `Remove ${lookupName(id)} from favorites` : `Save ${lookupName(id)} as a favorite`);
    }
  });
  renderMarkers();
  if (document.getElementById("fav-only").getAttribute("aria-pressed") === "true") renderDynamic();
  else renderMineLists();
}

function hidePlace(place) {
  personal.hidden[place.id] = true;
  persist();
  closeDetail({ restore: false });
  renderDynamic();
  const wrap = document.createElement("span");
  wrap.append(`Hid ${place.name}. `);
  const undo = h("button", { type: "button", class: "btn", text: "Undo" });
  undo.addEventListener("click", () => {
    delete personal.hidden[place.id];
    persist();
    renderDynamic();
    toast(`Restored ${place.name}.`);
  });
  const box = document.createElement("span");
  box.append(wrap, undo);
  toast(box);
}

function addFact(dl, label, value) {
  if (!value) return;
  const row = h("div");
  row.append(h("dt", { text: label }), h("dd", { text: value }));
  dl.append(row);
}

function locMatchesQuery(loc, query) {
  if (!query) return false;
  return [loc.name, loc.address, loc.city, loc.zip, loc.area, loc.phone].join(" ").toLowerCase().includes(query);
}

function locationBlock(loc, query) {
  const row = h("div", { class: loc.callAhead ? "loc is-ahead" : "loc" });
  row.setAttribute("data-loc-id", loc.id);
  const head = h("div", { class: "loc-head" });
  head.append(h("h4", { text: loc.name }));
  if (loc.callAhead) head.append(callAheadBadge());
  row.append(head);
  const address = formatAddress(loc);
  if (address) row.append(h("p", { class: "addr", text: address }));
  const meta = [];
  if (loc.area) meta.push(loc.area);
  if (origin && loc.lat != null) meta.push(formatMiles(milesBetween(origin, loc)));
  else if (origin) meta.push("Distance unavailable");
  if (meta.length) row.append(h("p", { class: "meta", text: meta.join(" · ") }));
  if (loc.lat == null) row.append(h("p", { class: "hint", text: "No map pin for this address." }));
  if (locMatchesQuery(loc, query)) row.classList.add("is-hit");
  const tel = telHref(loc.phone);
  if (tel) {
    row.append(h("a", { class: "btn btn-call", href: tel, text: `Call ${loc.phone}` }));
  } else {
    row.append(noPhoneLine(loc));
  }
  if (loc.menu) row.append(h("p", { class: "links" }, [extA(loc.menu, "Menu")]));
  row.append(mapsRow(loc));
  row.append(h("button", {
    type: "button",
    class: "btn btn-primary",
    text: "Details",
    onclick: () => openDetail(placeForLoc(loc), loc),
  }));
  return row;
}

function defaultOpen(place, filters) {
  const query = (filters.q || "").trim();
  if (query.length >= 2) return true;
  if (filters.area) return true;
  if (place.locations.some((loc) => loc.callAhead)) return true;
  if (place.locations.length && place.locations.every((loc) => loc.lat == null)) return true;
  return false;
}

function renderRestaurantCard(place, filters, openIds) {
  const card = h("article", { class: "card" });
  card.setAttribute("data-place-id", place.id);
  const head = h("div", { class: "card-head" });
  head.append(h("h3", { text: place.name }));
  card.append(head);
  const chips = h("div", { class: "chips" });
  const offer = offerChip(place.offerLabel);
  if (offer) chips.append(offer);
  if (place.category) chips.append(h("span", { class: "chip", text: place.category }));
  if (place.status) chips.append(h("span", { class: "chip", text: place.status }));
  if (place.locations.some((loc) => loc.callAhead)) chips.append(callAheadBadge());
  card.append(chips);
  if (origin) {
    const miles = closestMiles(place, origin);
    if (Number.isFinite(miles)) card.append(h("p", { class: "meta", text: `Closest ${formatMiles(miles)}` }));
  }
  card.append(h("div", { class: "card-actions" }, [
    favoriteButton(place.id),
    h("button", { type: "button", class: "btn btn-ghost", text: "Hide", onclick: () => hidePlace(place) }),
  ]));
  if (place.offer) {
    const p = h("p", { class: "offer" });
    p.append(h("span", { class: "offer-label", text: "Offer" }), place.offer);
    card.append(p);
  }
  const facts = h("dl", { class: "facts" });
  addFact(facts, "Hours", place.hours);
  addFact(facts, "ID / proof", place.proof);
  addFact(facts, "Participation", place.participation);
  addFact(facts, "Dates", place.dates);
  addFact(facts, "Dine-in / takeout", place.service);
  card.append(facts);
  const links = h("p", { class: "links" });
  if (place.sourceUrl) links.append(extA(place.sourceUrl, "Source"));
  if (place.website) links.append(extA(place.website, "Website"));
  if (links.childNodes.length) card.append(links);
  card.append(noteBox(place.id));

  if (!place.locations.length) {
    card.append(h("p", { text: place.listedLocations || "No street address is listed yet." }));
    const fallback = {
      id: `${place.id}::fallback`,
      name: place.name,
      address: "San Antonio, TX",
      city: "San Antonio",
      zip: "",
      area: "",
      phone: "",
      google: "",
      apple: "",
      lat: null,
      lng: null,
      menu: "",
      callAhead: false,
    };
    card.append(mapsRow(fallback));
  } else {
    const details = h("details", { class: "locs" });
    details.dataset.placeId = place.id;
    if (openIds.has(place.id) || defaultOpen(place, filters)) details.open = true;
    const unpinned = place.locations.filter((loc) => loc.lat == null).length;
    let summary = `${place.locations.length} location${place.locations.length === 1 ? "" : "s"}`;
    if (unpinned) {
      summary += unpinned === place.locations.length ? " · not on the map" : ` · ${unpinned} not on the map`;
    }
    const sum = h("summary");
    sum.append(summary);
    if (place.locations.some((loc) => loc.callAhead)) sum.append(callAheadBadge());
    details.append(sum);
    const query = (filters.q || "").trim().toLowerCase();
    const locs = place.locations.slice().sort((a, b) => {
      if (origin && a.lat != null && b.lat != null) {
        return milesBetween(origin, a) - milesBetween(origin, b);
      }
      return 0;
    });
    for (const loc of locs) details.append(locationBlock(loc, query));
    card.append(details);
  }
  return card;
}

function renderSpotCard(place) {
  const spot = place.spot;
  const loc = place.locations[0];
  const card = h("article", { class: "card spot-card" });
  card.setAttribute("data-place-id", place.id);
  const head = h("div", { class: "card-head" });
  head.append(h("h3", { text: place.name }));
  head.append(h("span", { class: "chip chip-mine", text: "My spot" }));
  if (loc.callAhead) head.append(callAheadBadge());
  if (personal.hidden[place.id]) head.append(h("span", { class: "chip", text: "Hidden" }));
  card.append(head);
  if (origin && loc.lat != null) card.append(h("p", { class: "meta", text: formatMiles(milesBetween(origin, loc)) }));
  if (place.offer) card.append(h("p", { class: "offer", text: place.offer }));
  if (place.notes) {
    const p = h("p");
    p.append(h("span", { class: "offer-label", text: "Notes" }), place.notes);
    card.append(p);
  }
  card.append(h("p", { class: "addr", text: loc.address }));
  if (loc.lat == null) card.append(h("p", { class: "hint", text: "No map pin for this address." }));
  card.append(noPhoneLine(loc));
  card.append(mapsRow(loc));
  card.append(h("div", { class: "card-actions" }, [
    favoriteButton(place.id),
    h("button", {
      type: "button",
      class: "btn btn-ghost",
      text: personal.hidden[place.id] ? "Unhide" : "Hide",
      onclick: () => {
        if (personal.hidden[place.id]) delete personal.hidden[place.id];
        else personal.hidden[place.id] = true;
        persist();
        renderDynamic();
      },
    }),
    h("button", { type: "button", class: "btn btn-ghost", text: "Edit", onclick: () => startEdit(spot) }),
    h("button", { type: "button", class: "btn btn-ghost", text: "Delete", onclick: () => deleteSpot(spot) }),
    h("button", { type: "button", class: "btn btn-primary", text: "Details", onclick: () => openDetail(place, loc) }),
  ]));
  card.append(noteBox(place.id));
  return card;
}

function shortArea(place) {
  const areas = [];
  for (const loc of place.locations) {
    const area = (loc.area || "").trim();
    if (area && area.toLowerCase() !== "san antonio" && !areas.includes(area)) areas.push(area);
  }
  if (areas.length === 1) return areas[0];
  if (areas.length > 1) return "Several areas";
  const summary = (place.areaSummary || "").trim();
  if (summary && summary.toLowerCase() !== "citywide") return summary;
  if (place.locations.length > 1) return `${place.locations.length} locations`;
  return place.locations[0]?.city || "";
}

function rowMeta(place) {
  const area = shortArea(place);
  if (origin) {
    const miles = closestMiles(place, origin);
    if (Number.isFinite(miles)) return area ? `${formatMiles(miles)} · ${area}` : formatMiles(miles);
  }
  return area;
}

function appendPlaceDetails(container, place, focusLocId) {
  const chips = h("div", { class: "chips" });
  const chip = offerChip(place.offerLabel);
  if (chip) chips.append(chip);
  if (place.kind === "spot") chips.append(h("span", { class: "chip chip-mine", text: "My spot" }));
  if (place.locations.some((loc) => loc.callAhead)) chips.append(callAheadBadge());
  if (chips.childNodes.length) container.append(chips);
  const locs = place.locations.slice();
  if (focusLocId) {
    locs.sort((a, b) => (a.id === focusLocId ? -1 : b.id === focusLocId ? 1 : 0));
  }
  const paintLoc = (loc) => {
    const block = h("div", { class: loc.callAhead ? "loc is-ahead" : "loc" });
    if (focusLocId && loc.id === focusLocId) block.classList.add("is-hit");
    block.setAttribute("data-loc-id", loc.id);
    if (locs.length > 1 || loc.name !== place.name) {
      const head = h("div", { class: "loc-head" });
      head.append(h("h4", { text: loc.name }));
      if (loc.callAhead) head.append(callAheadBadge());
      block.append(head);
    }
    const address = formatAddress(loc);
    if (address) block.append(h("p", { class: "addr", text: address }));
    if (loc.area) block.append(h("p", { class: "meta", text: loc.area }));
    if (loc.lat == null) block.append(h("p", { class: "hint", text: "No map pin for this address." }));
    block.append(buildCallout(loc));
    if (loc.menu) block.append(h("p", { class: "links" }, [extA(loc.menu, "Menu")]));
    block.append(mapsRow(loc));
    return block;
  };
  if (locs[0]) container.append(paintLoc(locs[0]));
  if (place.offer) {
    const offer = h("p", { class: "offer" });
    offer.append(h("span", { class: "offer-label", text: "Offer" }), place.offer);
    container.append(offer);
  }
  if (place.notes) {
    const note = h("p");
    note.append(h("span", { class: "offer-label", text: "Notes" }), place.notes);
    container.append(note);
  }
  const facts = h("dl", { class: "facts" });
  addFact(facts, "Hours", place.hours);
  addFact(facts, "ID / proof", place.proof);
  addFact(facts, "Participation", place.participation);
  addFact(facts, "Dates", place.dates);
  addFact(facts, "Dine-in / takeout", place.service);
  if (facts.childElementCount) container.append(facts);
  const links = h("p", { class: "links" });
  if (place.sourceUrl) links.append(extA(place.sourceUrl, "Source"));
  if (place.website) links.append(extA(place.website, "Website"));
  if (links.childNodes.length) container.append(links);
  const actions = [favoriteButton(place.id)];
  if (place.kind === "spot") {
    actions.push(
      h("button", { type: "button", class: "btn btn-ghost", text: personal.hidden[place.id] ? "Unhide" : "Hide", onclick: () => {
        if (personal.hidden[place.id]) delete personal.hidden[place.id];
        else personal.hidden[place.id] = true;
        persist();
        renderDynamic();
      } }),
      h("button", { type: "button", class: "btn btn-ghost", text: "Edit", onclick: () => startEdit(place.spot) }),
      h("button", { type: "button", class: "btn btn-ghost", text: "Delete", onclick: () => deleteSpot(place.spot) }),
    );
  } else {
    actions.push(h("button", { type: "button", class: "btn btn-ghost", text: "Hide", onclick: () => hidePlace(place) }));
  }
  container.append(h("div", { class: "card-actions" }, actions));
  container.append(noteBox(place.id));
  if (locs.length > 1) {
    const more = h("details", { class: "locs" });
    more.append(h("summary", { text: `${locs.length - 1} more location${locs.length - 1 === 1 ? "" : "s"}` }));
    for (const loc of locs.slice(1)) more.append(paintLoc(loc));
    container.append(more);
  }
}

function primaryLoc(place, focusLocId) {
  if (focusLocId) {
    const hit = place.locations.find((loc) => loc.id === focusLocId);
    if (hit) return hit;
  }
  const pinned = place.locations.filter((loc) => loc.lat != null);
  if (origin && pinned.length) {
    return pinned.slice().sort((a, b) => milesBetween(origin, a) - milesBetween(origin, b))[0];
  }
  return place.locations[0] || null;
}

function websiteDomain(url) {
  const href = safeHttp(url);
  if (!href) return "";
  try {
    return new URL(href).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function placePictures(place, loc) {
  const urls = [];
  const push = (url) => {
    const href = safeHttp(url);
    if (href && !urls.includes(href)) urls.push(href);
  };
  if (loc) push(loc.image);
  for (const item of place.locations || []) push(item.image);
  push(place.image);
  return urls;
}

function initialsFor(name) {
  const words = String(name || "").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function initialsBadge(name) {
  return h("span", {
    class: "thumb-initials",
    role: "img",
    "aria-label": `${name} initials`,
    text: initialsFor(name),
  });
}

function osmTile(lat, lng, zoom = 15) {
  const n = 2 ** zoom;
  const x = (lng + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return {
    url: `https://tile.openstreetmap.org/${zoom}/${Math.floor(x)}/${Math.floor(y)}.png`,
    px: (x - Math.floor(x)) * 256,
    py: (y - Math.floor(y)) * 256,
  };
}

function mountThumb(host, place, loc) {
  const steps = placePictures(place, loc).map((src) => ({
    kind: "photo",
    src,
    alt: `${place.name} photo`,
  }));
  const domain = websiteDomain(place.website);
  if (domain) {
    steps.push({
      kind: "logo",
      src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
      alt: `${place.name} logo`,
    });
  }
  if (loc && loc.lat != null && loc.lng != null) steps.push({ kind: "map", lat: loc.lat, lng: loc.lng });
  steps.push({ kind: "initials" });

  const show = (index) => {
    const step = steps[index] || { kind: "initials" };
    host.dataset.thumb = step.kind;
    if (step.kind === "initials") {
      host.replaceChildren(initialsBadge(place.name));
      return;
    }
    if (step.kind === "map") {
      const tile = osmTile(step.lat, step.lng);
      const box = h("div", {
        class: "thumb-map",
        role: "img",
        "aria-label": `Map thumbnail of ${place.name}`,
        title: "© OpenStreetMap contributors",
      });
      const img = h("img", { src: tile.url, alt: "", loading: "lazy", decoding: "async" });
      img.style.setProperty("--px", `${tile.px}px`);
      img.style.setProperty("--py", `${tile.py}px`);
      img.addEventListener("error", () => show(index + 1));
      box.append(img);
      host.replaceChildren(box);
      return;
    }
    const img = h("img", {
      class: step.kind === "logo" ? "thumb-logo" : "thumb-photo",
      src: step.src,
      alt: step.alt,
      loading: "lazy",
      decoding: "async",
      width: "64",
      height: "64",
    });
    img.addEventListener("error", () => show(index + 1));
    host.replaceChildren(img);
  };
  show(0);
}

function offerBlock(text) {
  const offer = String(text || "").trim();
  if (!offer) return null;
  const wrap = h("div", { class: "feed-offer-wrap" });
  const paragraph = h("p", { class: "feed-offer", text: offer });
  const more = h("button", {
    type: "button",
    class: "more-link",
    text: "More",
    hidden: true,
    "aria-expanded": "false",
    "aria-label": "Show the full offer",
  });
  more.addEventListener("click", () => {
    const open = paragraph.classList.toggle("is-open");
    more.textContent = open ? "Less" : "More";
    more.setAttribute("aria-expanded", open ? "true" : "false");
    more.setAttribute("aria-label", open ? "Show less of the offer" : "Show the full offer");
  });
  wrap.append(paragraph, more);
  requestAnimationFrame(() => {
    if (paragraph.scrollHeight > paragraph.clientHeight + 1) more.hidden = false;
  });
  return wrap;
}

function cardActions(place, loc) {
  const row = h("div", { class: "feed-actions" });
  const tel = loc ? telHref(loc.phone) : "";
  if (tel) {
    row.append(h("a", {
      class: "chip-btn is-call",
      href: tel,
      "aria-label": `Call ${loc.name} at ${loc.phone}`,
      text: "Call",
    }));
  } else {
    row.append(h("button", {
      type: "button",
      class: "chip-btn is-call",
      "aria-label": NO_PHONE,
      text: "Call",
      onclick: () => toast(NO_PHONE),
    }));
  }
  const target = loc || {
    name: place.name,
    address: "San Antonio, TX",
    city: "San Antonio",
    zip: "",
    google: "",
    apple: "",
    lat: null,
    lng: null,
  };
  row.append(h("a", {
    class: "chip-btn",
    href: googleHref(target),
    target: "_blank",
    rel: "noopener noreferrer",
    "aria-label": `Google Maps for ${place.name} (opens in a new tab)`,
    text: "Google",
  }));
  row.append(h("a", {
    class: "chip-btn",
    href: appleHref(target),
    target: "_blank",
    rel: "noopener noreferrer",
    "aria-label": `Apple Maps for ${place.name} (opens in a new tab)`,
    text: "Apple",
  }));
  row.append(favoriteButton(place.id, { compact: true }));
  return row;
}

function renderCard() {
  const results = document.getElementById("card-results");
  const count = document.getElementById("card-count");
  if (!results || !count) return;
  if (!loaded) {
    results.replaceChildren(h("p", { class: "empty", text: failed ? "The directory could not be loaded." : "Loading the directory…" }));
    count.textContent = "";
    return;
  }
  const filters = readFilters();
  const shown = sortPlaces(allPlaces().filter((place) => placeMatches(place, filters)), origin);
  count.textContent = `${shown.length} ${shown.length === 1 ? "place" : "places"}`;
  results.replaceChildren();
  if (!shown.length) {
    results.append(h("p", { class: "empty", text: "No places match. Open the menu to clear a filter." }));
    return;
  }
  for (const place of shown) {
    const focusId = focusTarget && focusTarget.placeId === place.id ? focusTarget.locId : "";
    const loc = primaryLoc(place, focusId);
    const card = h("article", { class: "feed-card" });
    card.dataset.placeId = place.id;
    if (focusId) card.classList.add("is-focused");
    const banner = h("div", { class: "feed-banner" });
    const thumb = h("div", { class: "feed-thumb" });
    mountThumb(thumb, place, loc);
    banner.append(thumb);
    const body = h("div", { class: "feed-body" });
    body.append(h("h3", { text: place.name }));
    const meta = h("p", { class: "feed-meta" });
    const chip = offerChip(place.offerLabel);
    if (chip) meta.append(chip);
    if (place.kind === "spot") meta.append(h("span", { class: "chip chip-mine", text: "My spot" }));
    if (meta.childNodes.length) body.append(meta);
    const offer = offerBlock(place.offer);
    if (offer) body.append(offer);
    body.append(h("p", { class: "feed-ahead", text: CALLOUT }));
    body.append(cardActions(place, loc));
    card.append(banner, body);
    results.append(card);
  }
  updateFilterBadge();
}

function renderList() {
  const results = document.getElementById("list-results");
  const scroller = document.getElementById("view-list");
  const y = scroller.scrollTop;
  const openIds = new Set(
    [...document.querySelectorAll("#list-results .place.is-open")].map((el) => el.dataset.placeId),
  );
  if (!loaded) {
    results.replaceChildren(h("p", { class: "empty", text: failed ? "The directory could not be loaded." : "Loading the directory…" }));
    return;
  }
  const filters = readFilters();
  const shown = sortPlaces(allPlaces().filter((place) => placeMatches(place, filters)), origin);
  const count = document.getElementById("list-count");
  count.textContent = `${shown.length} ${shown.length === 1 ? "place" : "places"}`;
  results.replaceChildren();
  if (!shown.length) {
    results.append(h("p", { class: "empty", text: "No places match. Open the menu to clear a filter." }));
  } else {
    for (const place of shown) {
      const open = openIds.has(place.id);
      const article = h("article", { class: open ? "place is-open" : "place" });
      article.dataset.placeId = place.id;
      const button = h("button", {
        type: "button",
        class: "place-row",
        "aria-expanded": open ? "true" : "false",
      });
      const main = h("span", { class: "place-main" });
      main.append(h("span", { class: "place-name", text: place.name }));
      const meta = h("span", { class: "place-meta" });
      const chip = offerChip(place.offerLabel);
      if (chip) meta.append(chip);
      if (place.kind === "spot") meta.append(h("span", { class: "chip chip-mine", text: "My spot" }));
      const area = rowMeta(place);
      if (area) meta.append(h("span", { text: area }));
      main.append(meta);
      button.append(main, h("span", { class: "chevron", "aria-hidden": "true", text: "›" }));
      const body = h("div", { class: "place-body" });
      body.hidden = !open;
      appendPlaceDetails(body, place, "");
      button.addEventListener("click", () => {
        const willOpen = body.hidden;
        body.hidden = !willOpen;
        button.setAttribute("aria-expanded", willOpen ? "true" : "false");
        article.classList.toggle("is-open", willOpen);
      });
      article.append(button, body);
      results.append(article);
    }
  }
  if (!focusTarget) scroller.scrollTop = y;
  updateFilterBadge();
}

function updateFilterBadge() {
  const filters = readFilters();
  let count = 0;
  if (filters.q.trim()) count += 1;
  if (filters.offer) count += 1;
  if (filters.service) count += 1;
  if (filters.area) count += 1;
  if (filters.favorites) count += 1;
  if (origin) count += 1;
  const badge = document.getElementById("filter-badge");
  if (!badge) return;
  badge.hidden = count === 0;
  badge.textContent = String(count);
}

function showPlaceOnCard(place, loc) {
  focusTarget = { placeId: place.id, locId: loc ? loc.id : "" };
  showView("card");
  renderCard();
  requestAnimationFrame(() => {
    const card = document.querySelector(`#card-results [data-place-id="${CSS.escape(place.id)}"]`);
    if (card) card.scrollIntoView({ block: "start" });
    focusTarget = null;
  });
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function makeIcon(place, loc) {
  const dot = ["pin-dot"];
  if (place.kind === "spot") dot.push("pin-spot");
  if (loc.callAhead) dot.push("pin-ahead");
  if (personal.favorites[place.id]) dot.push("pin-fav");
  const name = escapeHtml(place.name);
  return L.divIcon({
    className: "pin-icon",
    html: `<span class="pin-chip is-dot" data-name="${name}"><span class="${dot.join(" ")}"></span><span class="pin-name">${name}</span></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -12],
  });
}

function placeClusterIcon(group) {
  const count = group.getChildCount();
  const text = count === 1 ? "1 place" : `${count} places`;
  const width = Math.max(84, 16 + text.length * 8);
  return L.divIcon({
    className: "place-cluster",
    html: `<span class="place-cluster-label">${text}</span>`,
    iconSize: [width, 34],
    iconAnchor: [width / 2, 17],
  });
}

function layoutPinLabels() {
  if (!map) return;
  const chips = [...document.querySelectorAll("#map .pin-chip")];
  if (map.getZoom() < NAME_ZOOM) {
    chips.forEach((chip) => chip.classList.add("is-dot"));
    return;
  }
  chips.forEach((chip) => chip.classList.remove("is-dot"));
  chips.sort((a, b) => (a.dataset.name || "").localeCompare(b.dataset.name || ""));
  const placed = [];
  for (const chip of chips) {
    const label = chip.querySelector(".pin-name");
    const box = label ? label.getBoundingClientRect() : null;
    if (!box || box.width < 2) continue;
    const hit = { l: box.left - 3, t: box.top - 2, r: box.right + 3, b: box.bottom + 2 };
    const overlaps = placed.some((item) => !(hit.r < item.l || hit.l > item.r || hit.b < item.t || hit.t > item.b));
    if (overlaps) chip.classList.add("is-dot");
    else placed.push(hit);
  }
}

function prefersPinSheet() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function placeSummary(place, loc) {
  const bits = [];
  if (place.kind !== "spot" && place.name && place.name !== loc.name) bits.push(place.name);
  if (place.offerLabel) bits.push(place.offerLabel);
  return bits.join(" · ");
}

function buildPopup(place, loc) {
  const wrap = h("div", { class: "popup-card" });
  const title = h("p", { class: "popup-title" });
  title.append(h("span", { text: loc.name }));
  if (loc.callAhead) title.append(callAheadBadge());
  if (place.kind === "spot") title.append(h("span", { class: "chip chip-mine", text: "My spot" }));
  wrap.append(title);
  const summary = placeSummary(place, loc);
  if (summary) wrap.append(h("p", { class: "kicker", text: summary }));
  if (place.offer) wrap.append(h("p", { class: "popup-offer", text: clip(place.offer, 110) }));
  wrap.append(h("button", {
    type: "button",
    class: "btn btn-primary",
    text: "Details",
    onclick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (map) map.closePopup();
      openDetail(place, loc);
    },
  }));
  return wrap;
}

function buildPinSheetBody(place, loc) {
  const wrap = h("div");
  const chips = h("div", { class: "chips" });
  if (loc.callAhead) chips.append(callAheadBadge());
  if (place.kind === "spot") chips.append(h("span", { class: "chip chip-mine", text: "My spot" }));
  const offerChipNode = offerChip(place.offerLabel);
  if (offerChipNode) chips.append(offerChipNode);
  if (chips.childNodes.length) wrap.append(chips);
  const summary = placeSummary(place, loc);
  if (summary) wrap.append(h("p", { class: "kicker", text: summary }));
  if (place.offer) wrap.append(h("p", { class: "popup-offer", text: place.offer }));
  wrap.append(buildCallout(loc));
  const address = formatAddress(loc);
  if (address) wrap.append(h("p", { class: "addr", text: address }));
  wrap.append(mapsRow(loc));
  wrap.append(h("button", {
    type: "button",
    class: "btn btn-primary",
    text: "Details",
    onclick: () => openDetail(place, loc),
  }));
  return wrap;
}

function renderMarkers() {
  if (!cluster || !window.L) return;
  cluster.clearLayers();
  const filters = readFilters();
  for (const place of allPlaces()) {
    if (!placeMatches(place, filters)) continue;
    for (const loc of place.locations) {
      if (loc.lat == null || loc.lng == null) continue;
      const marker = L.marker([loc.lat, loc.lng], {
        icon: makeIcon(place, loc),
        title: loc.callAhead ? `${loc.name}. Call ahead.` : loc.name,
        keyboard: true,
        alt: loc.name,
      });
      if (prefersPinSheet()) {
        marker.on("click", () => showPlaceOnCard(place, loc));
      } else {
        const mapHeight = map && map.getSize ? map.getSize().y : 480;
        marker.bindPopup(() => buildPopup(place, loc), {
          className: "pin-popup",
          maxWidth: 300,
          minWidth: 220,
          maxHeight: Math.max(140, mapHeight - 96),
          autoPan: true,
          keepInView: false,
          autoPanPadding: [28, 28],
        });
      }
      cluster.addLayer(marker);
    }
  }
  scheduleLabels();
}

function scheduleLabels() {
  requestAnimationFrame(() => {
    layoutPinLabels();
    if (map && map.getZoom() >= NAME_ZOOM && document.querySelectorAll("#map .pin-chip:not(.is-dot)").length === 0) {
      setTimeout(layoutPinLabels, 150);
    }
  });
}

function showUserDot() {
  if (!map || !origin || !window.L) return;
  if (!userLayer) userLayer = L.layerGroup().addTo(map);
  userLayer.clearLayers();
  L.circleMarker([origin.lat, origin.lng], {
    radius: 8,
    color: "#d7e6ff",
    weight: 2,
    fillColor: "#4c8dff",
    fillOpacity: 1,
  }).bindTooltip("You are here").addTo(userLayer);
}

function initMap() {
  const host = document.getElementById("map");
  if (!window.L) {
    host.replaceChildren(h("p", { class: "empty", text: "The map could not load. The List tab still has every place." }));
    return;
  }
  map = L.map(host, { scrollWheelZoom: true, zoomControl: false, maxZoom: 19 }).setView(SA_CENTER, 11);
  L.control.zoom({ position: "topright" }).addTo(map);
  // CARTO Voyager now paints "API KEY REQUIRED" on every tile. OpenFreeMap Bright
  // is the free, no-key style in that same light family.
  if (typeof L.maplibreGL === "function") {
    L.maplibreGL({
      style: "https://tiles.openfreemap.org/styles/bright",
      attribution: '&copy; <a href="https://openfreemap.org/">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/copyright">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
  } else {
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
  }
  if (typeof L.markerClusterGroup === "function") {
    cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 56,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 15,
      iconCreateFunction: placeClusterIcon,
    });
  } else {
    cluster = L.layerGroup();
  }
  map.addLayer(cluster);
  map.on("zoomend moveend", scheduleLabels);
  if (cluster && cluster.on) cluster.on("animationend", scheduleLabels);
  map.on("click", () => { if (map) map.closePopup(); });
  window.__vetsMap = map;
  window.__vets = {
    get map() { return map; },
    pinCount: () => (cluster && cluster.getLayers ? cluster.getLayers().length : 0),
    nearest(lat, lng) {
      if (!cluster) return null;
      let best = null;
      let bestD = Infinity;
      for (const marker of cluster.getLayers()) {
        if (!marker.getLatLng) continue;
        const ll = marker.getLatLng();
        const d = (ll.lat - lat) ** 2 + (ll.lng - lng) ** 2;
        if (d < bestD) {
          bestD = d;
          best = marker;
        }
      }
      return best;
    },
    reveal(lat, lng) {
      const best = this.nearest(lat, lng);
      if (!best || !map) return Promise.resolve(null);
      const finish = () => {
        const icon = best.getElement();
        if (!icon) return null;
        const rect = icon.getBoundingClientRect();
        const ll = best.getLatLng();
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          lat: ll.lat,
          lng: ll.lng,
          name: best.options.title || "",
        };
      };
      return new Promise((resolve) => {
        if (cluster.zoomToShowLayer) cluster.zoomToShowLayer(best, () => resolve(finish()));
        else resolve(finish());
      });
    },
    parkAt(lat, lng, edge) {
      const ll = L.latLng(lat, lng);
      map.setView(ll, 17, { animate: false });
      const size = map.getSize();
      const point = map.latLngToContainerPoint(ll);
      const target = {
        north: [size.x / 2, 36],
        south: [size.x / 2, size.y - 20],
        west: [24, size.y / 2],
        east: [size.x - 24, size.y / 2],
        center: [size.x / 2, size.y / 2],
      }[edge] || [size.x / 2, size.y / 2];
      map.panBy([point.x - target[0], point.y - target[1]], { animate: false });
      const icon = this.nearest(lat, lng).getElement();
      const rect = icon.getBoundingClientRect();
      const center = map.getCenter();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        center: { lat: center.lat, lng: center.lng },
      };
    },
  };
  requestAnimationFrame(() => map.invalidateSize());
}

function appendRich(parent, text) {
  const re = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let last = 0;
  for (const match of String(text || "").matchAll(re)) {
    parent.append(text.slice(last, match.index));
    const token = match[0];
    if (token.includes("@")) parent.append(h("a", { href: `mailto:${token}`, text: token }));
    else parent.append(h("a", { href: telHref(token) || `tel:${token.replace(/[^\d+]/g, "")}`, text: token }));
    last = match.index + token.length;
  }
  parent.append(text.slice(last));
}

function renderHelp() {
  const root = document.getElementById("help-list");
  root.replaceChildren();
  if (helpSource !== "live" && loaded) {
    root.append(h("p", { class: "source-line", text: "Showing the saved copy of community food help." }));
  }
  if (!communityRows.length) {
    root.append(h("p", { class: "empty", text: "No community listings are available." }));
    return;
  }
  for (const row of communityRows) {
    const name = field(row, "Organization");
    if (!name) continue;
    const card = h("article", { class: "card" });
    card.append(h("h3", { text: name }));
    const address = field(row, "Address");
    if (address) {
      const p = h("p", { class: "addr" });
      appendRich(p, address);
      card.append(p);
    }
    const facts = h("dl", { class: "facts" });
    for (const [label, key] of [
      ["What they offer", "What they offer"],
      ["Who qualifies", "Who qualifies"],
      ["Schedule", "Schedule"],
    ]) {
      const value = field(row, key);
      if (!value) continue;
      const item = h("div");
      const dd = h("dd");
      appendRich(dd, value);
      item.append(h("dt", { text: label }), dd);
      facts.append(item);
    }
    card.append(facts);
    const site = safeHttp(field(row, "Website/Source"));
    if (site) card.append(h("p", { class: "links" }, [extA(site, "Website / source")]));
    root.append(card);
  }
}

function renderAbout() {
  const root = document.getElementById("about-body");
  const entries = aboutEntries.length
    ? aboutEntries
    : [
        { key: "purpose", value: "A directory of Veterans Day meals and community food help in San Antonio, Texas." },
        { key: "last_updated", value: "November 10, 2026" },
        { key: "disclaimer", value: FALLBACK_DISCLAIMER },
      ];
  const purpose = entries.find((entry) => /purpose/i.test(entry.key));
  const disclaimer = entries.find((entry) => /disclaimer/i.test(entry.key));
  root.replaceChildren();
  if (purpose) root.append(h("p", { class: "lede", text: purpose.value }));
  const box = h("aside", { class: "disclaimer" });
  box.setAttribute("aria-label", "Disclaimer");
  box.append(h("h3", { text: "Disclaimer" }));
  box.append(h("p", { text: disclaimer?.value || FALLBACK_DISCLAIMER }));
  root.append(box);
  const facts = h("dl", { class: "facts" });
  for (const entry of entries) {
    if (/disclaimer|purpose/i.test(entry.key)) continue;
    addFact(facts, labelize(entry.key), entry.value);
  }
  if (facts.childElementCount) root.append(facts);
  root.append(h("h3", { text: "Where the listings come from" }));
  const fromSheet = dirSource === "live"
    ? "Restaurant listings were loaded from the public Google Sheet."
    : "Restaurant listings are the saved copy bundled with this app, because the live sheet could not be read.";
  const aboutBit = aboutSource === "live"
    ? "The About text was loaded from that sheet."
    : "The About text is the saved copy dated November 10, 2026.";
  root.append(h("p", { text: `${fromSheet} ${aboutBit}` }));
  root.append(h("h3", { text: "On this device" }));
  root.append(h("p", { text: "Favorites, hidden places, private notes, and spots you add stay in this browser. They are never written to the public sheet. Download spreadsheet saves a copy you can open in Excel. Import spreadsheet adds that copy back onto a phone without removing what is already there." }));
  const credit = h("footer", { class: "menu-footer" });
  credit.append(h("p", {}, ["© 2026 ", h("a", { href: "https://github.com/ocultos-labs-llc", rel: "noopener noreferrer", text: "Ocultos Labs LLC" }), ". All rights reserved."]));
  credit.append(h("p", {}, [h("a", { href: "https://github.com/aiontrust", rel: "noopener noreferrer", text: "Built by aiontrust" })]));
  root.append(credit);
}

function lookupName(id) {
  const place = allPlaces().find((item) => item.id === id);
  if (place) return place.name;
  return id.replace(/^rest:/, "").replace(/^spot:/, "Spot ");
}

function renderMineLists() {
  const spots = document.getElementById("spot-list");
  const hidden = document.getElementById("hidden-list");
  const favs = document.getElementById("fav-list");
  if (!spots || !hidden || !favs) return;
  const spotPlaces = personal.spots.map(spotToPlace);
  spots.replaceChildren();
  if (!spotPlaces.length) spots.append(h("p", { class: "empty", text: "You haven't added a spot yet." }));
  else for (const place of spotPlaces) spots.append(renderSpotCard(place));

  const favIds = Object.keys(personal.favorites).filter((id) => personal.favorites[id] && !personal.spots.some((spot) => spot.id === id));
  favs.replaceChildren();
  if (!favIds.length) favs.append(h("p", { class: "empty", text: "No favorites yet. Star a place to keep it here." }));
  for (const id of favIds) {
    const row = h("div", { class: "card hidden-row" });
    row.append(h("h3", { text: lookupName(id) }));
    row.append(h("div", { class: "card-actions" }, [
      h("button", { type: "button", class: "btn btn-ghost", text: "Open", onclick: () => {
        const place = allPlaces().find((item) => item.id === id);
        if (place) showPlaceOnCard(place, place.locations[0]);
      } }),
      h("button", { type: "button", class: "btn btn-ghost", text: "Unfavorite", onclick: () => onFavorite(id) }),
    ]));
    favs.append(row);
  }

  const ids = Object.keys(personal.hidden).filter((id) => personal.hidden[id] && !personal.spots.some((spot) => spot.id === id));
  hidden.replaceChildren();
  if (!ids.length) hidden.append(h("p", { class: "empty", text: "Nothing is hidden." }));
  for (const id of ids) {
    const row = h("div", { class: "card hidden-row" });
    row.append(h("h3", { text: lookupName(id) }));
    row.append(h("button", {
      type: "button",
      class: "btn btn-ghost",
      text: "Unhide",
      onclick: () => {
        delete personal.hidden[id];
        persist();
        renderDynamic();
        toast(`Restored ${lookupName(id)}.`);
      },
    }));
    hidden.append(row);
  }
}

function applyListMode() {
  const mine = listMode === "mine";
  const allPanel = document.getElementById("all-panel");
  const minePanel = document.getElementById("mine-panel");
  if (allPanel) allPanel.hidden = mine;
  if (minePanel) minePanel.hidden = !mine;
  const allBtn = document.getElementById("show-all");
  const mineBtn = document.getElementById("show-mine");
  if (allBtn) allBtn.setAttribute("aria-selected", mine ? "false" : "true");
  if (mineBtn) mineBtn.setAttribute("aria-selected", mine ? "true" : "false");
}

function renderDynamic() {
  renderList();
  renderCard();
  renderMarkers();
  renderMineLists();
}

function buildDetail(place, loc) {
  const root = document.createDocumentFragment();
  const kicker = [];
  if (place.kind !== "spot" && place.name && place.name !== loc.name) kicker.push(place.name);
  if (place.offerLabel) kicker.push(place.offerLabel);
  if (place.category && place.kind !== "spot") kicker.push(place.category);
  if (kicker.length) root.append(h("p", { class: "kicker", text: kicker.join(" · ") }));
  const titleRow = h("div", { class: "title-row" });
  titleRow.append(h("h2", { id: "detail-title", text: loc.name }));
  if (loc.callAhead) titleRow.append(callAheadBadge());
  if (place.kind === "spot") titleRow.append(h("span", { class: "chip chip-mine", text: "My spot" }));
  root.append(titleRow);
  root.append(buildCallout(loc));
  const address = formatAddress(loc);
  if (address) root.append(h("p", { class: "addr", text: address }));
  if (loc.area) root.append(h("p", { class: "meta", text: loc.area }));
  if (loc.lat == null) root.append(h("p", { class: "hint", text: "No map pin for this address. Use the map buttons to look it up." }));
  root.append(mapsRow(loc));
  if (loc.menu) root.append(h("p", { class: "links" }, [extA(loc.menu, "Menu")]));
  if (place.offer) {
    const p = h("p", { class: "offer" });
    p.append(h("span", { class: "offer-label", text: "Offer" }), place.offer);
    root.append(p);
  }
  const facts = h("dl", { class: "facts" });
  addFact(facts, "Hours", place.hours);
  addFact(facts, "ID / proof", place.proof);
  addFact(facts, "Participation", place.participation);
  addFact(facts, "Dates", place.dates);
  addFact(facts, "Dine-in / takeout", place.service);
  if (place.notes) addFact(facts, "Notes", place.notes);
  if (facts.childElementCount) root.append(facts);
  const links = h("p", { class: "links" });
  if (place.sourceUrl) links.append(extA(place.sourceUrl, "Source"));
  if (place.website) links.append(extA(place.website, "Website"));
  if (links.childNodes.length) root.append(links);
  const actions = [favoriteButton(place.id)];
  if (place.kind === "spot") {
    actions.push(h("button", { type: "button", class: "btn btn-ghost", text: "Edit", onclick: () => { closeDetail({ restore: false }); startEdit(place.spot); } }));
    actions.push(h("button", { type: "button", class: "btn btn-ghost", text: "Delete", onclick: () => { closeDetail({ restore: false }); deleteSpot(place.spot); } }));
  } else {
    actions.push(h("button", { type: "button", class: "btn btn-ghost", text: "Hide", onclick: () => hidePlace(place) }));
  }
  root.append(h("div", { class: "card-actions" }, actions));
  root.append(noteBox(place.id));
  return root;
}

function setPageInert(on) {
  for (const id of ["topbar", "main", "site-footer", "tabbar"]) {
    const el = document.getElementById(id);
    if (el && "inert" in el) el.inert = on;
  }
}

function closePinSheet() {
  const sheet = document.getElementById("pin-sheet");
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
}

function nudgePinAboveSheet(loc) {
  if (!map || loc.lat == null || loc.lng == null) return;
  const card = document.querySelector(".pin-sheet-card");
  if (!card) return;
  const mapRect = map.getContainer().getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const point = map.latLngToContainerPoint([loc.lat, loc.lng]);
  const visibleBottom = cardRect.top - mapRect.top - 36;
  if (visibleBottom < 72) return;
  if (point.y > visibleBottom) {
    map.panBy([0, point.y - visibleBottom], { animate: true, duration: 0.25 });
  } else if (point.y < 40) {
    map.panBy([0, point.y - 72], { animate: true, duration: 0.25 });
  }
}

function openPinSheet(place, loc) {
  if (!place || !loc) return;
  if (map) map.closePopup();
  document.getElementById("pin-sheet-title").textContent = loc.name;
  document.getElementById("pin-sheet-body").replaceChildren(buildPinSheetBody(place, loc));
  document.getElementById("pin-sheet").hidden = false;
  requestAnimationFrame(() => nudgePinAboveSheet(loc));
}

function openDetail(place, loc) {
  if (!place || !loc) return;
  closePinSheet();
  lastFocus = document.activeElement;
  document.getElementById("detail-body").replaceChildren(buildDetail(place, loc));
  document.getElementById("detail-root").hidden = false;
  setPageInert(true);
  document.getElementById("detail-close").focus();
}

function closeDetail({ restore = true } = {}) {
  const root = document.getElementById("detail-root");
  if (root.hidden) return;
  root.hidden = true;
  setPageInert(false);
  if (restore && lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  lastFocus = null;
}

function showView(name, { fromHash = false } = {}) {
  if (name === "mine") listMode = "mine";
  else if (name === "list") listMode = "all";
  if (!VIEWS.includes(name)) name = "map";
  const view = name === "mine" ? "list" : name;
  closeDetail({ restore: false });
  closeMenu();
  const title = document.getElementById("bar-title");
  if (title) title.textContent = view === "list" && listMode === "mine" ? "My Spots" : (VIEW_TITLES[view] || "Map");
  for (const id of VIEWS) {
    const section = document.getElementById(`view-${id}`);
    if (!section) continue;
    const on = id === view;
    section.hidden = !on;
    section.classList.toggle("is-active", on);
  }
  document.querySelectorAll("#tabbar a").forEach((link) => {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  applyListMode();
  const hashName = view === "list" && listMode === "mine" ? "mine" : view;
  if (!fromHash && (location.hash.replace("#", "") || "map") !== hashName) location.hash = hashName;
  if (view === "map" && map) requestAnimationFrame(() => map.invalidateSize());
}

function viewFromHash() {
  const name = (location.hash || "#map").replace("#", "");
  return VIEWS.includes(name) ? name : "map";
}

function fillAreas() {
  const select = document.getElementById("area");
  const current = select.value;
  select.replaceChildren(new Option("All areas", ""));
  for (const area of areaOptions(directory)) select.append(new Option(area, area));
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function setNearPressed(on) {
  for (const id of ["near-btn", "map-near"]) {
    document.getElementById(id).setAttribute("aria-pressed", on ? "true" : "false");
  }
  document.getElementById("clear-near").hidden = !on;
}

function setLocating(on) {
  const near = document.getElementById("near-btn");
  if (near) {
    near.disabled = on;
    near.textContent = on ? "Locating…" : "Near me";
  }
  const fab = document.getElementById("map-near");
  if (fab) {
    fab.disabled = on;
    fab.setAttribute("aria-label", on ? "Finding your location" : "Near me");
  }
}

function locate() {
  if (origin) {
    if (map) map.setView([origin.lat, origin.lng], Math.max(map.getZoom(), 12));
    return;
  }
  if (!navigator.geolocation) {
    toast("This browser can't share your location. You can still browse the list.");
    return;
  }
  setLocating(true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setLocating(false);
      setNearPressed(true);
      showUserDot();
      if (map) map.setView([origin.lat, origin.lng], Math.max(map.getZoom(), 14));
      renderDynamic();
      toast("Sorted by distance from you.");
    },
    (err) => {
      setLocating(false);
      toast(err && err.code === 1
        ? "Location permission was denied. You can still browse the list."
        : "Couldn't read your location. Try again.");
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
  );
}

function clearNear() {
  origin = null;
  setNearPressed(false);
  if (userLayer) userLayer.clearLayers();
  renderDynamic();
}

function clearFilters() {
  document.getElementById("q").value = "";
  document.getElementById("offer").value = "";
  document.getElementById("service").value = "";
  document.getElementById("area").value = "";
  document.getElementById("fav-only").setAttribute("aria-pressed", "false");
  clearNear();
}

const form = document.getElementById("spot-form");

function resetForm() {
  form.reset();
  delete form.dataset.id;
  document.getElementById("form-heading").textContent = "Add a spot";
  document.getElementById("spot-save").textContent = "Save spot";
  document.getElementById("spot-cancel").hidden = true;
  const err = document.getElementById("form-error");
  err.hidden = true;
  err.textContent = "";
}

function showFormError(message) {
  const err = document.getElementById("form-error");
  err.hidden = false;
  err.textContent = message;
}

function startEdit(spot) {
  showView("mine");
  form.dataset.id = spot.id;
  document.getElementById("spot-name").value = spot.name;
  document.getElementById("spot-address").value = spot.address;
  document.getElementById("spot-offer").value = spot.offer || "";
  document.getElementById("spot-notes").value = spot.notes || "";
  document.getElementById("spot-coords").value = spot.lat != null && spot.lng != null ? `${spot.lat}, ${spot.lng}` : "";
  document.getElementById("spot-link").value = "";
  document.getElementById("form-heading").textContent = "Edit spot";
  document.getElementById("spot-save").textContent = "Save changes";
  document.getElementById("spot-cancel").hidden = false;
  document.getElementById("form-heading").scrollIntoView({ block: "start" });
  document.getElementById("spot-name").focus();
}

function deleteSpot(spot) {
  if (!confirm(`Delete ${spot.name} from this device?`)) return;
  personal.spots = personal.spots.filter((item) => item.id !== spot.id);
  delete personal.favorites[spot.id];
  delete personal.hidden[spot.id];
  delete personal.notes[spot.id];
  if (form.dataset.id === spot.id) resetForm();
  persist();
  renderDynamic();
  toast("Deleted from this device.");
}

function readCoords(coordsText, linkText) {
  if (!coordsText && !linkText) return { lat: null, lng: null };
  const parsed = (linkText && parseLatLng(linkText)) || (coordsText && parseLatLng(coordsText));
  if (!parsed) {
    return { error: "Couldn't read coordinates. Use latitude, longitude like 29.4241, -98.4936, or paste a Google Maps link that includes the pin." };
  }
  return parsed;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.getElementById("spot-name").value.trim();
  const address = document.getElementById("spot-address").value.trim();
  const offer = document.getElementById("spot-offer").value.trim();
  const notes = document.getElementById("spot-notes").value.trim();
  const coordsText = document.getElementById("spot-coords").value.trim();
  const linkText = document.getElementById("spot-link").value.trim();
  if (!name || !address) {
    showFormError("Name and address are required.");
    return;
  }
  const coords = readCoords(coordsText, linkText);
  if (coords.error) {
    showFormError(coords.error);
    return;
  }
  const editing = form.dataset.id || "";
  if (editing) {
    const spot = personal.spots.find((item) => item.id === editing);
    if (!spot) {
      showFormError("That spot is no longer saved on this device.");
      return;
    }
    Object.assign(spot, {
      name,
      address,
      offer,
      notes,
      lat: coords.lat,
      lng: coords.lng,
      updatedAt: new Date().toISOString(),
    });
  } else {
    personal.spots.push({
      id: `spot:${crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`,
      name,
      address,
      offer,
      notes,
      lat: coords.lat,
      lng: coords.lng,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  if (!persist()) return;
  resetForm();
  renderDynamic();
  toast(coords.lat == null
    ? "Saved on this device without a map pin."
    : "Saved on this device. Your spot is marked My spot.");
});

document.getElementById("spot-cancel").addEventListener("click", resetForm);

function currentRows() {
  return spreadsheetRows(personal, directory);
}

function downloadSpreadsheet() {
  const csv = toCsv(currentRows());
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: "My Veterans Day Spots.csv" });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("Spreadsheet downloaded.");
}

function printLine(label, value) {
  if (!value) return null;
  const p = h("p");
  p.append(h("strong", { text: `${label}: ` }), value);
  return p;
}

function fillPrintSheet(rows) {
  const list = document.getElementById("print-list");
  document.getElementById("print-date").textContent = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  list.replaceChildren();
  if (!rows.length) {
    list.append(h("p", { class: "print-empty", text: "Nothing saved yet." }));
    return;
  }
  for (const record of rows) {
    const card = h("article", { class: "print-card" });
    card.append(h("p", { class: "print-type", text: record.Type }));
    card.append(h("h2", { text: record.Name }));
    if (record.Address) card.append(h("p", { text: record.Address }));
    const offer = printLine("Offer", record.Offer);
    const notes = printLine("My notes", record["My notes"]);
    const phone = printLine("Phone", record.Phone);
    if (offer) card.append(offer);
    if (notes) card.append(notes);
    if (phone) card.append(phone);
    card.append(h("p", { text: record.Hidden === "yes" ? "Hidden: yes" : "Hidden: no" }));
    if (record["Google Maps link"]) {
      card.append(h("p", {}, [h("span", { text: "Google Maps: " }), h("a", { href: record["Google Maps link"], text: record["Google Maps link"] })]));
    }
    if (record["Apple Maps link"]) {
      card.append(h("p", {}, [h("span", { text: "Apple Maps: " }), h("a", { href: record["Apple Maps link"], text: record["Apple Maps link"] })]));
    }
    list.append(card);
  }
}

function closePrintSheet() {
  document.body.classList.remove("is-printing");
  document.getElementById("print-sheet").hidden = true;
}

function savePdf() {
  fillPrintSheet(currentRows());
  const sheet = document.getElementById("print-sheet");
  sheet.hidden = false;
  document.body.classList.add("is-printing");
  const cleanup = () => {
    closePrintSheet();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.setTimeout(() => window.print(), 50);
}

document.getElementById("download-csv").addEventListener("click", downloadSpreadsheet);
document.getElementById("save-pdf").addEventListener("click", savePdf);
document.getElementById("print-back").addEventListener("click", closePrintSheet);
document.getElementById("import-csv-btn").addEventListener("click", () => {
  document.getElementById("import-csv").click();
});

document.getElementById("import-csv").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const records = parseSpreadsheet(await file.text());
    if (!records.length) {
      toast("That spreadsheet doesn't list any spots.");
      return;
    }
    const merged = mergeSpreadsheet(personal, records, directory);
    personal.spots = merged.personal.spots;
    personal.favorites = merged.personal.favorites;
    personal.hidden = merged.personal.hidden;
    personal.notes = merged.personal.notes;
    personal.version = 1;
    if (!persist()) return;
    renderDynamic();
    toast(importSummary(merged.summary));
  } catch {
    toast("That file doesn't look like a spreadsheet saved by this app.");
  }
});

document.getElementById("q").addEventListener("input", renderDynamic);
document.getElementById("offer").addEventListener("change", renderDynamic);
document.getElementById("service").addEventListener("change", renderDynamic);
document.getElementById("area").addEventListener("change", renderDynamic);
document.getElementById("fav-only").addEventListener("click", (event) => {
  const on = event.currentTarget.getAttribute("aria-pressed") !== "true";
  event.currentTarget.setAttribute("aria-pressed", on ? "true" : "false");
  renderDynamic();
});
document.getElementById("near-btn").addEventListener("click", locate);
document.getElementById("map-near").addEventListener("click", locate);
document.getElementById("clear-near").addEventListener("click", clearNear);
document.getElementById("clear-filters").addEventListener("click", clearFilters);
document.getElementById("detail-close").addEventListener("click", () => closeDetail());
document.getElementById("detail-root").addEventListener("click", (event) => {
  if (event.target.dataset.close === "true") closeDetail();
});
function closeMenu() {
  const panel = document.getElementById("menu-panel");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  document.getElementById("menu-btn").setAttribute("aria-expanded", "false");
}

function openMenu() {
  document.getElementById("menu-panel").hidden = false;
  document.getElementById("menu-btn").setAttribute("aria-expanded", "true");
  document.getElementById("menu-close").focus();
}

document.getElementById("menu-btn").addEventListener("click", openMenu);
document.getElementById("menu-close").addEventListener("click", closeMenu);
document.getElementById("menu-panel").addEventListener("click", (event) => {
  if (event.target.id === "menu-panel") closeMenu();
});
document.getElementById("search-btn").addEventListener("click", () => {
  const bar = document.getElementById("search-bar");
  const open = bar.hidden;
  bar.hidden = !open;
  document.getElementById("search-btn").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) document.getElementById("q").focus();
});
document.getElementById("search-filters").addEventListener("click", openMenu);
document.getElementById("add-spot-btn").addEventListener("click", () => {
  showView("mine");
  const field = document.getElementById("spot-name");
  field.scrollIntoView({ block: "center" });
  field.focus();
});
document.getElementById("show-all").addEventListener("click", () => showView("list"));
document.getElementById("show-mine").addEventListener("click", () => showView("mine"));
document.getElementById("list-filters").addEventListener("click", openMenu);
document.getElementById("menu-heading").textContent = APP_TITLE;
document.getElementById("refresh-btn").addEventListener("click", () => reloadDirectory(true));

window.matchMedia("(max-width: 720px)").addEventListener("change", () => {
  if (map) map.closePopup();
  renderMarkers();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.getElementById("menu-panel").hidden && document.getElementById("detail-root").hidden) {
    event.preventDefault();
    closeMenu();
    return;
  }
  if (document.getElementById("detail-root").hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeDetail();
    return;
  }
  if (event.key !== "Tab") return;
  const sheet = document.querySelector(".sheet");
  const items = [...sheet.querySelectorAll("a, button, input, textarea, select")].filter((el) => !el.disabled && !el.hidden);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
window.addEventListener("hashchange", () => showView(viewFromHash(), { fromHash: true }));
window.addEventListener("resize", () => {
  if (map) map.invalidateSize();
});

initMap();
showView(viewFromHash(), { fromHash: true });
setSourceLines();
renderDynamic();

async function reloadDirectory(announce) {
  const button = document.getElementById("refresh-btn");
  if (button) button.disabled = true;
  try {
    const [directoryData, community, about] = await Promise.all([
      loadDirectory(),
      loadTable(SHEET_TABS.community, SNAPSHOTS.community, "Organization"),
      loadTable(SHEET_TABS.about, SNAPSHOTS.about, null),
    ]);
    directory = buildPlaces(directoryData.restaurants, directoryData.locations);
    dirSource = directoryData.source;
    communityRows = community.rows;
    helpSource = community.source;
    aboutEntries = parseAbout(about.rows);
    aboutSource = about.source;
    loaded = true;
    failed = false;
    fillAreas();
    setSourceLines();
    renderHelp();
    renderAbout();
    renderDynamic();
    if (map) requestAnimationFrame(() => map.invalidateSize());
    if (announce) {
      toast(dirSource === "live"
        ? "Listings updated from the public sheet."
        : "Showing the saved copy. The live sheet was unavailable.");
    }
  } catch {
    if (!loaded) {
      failed = true;
      setSourceLines();
      renderDynamic();
      renderHelp();
      renderAbout();
    }
    if (announce) toast("Couldn't reload the listings.");
  } finally {
    if (button) button.disabled = false;
  }
}

reloadDirectory(false);
