import { parseCsv } from "./csv.js?v=20261111";
import { appleHref, formatAddress, googleHref, parseLatLng, spotToPlace } from "./logic.js?v=20261111";

export const SHEET_HEADERS = [
  "Type",
  "Name",
  "Address",
  "Offer",
  "My notes",
  "Phone",
  "Google Maps link",
  "Apple Maps link",
  "Hidden",
];

const TYPE_ORDER = { "My spot": 0, Favorite: 1, Note: 2 };

function norm(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function yesNo(flag) {
  return flag ? "yes" : "no";
}

function blankRow() {
  return {
    Type: "",
    Name: "",
    Address: "",
    Offer: "",
    "My notes": "",
    Phone: "",
    "Google Maps link": "",
    "Apple Maps link": "",
    Hidden: "no",
  };
}

function withPin(url, loc) {
  if (!url || loc.lat == null || loc.lng == null) return url || "";
  if (parseLatLng(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}ll=${loc.lat},${loc.lng}`;
}

function detailsFromPlace(place) {
  const locs = place?.locations || [];
  const first = locs[0];
  const phoneLoc = locs.find((loc) => loc.phone) || first;
  let address = first ? formatAddress(first) : "";
  if (locs.length > 1 && address) address = `${address} (+${locs.length - 1} more)`;
  return {
    Name: place?.name || "",
    Address: address,
    Offer: place?.offer || "",
    Phone: phoneLoc?.phone || "",
    "Google Maps link": first ? withPin(googleHref(first), first) : "",
    "Apple Maps link": first ? withPin(appleHref(first), first) : "",
  };
}

function placeName(id, byId) {
  if (byId.has(id)) return byId.get(id).name;
  return String(id || "").replace(/^rest:/, "").replace(/^spot:/, "");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows) {
  const lines = [SHEET_HEADERS.join(",")];
  for (const record of rows) {
    lines.push(SHEET_HEADERS.map((header) => csvEscape(record[header])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function spreadsheetRows(personal, directory) {
  const spots = personal.spots || [];
  const byId = new Map();
  for (const place of directory || []) byId.set(place.id, place);
  for (const place of spots.map(spotToPlace)) byId.set(place.id, place);

  const rows = [];
  const seen = new Set();

  const orderedSpots = spots.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const spot of orderedSpots) {
    rows.push({
      ...blankRow(),
      Type: "My spot",
      ...detailsFromPlace(byId.get(spot.id)),
      "My notes": spot.notes || "",
      Hidden: yesNo(personal.hidden?.[spot.id]),
    });
    seen.add(spot.id);
  }

  const favIds = Object.keys(personal.favorites || {}).filter((id) => personal.favorites[id]);
  favIds.sort((a, b) => placeName(a, byId).localeCompare(placeName(b, byId), undefined, { sensitivity: "base" }));
  for (const id of favIds) {
    const place = byId.get(id);
    rows.push({
      ...blankRow(),
      Type: "Favorite",
      ...(place ? detailsFromPlace(place) : { Name: placeName(id, byId) }),
      Hidden: yesNo(personal.hidden?.[id]),
    });
    seen.add(id);
  }

  const noteIds = Object.keys(personal.notes || {}).filter((id) => String(personal.notes[id] || "").trim());
  noteIds.sort((a, b) => placeName(a, byId).localeCompare(placeName(b, byId), undefined, { sensitivity: "base" }));
  for (const id of noteIds) {
    const place = byId.get(id);
    rows.push({
      ...blankRow(),
      Type: "Note",
      ...(place ? detailsFromPlace(place) : { Name: placeName(id, byId) }),
      "My notes": String(personal.notes[id]).trim(),
      Hidden: yesNo(personal.hidden?.[id]),
    });
    seen.add(id);
  }

  const hiddenOnly = Object.keys(personal.hidden || {}).filter((id) => personal.hidden[id] && !seen.has(id));
  hiddenOnly.sort((a, b) => placeName(a, byId).localeCompare(placeName(b, byId), undefined, { sensitivity: "base" }));
  for (const id of hiddenOnly) {
    const place = byId.get(id);
    rows.push({
      ...blankRow(),
      Type: "Note",
      ...(place ? detailsFromPlace(place) : { Name: placeName(id, byId) }),
      "My notes": "",
      Hidden: "yes",
    });
  }

  return rows;
}

function headerMap(record) {
  const map = {};
  for (const key of Object.keys(record)) map[key.trim().toLowerCase()] = key;
  return map;
}

function canonicalType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "my spot") return "My spot";
  if (text === "favorite") return "Favorite";
  if (text === "note") return "Note";
  return "";
}

function isYes(value) {
  return /^(yes|y|true|1)$/i.test(String(value || "").trim());
}

export function parseSpreadsheet(text) {
  const src = String(text || "");
  if (!src.trim()) throw new Error("That file is empty.");
  const headerLine = src.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  if (!/type/i.test(headerLine) || !/name/i.test(headerLine)) {
    throw new Error("That file doesn't look like a spreadsheet saved by this app.");
  }
  const records = parseCsv(src);
  return records.map((record) => {
    const keys = headerMap(record);
    const pick = (name) => {
      const key = keys[name.toLowerCase()];
      return key ? String(record[key] || "").trim() : "";
    };
    return {
      Type: canonicalType(pick("Type")),
      Name: pick("Name"),
      Address: pick("Address"),
      Offer: pick("Offer"),
      "My notes": pick("My notes"),
      Phone: pick("Phone"),
      "Google Maps link": pick("Google Maps link"),
      "Apple Maps link": pick("Apple Maps link"),
      Hidden: isYes(pick("Hidden")) ? "yes" : "no",
    };
  }).filter((record) => record.Type && record.Name);
}

function findSpots(spots, name, address) {
  const wantedName = norm(name);
  const wantedAddress = norm(address);
  return spots.filter((spot) => {
    if (norm(spot.name) !== wantedName) return false;
    if (!wantedAddress) return true;
    return norm(spot.address) === wantedAddress;
  });
}

function resolveId(personal, directory, name, address) {
  const spots = findSpots(personal.spots, name, address);
  if (spots.length === 1) return spots[0].id;
  const restaurant = (directory || []).find((place) => norm(place.name) === norm(name));
  if (restaurant) return restaurant.id;
  if (!spots.length && name) return `rest:${name.trim()}`;
  return "";
}

function newSpotId() {
  if (globalThis.crypto?.randomUUID) return `spot:${crypto.randomUUID()}`;
  return `spot:${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function hide(next, id, summary) {
  if (!id || next.hidden[id]) return;
  next.hidden[id] = true;
  summary.hidden += 1;
}

export function mergeSpreadsheet(personal, records, directory) {
  const next = {
    version: 1,
    spots: (personal.spots || []).map((spot) => ({ ...spot })),
    favorites: { ...(personal.favorites || {}) },
    hidden: { ...(personal.hidden || {}) },
    notes: { ...(personal.notes || {}) },
  };
  const summary = { spots: 0, favorites: 0, notes: 0, hidden: 0, skipped: 0 };
  const ordered = records.slice().sort((a, b) => (TYPE_ORDER[a.Type] ?? 9) - (TYPE_ORDER[b.Type] ?? 9));

  for (const record of ordered) {
    const hidden = record.Hidden === "yes";
    if (record.Type === "My spot") {
      if (!record.Address) {
        summary.skipped += 1;
        continue;
      }
      const existing = findSpots(next.spots, record.Name, record.Address);
      if (existing.length) {
        summary.skipped += 1;
        if (hidden) hide(next, existing[0].id, summary);
        continue;
      }
      const coords = parseLatLng(record["Google Maps link"]) || parseLatLng(record["Apple Maps link"]);
      const spot = {
        id: newSpotId(),
        name: record.Name,
        address: record.Address,
        offer: record.Offer,
        notes: record["My notes"],
        lat: coords ? coords.lat : null,
        lng: coords ? coords.lng : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      next.spots.push(spot);
      summary.spots += 1;
      if (hidden) hide(next, spot.id, summary);
      continue;
    }

    const id = resolveId(next, directory, record.Name, record.Address);
    if (!id) {
      summary.skipped += 1;
      continue;
    }
    if (record.Type === "Favorite") {
      if (next.favorites[id]) summary.skipped += 1;
      else {
        next.favorites[id] = true;
        summary.favorites += 1;
      }
      if (hidden) hide(next, id, summary);
      continue;
    }
    if (record.Type === "Note") {
      const text = record["My notes"].trim();
      if (text) {
        const prev = String(next.notes[id] || "").trim();
        if (!prev) {
          next.notes[id] = text;
          summary.notes += 1;
        } else if (prev === text || prev.includes(text)) {
          summary.skipped += 1;
        } else {
          next.notes[id] = `${prev}\n\n${text}`;
          summary.notes += 1;
        }
      } else if (!hidden) {
        summary.skipped += 1;
      }
      if (hidden) hide(next, id, summary);
    }
  }

  return { personal: next, summary };
}

export function importSummary(summary) {
  const parts = [];
  if (summary.spots) parts.push(summary.spots === 1 ? "1 spot" : `${summary.spots} spots`);
  if (summary.favorites) parts.push(summary.favorites === 1 ? "1 favorite" : `${summary.favorites} favorites`);
  if (summary.notes) parts.push(summary.notes === 1 ? "1 note" : `${summary.notes} notes`);
  if (summary.hidden) parts.push(summary.hidden === 1 ? "1 hidden place" : `${summary.hidden} hidden places`);
  if (!parts.length) return "Nothing new to add. Those were already on this device.";
  const added = `Added ${parts.join(", ")} on this device.`;
  if (summary.skipped) {
    return `${added} Skipped ${summary.skipped} already saved.`;
  }
  return added;
}
