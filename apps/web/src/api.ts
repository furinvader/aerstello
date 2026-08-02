import type { Language } from '@sky-bar/shared';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

const localizedErrors: Partial<Record<string, Record<Language, string>>> = {
  INVALID_CREDENTIALS: { de: 'E-Mail oder Passwort ist ungültig.', it: 'E-mail o password non validi.', en: 'Email or password is invalid.' },
  VALIDATION_ERROR: { de: 'Bitte die Eingaben prüfen.', it: 'Controlla i dati inseriti.', en: 'Please check the entered information.' },
  INVALID_PASSWORD: { de: 'Das aktuelle Passwort ist falsch.', it: 'La password attuale non è corretta.', en: 'The current password is incorrect.' },
  ROOM_NOT_FOUND: { de: 'Das Zimmer ist nicht mehr verfügbar.', it: 'La camera non è più disponibile.', en: 'The room is no longer available.' },
  ROOM_HAS_GUESTS: { de: 'Bitte zuerst alle aktiven Gäste in ein anderes Zimmer verschieben oder archivieren.', it: 'Sposta prima tutti gli ospiti attivi in un’altra camera o archiviali.', en: 'Move all active guests to another room or archive them first.' },
  ROOM_HAS_REQUESTS: { de: 'Bitte zuerst alle ausstehenden Zugangsanfragen für dieses Zimmer bearbeiten.', it: 'Gestisci prima tutte le richieste di accesso in sospeso per questa camera.', en: 'Resolve all pending access requests for this room first.' },
  ROOM_CHANGED: { de: 'Das Zimmer wurde zwischenzeitlich geändert. Bitte die Liste neu laden.', it: 'La camera è stata modificata nel frattempo. Ricarica l’elenco.', en: 'The room changed in the meantime. Reload the list.' },
  GUEST_NOT_FOUND: { de: 'Der Gast ist nicht mehr verfügbar.', it: 'L’ospite non è più disponibile.', en: 'The guest is no longer available.' },
  GUEST_HAS_ORDERS: { de: 'Bitte zuerst die offene Bestellung dieses Gasts abschließen.', it: 'Chiudi prima l’ordine aperto di questo ospite.', en: 'Settle this guest’s open order first.' },
  GUEST_CHANGED: { de: 'Der Gast wurde zwischenzeitlich geändert. Bitte die Liste neu laden.', it: 'L’ospite è stato modificato nel frattempo. Ricarica l’elenco.', en: 'The guest changed in the meantime. Reload the list.' },
  CATALOG_CONFLICT: { de: 'Der Produktkatalog hat sich geändert. Bitte die Bestellung prüfen.', it: 'Il catalogo è cambiato. Controlla l’ordine.', en: 'The product catalog changed. Please review the order.' },
  TAB_TOTAL_LIMIT: { de: 'Der offene Betrag hat die zulässige Höchstgrenze erreicht.', it: 'Il conto aperto ha raggiunto il limite massimo.', en: 'The open tab has reached its maximum total.' },
  UNDO_PENDING: { de: 'Bitte warten, bis die Rückgängig-Frist des Gasts abgelaufen ist.', it: 'Attendi la fine del periodo di annullamento dell’ospite.', en: 'Wait for the guest undo window to finish.' },
  TAB_NOT_OPEN: { de: 'Diese Bestellung wurde bereits abgeschlossen.', it: 'Questo ordine è già stato chiuso.', en: 'This tab has already been closed.' },
  TAB_CHANGED: { de: 'Die Bestellung hat sich geändert. Bitte Artikel und Gesamtbetrag erneut prüfen.', it: 'L’ordine è cambiato. Controlla di nuovo gli articoli e il totale.', en: 'The order changed. Review the items and total again.' },
  EMPTY_TAB: { de: 'Es sind keine offenen Artikel abzurechnen.', it: 'Non ci sono articoli aperti da incassare.', en: 'There are no open items to settle.' },
  VENUE_REQUIRED: { de: 'Bitte zuerst den Namen des Betriebs festlegen.', it: 'Imposta prima il nome del locale.', en: 'Set the venue name before billing.' },
  BILL_NOT_ACTIVE: { de: 'Diese Rechnung wurde bereits storniert.', it: 'Questo conto è già stato annullato.', en: 'This bill has already been voided.' },
  REQUEST_RESOLVED: { de: 'Diese Anfrage wurde bereits bearbeitet.', it: 'Questa richiesta è già stata elaborata.', en: 'This request has already been handled.' },
  PRODUCT_NOT_AVAILABLE: { de: 'Dieses Produkt ist nicht mehr verfügbar.', it: 'Questo prodotto non è più disponibile.', en: 'This product is no longer available.' },
  PRODUCT_CHANGED: { de: 'Das Produkt wurde zwischenzeitlich geändert. Bitte den Katalog neu laden.', it: 'Il prodotto è stato modificato nel frattempo. Ricarica il catalogo.', en: 'The product changed in the meantime. Reload the catalog.' },
  VENUE_CHANGED: { de: 'Die Betriebseinstellungen wurden zwischenzeitlich geändert. Bitte die Seite neu laden.', it: 'Le impostazioni del locale sono state modificate nel frattempo. Ricarica la pagina.', en: 'The venue settings changed in the meantime. Reload the page.' },
  UNDO_EXPIRED: { de: 'Die Rückgängig-Frist ist abgelaufen.', it: 'Il periodo di annullamento è scaduto.', en: 'The undo window has expired.' },
};

export function apiErrorCodeMessage(code: string | undefined, language: Language, fallback: string): string {
  return code ? localizedErrors[code]?.[language] ?? fallback : fallback;
}

export function apiErrorMessage(error: unknown, language: Language, fallback: string): string {
  return error instanceof ApiError ? apiErrorCodeMessage(error.code, language, fallback) : fallback;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('x-skybar-csrf', '1');
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: 'include' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: { code: 'NETWORK_ERROR', message: response.statusText } })) as { error: { code: string; message: string } };
    throw new ApiError(payload.error.code, payload.error.message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const json = (value: unknown) => JSON.stringify(value);
