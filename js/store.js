import { STORAGE_KEY } from "./config.js";
import { blankPersonal, sanitizePersonal } from "./logic.js";

export function loadPersonal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blankPersonal();
    return sanitizePersonal(JSON.parse(raw));
  } catch {
    return blankPersonal();
  }
}

export function savePersonal(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
