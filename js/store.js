import { STORAGE_KEY } from "./config.js?v=20261111";
import { blankPersonal, sanitizePersonal } from "./logic.js?v=20261111";

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
