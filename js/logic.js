import { FALLBACK_DISCLAIMER } from "./config.js";

export function field(row, ...names) {
  if (!row) return "";
  const keys = Object.keys(row);
  for (const name of names) {
    const hit = keys.find((key) => key.trim().toLowerCase() === name.toLowerCase());
    if (hit == null) continue;
    const value = row[hit];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

export function safeHttp(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

export function isCallAhead(name) {
  return /call ahead/i.test(name || "");
}

export function parseCoordPair(value) {
  const match = String(value || "").match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Latitude/longitude text, or a Google/Apple Maps link that contains a pin. */
export function parseLatLng(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  const patterns = [
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /[?&](?:q|query|ll|sll|center)=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/i,
    /(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return null;
}

export function telHref(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length < 7) return "";
  return `tel:${cleaned}`;
}

export function formatAddress(loc) {
  let city = "";
  if (loc.city && loc.zip) city = `${loc.city}, TX ${loc.zip}`;
  else if (loc.city) city = `${loc.city}, TX`;
  else if (loc.zip) city = `TX ${loc.zip}`;
  return [loc.address, city].filter(Boolean).join(", ");
}

export function mapsQuery(loc) {
  return [loc.name, loc.address, loc.city, loc.city ? "TX" : "", loc.zip].filter(Boolean).join(", ");
}

export function googleHref(loc) {
  const given = safeHttp(loc.google);
  if (given) return given;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery(loc))}`;
}

export function appleHref(loc) {
  const given = safeHttp(loc.apple);
  if (given) return given;
  let url = `https://maps.apple.com/?q=${encodeURIComponent(mapsQuery(loc))}`;
  if (loc.lat != null && loc.lng != null) url += `&ll=${loc.lat},${loc.lng}`;
  return url;
}

export function matchesOffer(offerLabel, offer, filter) {
  if (!filter) return true;
  const blob = `${offerLabel || ""} ${offer || ""}`.toLowerCase();
  if (filter === "free") return blob.includes("free");
  if (filter === "discount") return blob.includes("discount");
  return true;
}

export function matchesService(service, filter) {
  if (!filter) return true;
  const value = (service || "").toLowerCase();
  const dine = /dine-in|in-store|in-restaurant|in-shop|in-stand|in-shack|in-center|in-person|walk-in/.test(value);
  const take = /take-?out|carry-?out|drive[-\s]?thru|to-go|pickup|call-in|bww go|\bboth\b/.test(value);
  if (filter === "dine") return dine || !take;
  if (filter === "takeout") return take || !dine;
  return true;
}

function haystack(place) {
  const parts = [
    place.name,
    place.category,
    place.offer,
    place.offerLabel,
    place.service,
    place.hours,
    place.proof,
    place.participation,
    place.dates,
    place.areaSummary,
    place.listedLocations,
    place.notes,
  ];
  for (const loc of place.locations || []) {
    parts.push(loc.name, loc.address, loc.city, loc.zip, loc.area, loc.phone);
  }
  return parts.filter(Boolean).join("\n").toLowerCase();
}

export function placeMatches(place, filters) {
  const query = (filters.q || "").trim().toLowerCase();
  if (query && !haystack(place).includes(query)) return false;
  if (filters.hiddenIds && filters.hiddenIds[place.id]) return false;
  if (filters.favorites && !(filters.favoriteIds && filters.favoriteIds[place.id])) return false;
  if (filters.offer && !matchesOffer(place.offerLabel, place.offer, filters.offer)) return false;
  if (filters.service) {
    if (place.kind === "spot") return false;
    if (!matchesService(place.service, filters.service)) return false;
  }
  if (filters.area) {
    const area = filters.area.toLowerCase();
    const hit = (place.locations || []).some((loc) => (loc.area || "").toLowerCase() === area);
    if (!hit) return false;
  }
  return true;
}

export function milesBetween(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earth = 3958.7613;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function closestMiles(place, origin) {
  let best = Infinity;
  for (const loc of place.locations || []) {
    if (loc.lat == null || loc.lng == null) continue;
    best = Math.min(best, milesBetween(origin, loc));
  }
  return best;
}

export function formatMiles(miles) {
  if (!Number.isFinite(miles)) return "";
  if (miles < 0.1) return "< 0.1 mi";
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

export function sortPlaces(places, origin) {
  return places.slice().sort((a, b) => {
    if (origin) {
      const da = closestMiles(a, origin);
      const db = closestMiles(b, origin);
      if (da !== db) return da - db;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function areaOptions(places) {
  const areas = new Set();
  for (const place of places) {
    for (const loc of place.locations || []) {
      if (loc.area) areas.add(loc.area);
    }
  }
  return [...areas].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function normName(name) {
  return name.trim().toLowerCase().replace(/[’‘]/g, "'");
}

export function buildPlaces(restaurantRows, locationRows) {
  const places = [];
  const byName = new Map();

  for (const row of restaurantRows) {
    const name = field(row, "Restaurant");
    if (!name) continue;
    const place = {
      id: `rest:${name}`,
      kind: "restaurant",
      name,
      category: field(row, "Category"),
      offer: field(row, "Offer"),
      offerLabel: field(row, "Free or Discount"),
      service: field(row, "Dine-in/Takeout/Both"),
      dates: field(row, "Date(s) valid"),
      hours: field(row, "Hours/Time limits"),
      proof: field(row, "ID/Proof required"),
      participation: field(row, "Participation"),
      areaSummary: field(row, "Area"),
      listedLocations: field(row, "San Antonio Location(s)"),
      status: field(row, "Status"),
      sourceUrl: safeHttp(field(row, "Source URL")),
      website: safeHttp(field(row, "Website")),
      notes: "",
      locations: [],
    };
    places.push(place);
    byName.set(normName(name), place);
  }

  locationRows.forEach((row, index) => {
    const restaurantName = field(row, "Restaurant");
    if (!restaurantName) return;
    let place = byName.get(normName(restaurantName));
    if (!place) {
      place = {
        id: `rest:${restaurantName}`,
        kind: "restaurant",
        name: restaurantName,
        category: "",
        offer: "",
        offerLabel: "",
        service: "",
        dates: "",
        hours: "",
        proof: "",
        participation: "",
        areaSummary: "",
        listedLocations: "",
        status: "",
        sourceUrl: "",
        website: "",
        notes: "",
        locations: [],
      };
      places.push(place);
      byName.set(normName(restaurantName), place);
    }
    const locName = field(row, "Location Name") || restaurantName;
    const coords = parseCoordPair(field(row, "Location"));
    place.locations.push({
      id: `${place.id}::${index}`,
      name: locName,
      address: field(row, "Street Address"),
      city: field(row, "City"),
      zip: field(row, "ZIP"),
      area: field(row, "Area/Neighborhood"),
      phone: field(row, "Phone"),
      google: field(row, "Google Maps URL"),
      apple: field(row, "Apple Maps URL"),
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null,
      menu: safeHttp(field(row, "Menu URL")),
      callAhead: isCallAhead(locName),
    });
  });

  return places;
}

export function spotToPlace(spot) {
  const lat = spot.lat == null ? null : Number(spot.lat);
  const lng = spot.lng == null ? null : Number(spot.lng);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  return {
    id: spot.id,
    kind: "spot",
    name: spot.name,
    category: "My spot",
    offer: spot.offer || "",
    offerLabel: "",
    service: "",
    dates: "",
    hours: "",
    proof: "",
    participation: "",
    areaSummary: "",
    listedLocations: "",
    status: "",
    sourceUrl: "",
    website: "",
    notes: spot.notes || "",
    spot,
    locations: [
      {
        id: `${spot.id}::0`,
        name: spot.name,
        address: spot.address || "",
        city: "",
        zip: "",
        area: "",
        phone: "",
        google: "",
        apple: "",
        lat: hasCoords ? lat : null,
        lng: hasCoords ? lng : null,
        menu: "",
        callAhead: isCallAhead(spot.name),
      },
    ],
  };
}

export function labelize(key) {
  const known = {
    purpose: "Purpose",
    last_updated: "Last updated",
    "last updated": "Last updated",
    disclaimer: "Disclaimer",
  };
  const normalized = String(key || "").trim().toLowerCase();
  if (known[normalized]) return known[normalized];
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function parseAbout(rows) {
  if (!rows || !rows.length) {
    return [
      { key: "purpose", value: "A directory of Veterans Day meals and community food help in San Antonio, Texas." },
      { key: "last_updated", value: "November 10, 2026" },
      { key: "disclaimer", value: FALLBACK_DISCLAIMER },
    ];
  }
  const keys = Object.keys(rows[0]);
  const lower = keys.map((key) => key.trim().toLowerCase());
  const keyIndex = lower.findIndex((key) => key === "key" || key === "field" || key === "name");
  const valueIndex = lower.findIndex((key) => key === "value" || key === "details" || key === "text");
  if (keyIndex >= 0 && valueIndex >= 0) {
    return rows
      .map((row) => ({
        key: String(row[keys[keyIndex]] || "").trim(),
        value: String(row[keys[valueIndex]] || "").trim(),
      }))
      .filter((entry) => entry.key || entry.value);
  }
  if (rows.length === 1) {
    return keys
      .map((key) => ({ key, value: String(rows[0][key] || "").trim() }))
      .filter((entry) => entry.value);
  }
  return rows.map((row, index) => ({
    key: String(row[keys[0]] || `Item ${index + 1}`).trim(),
    value: keys
      .slice(1)
      .map((key) => String(row[key] || "").trim())
      .filter(Boolean)
      .join(" — "),
  }));
}

export function blankPersonal() {
  return { version: 1, spots: [], favorites: {}, hidden: {}, notes: {} };
}

function cleanId(id) {
  return typeof id === "string" && id.startsWith("spot:") && id.length < 80 ? id : "";
}

function cleanSpot(input) {
  if (!input || typeof input !== "object") return null;
  const name = String(input.name || "").trim().slice(0, 140);
  const address = String(input.address || "").trim().slice(0, 240);
  if (!name || !address) return null;
  let lat = null;
  let lng = null;
  if (input.lat != null && input.lng != null && input.lat !== "" && input.lng !== "") {
    const parsedLat = Number(input.lat);
    const parsedLng = Number(input.lng);
    if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng) && Math.abs(parsedLat) <= 90 && Math.abs(parsedLng) <= 180) {
      lat = parsedLat;
      lng = parsedLng;
    }
  }
  const id = cleanId(input.id) || `spot:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return {
    id,
    name,
    address,
    offer: String(input.offer || "").trim().slice(0, 1000),
    notes: String(input.notes || "").trim().slice(0, 2000),
    lat,
    lng,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString(),
  };
}

function copyFlags(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (value) out[key] = true;
  }
  return out;
}

function copyNotes(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (typeof value !== "string") continue;
    const text = value.trim().slice(0, 2000);
    if (text) out[key] = text;
  }
  return out;
}

export function sanitizePersonal(data, { strict = false } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.spots)) {
    if (strict) throw new Error("This file is not a personal data export.");
    return blankPersonal();
  }
  return {
    version: 1,
    spots: data.spots.slice(0, 200).map(cleanSpot).filter(Boolean),
    favorites: copyFlags(data.favorites),
    hidden: copyFlags(data.hidden),
    notes: copyNotes(data.notes),
  };
}

export function looksLikeTable(rows, header) {
  if (!rows || !rows.length) return false;
  const keys = Object.keys(rows[0]);
  if (!keys.length) return false;
  if (header && !keys.some((key) => key.trim().toLowerCase() === header.toLowerCase())) return false;
  const blob = `${keys.join(" ")} ${rows[0][keys[0]] || ""}`;
  if (keys.length === 1 && /sorry|sign in|error|unauthorized|doctype/i.test(blob)) return false;
  return true;
}
