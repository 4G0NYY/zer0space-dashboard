'use strict';

// ================================================================
// i18n — German / English UI strings
// ================================================================
//
// Loaded before app.js and before login.js, so window.I18N exists by the time
// any view code runs.
//
// How it works:
//   - Markup carries the key, not the text: data-i18n (textContent),
//     data-i18n-ph (placeholder), data-i18n-title (title), data-i18n-aria
//     (aria-label), data-i18n-alt (alt). applyI18n() walks those attributes and
//     fills them in. The German text stays in the HTML as the visible default
//     until the script runs, so the page is never blank.
//   - Strings built in JavaScript call t('key') directly.
//   - Server-side messages are translated by their stable `code` field
//     (err.* keys). The server's English `error` text is the fallback for any
//     code this dictionary does not know, so a new server error is never shown
//     as a blank or a raw key.
//
// The chosen language lives in localStorage only — it is a per-browser display
// preference, deliberately not a DB column, so switching it needs no round trip
// and no schema change.

const LANG_KEY = 'zs-lang';
const SUPPORTED = ['de', 'en'];
const DEFAULT_LANG = 'de';

const STRINGS = {
  de: {
    // ── Navigation & top bar ──────────────────────────────────────────────
    'nav.home': 'Home',
    'nav.ai': 'KI',
    'nav.cloud': 'Cloud',
    'nav.vault': 'Vault',
    'nav.settings': 'Einstellungen',
    'nav.logout': 'Abmelden',
    'nav.toggleSidebar': 'Seitenleiste ein-/ausklappen',
    'nav.menu': 'Menü',
    'top.search': 'Dienste suchen …',
    'top.language': 'Sprache wechseln',

    // ── Home view ─────────────────────────────────────────────────────────
    'greet.morning': 'Guten Morgen',
    'greet.afternoon': 'Guten Nachmittag',
    'greet.evening': 'Guten Abend',
    'greet.night': 'Gute Nacht',
    'greet.fallbackUser': 'Nutzer',
    'locale': 'de-CH',
    'home.nodesOnline': 'Nodes online',
    'home.swarmServices': 'Swarm-Dienste',
    'home.clusterStatus': 'Cluster-Status',
    'home.backup': 'Backup',
    'home.nodes': 'Nodes',
    'home.services': 'Dienste',
    'home.nodeDetails': 'Klicken für Node-Details',
    'home.checking': 'Prüfen',
    'home.healthy': 'Gesund',
    'svc.editAria': '{name} bearbeiten',
    'svc.removeAria': '{name} entfernen',

    // ── AI / Cloud placeholders ───────────────────────────────────────────
    'ai.title': 'KI-Assistent',
    'ai.subtitle': 'Vorbereitet für einen lokalen Sprachmodell-Chat',
    'ai.inputPlaceholder': 'Nachricht eingeben …',
    'ai.body': 'Hier entsteht ein Chat-Interface für lokale KI-Modelle (Ollama / Open-WebUI).',
    'cloud.title': 'Cloud',
    'cloud.body': 'Cloudflare-Status und Tunnel-Übersicht werden hier erscheinen.',
    'common.comingSoon': 'Kommt bald',

    // ── Vault ─────────────────────────────────────────────────────────────
    'vault.title': 'Vault',
    'vault.subtitle': 'Deine eigenen Zugangsdaten — Ende-zu-Ende nur für dich entschlüsselbar',
    'vault.locked': 'Vault gesperrt',
    'vault.lockedBody': 'Deine Session wurde vor der Vault-Funktion erstellt oder dein Passwort wurde zurückgesetzt. Bitte einmal ab- und wieder anmelden, um sie freizuschalten.',
    'vault.search': 'Titel oder URL suchen …',
    'vault.addEntry': 'Eintrag hinzufügen',
    'vault.editEntry': 'Eintrag bearbeiten',
    'vault.entry': 'Vault-Eintrag',
    'vault.entryTitle': 'Titel *',
    'vault.titlePlaceholder': 'z. B. GitHub',
    'vault.username': 'Benutzername',
    'vault.password': 'Passwort',
    'vault.length': 'Länge',
    'vault.url': 'URL',
    'vault.urlPlaceholder': 'https://example.com',
    'vault.notes': 'Notizen',
    'vault.save': 'Speichern',
    'vault.showPassword': 'Passwort anzeigen',
    'vault.generatePassword': 'Passwort generieren',
    'vault.empty': 'Noch keine Einträge — leg deinen ersten mit „Eintrag hinzufügen" an.',
    'vault.loadFailed': 'Vault konnte nicht geladen werden.',
    'vault.undecryptable': 'Konnte nicht entschlüsselt werden — Passwort wurde per Admin-Reset geändert',
    'vault.titleMissing': 'Titel fehlt',
    'vault.saveFailed': 'Fehler beim Speichern',

    // ── Settings: password ────────────────────────────────────────────────
    'settings.title': 'Einstellungen',
    'settings.changePassword': 'Passwort ändern',
    'settings.currentPassword': 'Aktuelles Passwort',
    'settings.newPassword': 'Neues Passwort',
    'settings.minChars': '(min. 8 Zeichen)',
    'settings.confirmPassword': 'Bestätigen',
    'settings.savePassword': 'Passwort speichern',
    'settings.pwMismatch': 'Passwörter stimmen nicht überein.',
    'settings.pwChanged': 'Passwort erfolgreich geändert.',

    // ── Settings: language ────────────────────────────────────────────────
    'settings.language': 'Sprache',
    'settings.languageHint': 'Gilt nur für diesen Browser.',

    // ── Settings: accent colour ───────────────────────────────────────────
    'settings.accent': 'Akzentfarbe',
    'settings.customColor': 'Eigene Farbe',
    'settings.openColorPicker': 'Farbwähler öffnen',
    'color.blue': 'Blau',
    'color.sky': 'Himmelblau',
    'color.teal': 'Türkis',
    'color.green': 'Grün',
    'color.amber': 'Bernstein',
    'color.red': 'Rot',
    'color.magenta': 'Magenta',
    'color.violet': 'Violett',

    // ── Settings: background ──────────────────────────────────────────────
    'bg.title': 'Hintergrund',
    'bg.generative': 'Generativ',
    'bg.ownImage': 'Eigenes Bild',
    'bg.drop': 'Bild hierher ziehen',
    'bg.or': 'oder',
    'bg.browse': 'Datei auswählen',
    'bg.hint': 'JPG · PNG · WebP · max. 10 MB',
    'bg.preview': 'Hintergrund-Vorschau',
    'bg.remove': 'Bild entfernen',
    'bg.uploadFailed': 'Upload fehlgeschlagen.',
    'bg.saved': 'Hintergrundbild gespeichert.',
    'bg.removed': 'Bild entfernt.',
    'bg.badType': 'Nur JPG, PNG oder WebP.',
    'bg.maxSize': 'Max. 10 MB.',

    // ── Settings: users ───────────────────────────────────────────────────
    'users.title': 'Benutzer',
    'users.new': 'Neuer Benutzer',
    'users.username': 'Benutzername',
    'users.usernamePlaceholder': 'benutzername',
    'users.password': 'Passwort',
    'users.role': 'Rolle',
    'users.roleViewer': 'Viewer — nur lesen',
    'users.roleAdmin': 'Admin — voller Zugriff',
    'users.create': 'Benutzer anlegen',
    'users.created': 'Benutzer „{name}" angelegt.',
    'users.resetPassword': 'Passwort',
    'users.newPasswordPlaceholder': 'Neues Passwort (min. 8 Zeichen)',
    'users.confirmDelete': 'Benutzer wirklich löschen?',
    'users.cannotDeleteSelf': 'Eigenen Account nicht löschbar',
    'users.usernameMissing': 'Benutzername fehlt',
    'users.pwMin8': 'Passwort mind. 8 Zeichen',
    'users.you': '(du)',
    'users.confirmRole': 'Rolle zu „{role}" ändern?',

    // ── Services ──────────────────────────────────────────────────────────
    'svc.add': 'Dienst hinzufügen',
    'svc.edit': 'Dienst bearbeiten',
    'svc.name': 'Name *',
    'svc.namePlaceholder': 'z. B. Portainer',
    'svc.description': 'Beschreibung',
    'svc.descriptionPlaceholder': 'Kurzbeschreibung',
    'svc.url': 'URL',
    'svc.icon': 'Icon',
    'svc.iconHint': '(Tabler-Icons-Name)',
    'svc.iconPlaceholder': 'z. B. brand-docker',
    'svc.submitAdd': 'Hinzufügen',
    'svc.submitSave': 'Speichern',

    // ── Login ─────────────────────────────────────────────────────────────
    'login.subtitle': 'Homelab Dashboard',
    'login.logoAlt': 'May, das zer0space-Maskottchen',
    'login.username': 'Benutzername',
    'login.password': 'Passwort',
    'login.submit': 'Anmelden',
    'login.invalid': 'Ungültige Zugangsdaten',

    // ── Generic ───────────────────────────────────────────────────────────
    'common.close': 'Schließen',
    'common.serverUnreachable': 'Server nicht erreichbar',
    'common.edit': 'Bearbeiten',
    'common.delete': 'Löschen',
    'common.apply': 'Übernehmen',
    'common.cancel': 'Abbrechen',
    'common.confirmRemove': '„{name}" entfernen?',
    'common.confirmDelete': '„{name}" wirklich löschen?',

    // ── Server-side error codes ───────────────────────────────────────────
    'err.STARTING': 'Server startet noch',
    'err.UNAUTHORIZED': 'Nicht angemeldet',
    'err.FORBIDDEN_ADMIN': 'Keine Berechtigung (Admin erforderlich)',
    'err.INPUT_MISSING': 'Eingabe fehlt',
    'err.BAD_CREDENTIALS': 'Benutzername oder Passwort falsch',
    'err.FIELDS_MISSING': 'Felder fehlen',
    'err.PW_TOO_SHORT': 'Passwort muss mindestens 8 Zeichen haben',
    'err.PW_CURRENT_WRONG': 'Aktuelles Passwort falsch',
    'err.THEME_REQUIRED': 'Theme fehlt',
    'err.PROXY_UNAVAILABLE': 'Docker-Proxy nicht erreichbar',
    'err.KEY_VALUE_REQUIRED': 'Key und Value erforderlich',
    'err.INVALID_ID': 'Ungültige ID',
    'err.SERVICE_NOT_FOUND': 'Dienst nicht gefunden',
    'err.BAD_UPLOAD': 'Keine Datei oder ungültiger Typ (JPG/PNG/WebP)',
    'err.STORAGE_ERROR': 'Speicherfehler',
    'err.INVALID_ROLE': 'Ungültige Rolle',
    'err.USERNAME_TAKEN': 'Benutzername bereits vergeben',
    'err.USER_NOT_FOUND': 'Benutzer nicht gefunden',
    'err.LAST_ADMIN_DEMOTE': 'Letzten Admin nicht herabstufbar',
    'err.LAST_ADMIN_DELETE': 'Letzter Admin nicht löschbar',
    'err.SELF_DELETE': 'Eigenen Account nicht löschbar',
    'err.DB_UNAVAILABLE': 'Datenbank nicht erreichbar — bitte später erneut versuchen',
    'err.INTERNAL': 'Interner Fehler',
    'err.CSRF': 'Ungültiges CSRF-Token',
    'err.VAULT_RATE_LIMIT': 'Zu viele Vault-Anfragen — bitte kurz warten.',
    'err.VAULT_LOCKED': 'Vault ist gesperrt — bitte einmal ab- und wieder anmelden, um sie freizuschalten.',
    'err.ENTRY_NOT_FOUND': 'Eintrag nicht gefunden',
  },

  en: {
    // ── Navigation & top bar ──────────────────────────────────────────────
    'nav.home': 'Home',
    'nav.ai': 'AI',
    'nav.cloud': 'Cloud',
    'nav.vault': 'Vault',
    'nav.settings': 'Settings',
    'nav.logout': 'Sign out',
    'nav.toggleSidebar': 'Collapse/expand sidebar',
    'nav.menu': 'Menu',
    'top.search': 'Search services …',
    'top.language': 'Switch language',

    // ── Home view ─────────────────────────────────────────────────────────
    'greet.morning': 'Good morning',
    'greet.afternoon': 'Good afternoon',
    'greet.evening': 'Good evening',
    'greet.night': 'Good night',
    'greet.fallbackUser': 'user',
    'locale': 'en-GB',
    'home.nodesOnline': 'Nodes online',
    'home.swarmServices': 'Swarm services',
    'home.clusterStatus': 'Cluster status',
    'home.backup': 'Backup',
    'home.nodes': 'Nodes',
    'home.services': 'Services',
    'home.nodeDetails': 'Click for node details',
    'home.checking': 'Checking',
    'home.healthy': 'Healthy',
    'svc.editAria': 'Edit {name}',
    'svc.removeAria': 'Remove {name}',

    // ── AI / Cloud placeholders ───────────────────────────────────────────
    'ai.title': 'AI assistant',
    'ai.subtitle': 'Prepared for a local language model chat',
    'ai.inputPlaceholder': 'Type a message …',
    'ai.body': 'A chat interface for local AI models (Ollama / Open-WebUI) will live here.',
    'cloud.title': 'Cloud',
    'cloud.body': 'Cloudflare status and a tunnel overview will appear here.',
    'common.comingSoon': 'Coming soon',

    // ── Vault ─────────────────────────────────────────────────────────────
    'vault.title': 'Vault',
    'vault.subtitle': 'Your own credentials — end-to-end decryptable only by you',
    'vault.locked': 'Vault locked',
    'vault.lockedBody': 'Your session was created before the vault feature existed, or your password was reset. Sign out and back in to unlock it.',
    'vault.search': 'Search title or URL …',
    'vault.addEntry': 'Add entry',
    'vault.editEntry': 'Edit entry',
    'vault.entry': 'Vault entry',
    'vault.entryTitle': 'Title *',
    'vault.titlePlaceholder': 'e.g. GitHub',
    'vault.username': 'Username',
    'vault.password': 'Password',
    'vault.length': 'Length',
    'vault.url': 'URL',
    'vault.urlPlaceholder': 'https://example.com',
    'vault.notes': 'Notes',
    'vault.save': 'Save',
    'vault.showPassword': 'Show password',
    'vault.generatePassword': 'Generate password',
    'vault.empty': 'No entries yet — add your first one with "Add entry".',
    'vault.loadFailed': 'Could not load the vault.',
    'vault.undecryptable': 'Could not be decrypted — the password was changed by an admin reset',
    'vault.titleMissing': 'Title is missing',
    'vault.saveFailed': 'Could not save',

    // ── Settings: password ────────────────────────────────────────────────
    'settings.title': 'Settings',
    'settings.changePassword': 'Change password',
    'settings.currentPassword': 'Current password',
    'settings.newPassword': 'New password',
    'settings.minChars': '(min. 8 characters)',
    'settings.confirmPassword': 'Confirm',
    'settings.savePassword': 'Save password',
    'settings.pwMismatch': 'Passwords do not match.',
    'settings.pwChanged': 'Password changed successfully.',

    // ── Settings: language ────────────────────────────────────────────────
    'settings.language': 'Language',
    'settings.languageHint': 'Applies to this browser only.',

    // ── Settings: accent colour ───────────────────────────────────────────
    'settings.accent': 'Accent colour',
    'settings.customColor': 'Custom colour',
    'settings.openColorPicker': 'Open colour picker',
    'color.blue': 'Blue',
    'color.sky': 'Sky blue',
    'color.teal': 'Teal',
    'color.green': 'Green',
    'color.amber': 'Amber',
    'color.red': 'Red',
    'color.magenta': 'Magenta',
    'color.violet': 'Violet',

    // ── Settings: background ──────────────────────────────────────────────
    'bg.title': 'Background',
    'bg.generative': 'Generative',
    'bg.ownImage': 'Custom image',
    'bg.drop': 'Drag an image here',
    'bg.or': 'or',
    'bg.browse': 'choose a file',
    'bg.hint': 'JPG · PNG · WebP · max. 10 MB',
    'bg.preview': 'Background preview',
    'bg.remove': 'Remove image',
    'bg.uploadFailed': 'Upload failed.',
    'bg.saved': 'Background image saved.',
    'bg.removed': 'Image removed.',
    'bg.badType': 'Only JPG, PNG or WebP.',
    'bg.maxSize': 'Max. 10 MB.',

    // ── Settings: users ───────────────────────────────────────────────────
    'users.title': 'Users',
    'users.new': 'New user',
    'users.username': 'Username',
    'users.usernamePlaceholder': 'username',
    'users.password': 'Password',
    'users.role': 'Role',
    'users.roleViewer': 'Viewer — read only',
    'users.roleAdmin': 'Admin — full access',
    'users.create': 'Create user',
    'users.created': 'User "{name}" created.',
    'users.resetPassword': 'Password',
    'users.newPasswordPlaceholder': 'New password (min. 8 characters)',
    'users.confirmDelete': 'Really delete this user?',
    'users.cannotDeleteSelf': 'You cannot delete your own account',
    'users.usernameMissing': 'Username is missing',
    'users.pwMin8': 'Password must be at least 8 characters',
    'users.you': '(you)',
    'users.confirmRole': 'Change role to "{role}"?',

    // ── Services ──────────────────────────────────────────────────────────
    'svc.add': 'Add service',
    'svc.edit': 'Edit service',
    'svc.name': 'Name *',
    'svc.namePlaceholder': 'e.g. Portainer',
    'svc.description': 'Description',
    'svc.descriptionPlaceholder': 'Short description',
    'svc.url': 'URL',
    'svc.icon': 'Icon',
    'svc.iconHint': '(Tabler Icons name)',
    'svc.iconPlaceholder': 'e.g. brand-docker',
    'svc.submitAdd': 'Add',
    'svc.submitSave': 'Save',

    // ── Login ─────────────────────────────────────────────────────────────
    'login.subtitle': 'Homelab Dashboard',
    'login.logoAlt': 'May, the zer0space mascot',
    'login.username': 'Username',
    'login.password': 'Password',
    'login.submit': 'Sign in',
    'login.invalid': 'Invalid credentials',

    // ── Generic ───────────────────────────────────────────────────────────
    'common.close': 'Close',
    'common.serverUnreachable': 'Server unreachable',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'common.apply': 'Apply',
    'common.cancel': 'Cancel',
    'common.confirmRemove': 'Remove "{name}"?',
    'common.confirmDelete': 'Really delete "{name}"?',

    // ── Server-side error codes ───────────────────────────────────────────
    'err.STARTING': 'Server is still starting',
    'err.UNAUTHORIZED': 'Not signed in',
    'err.FORBIDDEN_ADMIN': 'Not permitted (admin required)',
    'err.INPUT_MISSING': 'Input missing',
    'err.BAD_CREDENTIALS': 'Wrong username or password',
    'err.FIELDS_MISSING': 'Fields missing',
    'err.PW_TOO_SHORT': 'Password must be at least 8 characters',
    'err.PW_CURRENT_WRONG': 'Current password is wrong',
    'err.THEME_REQUIRED': 'Theme required',
    'err.PROXY_UNAVAILABLE': 'Docker proxy unavailable',
    'err.KEY_VALUE_REQUIRED': 'Key and value required',
    'err.INVALID_ID': 'Invalid id',
    'err.SERVICE_NOT_FOUND': 'Service not found',
    'err.BAD_UPLOAD': 'No file or invalid type (JPG/PNG/WebP)',
    'err.STORAGE_ERROR': 'Storage error',
    'err.INVALID_ROLE': 'Invalid role',
    'err.USERNAME_TAKEN': 'Username already taken',
    'err.USER_NOT_FOUND': 'User not found',
    'err.LAST_ADMIN_DEMOTE': 'The last admin cannot be demoted',
    'err.LAST_ADMIN_DELETE': 'The last admin cannot be deleted',
    'err.SELF_DELETE': 'You cannot delete your own account',
    'err.DB_UNAVAILABLE': 'Database unavailable — please try again later',
    'err.INTERNAL': 'Internal error',
    'err.CSRF': 'Invalid CSRF token',
    'err.VAULT_RATE_LIMIT': 'Too many vault requests — please wait a moment.',
    'err.VAULT_LOCKED': 'The vault is locked — sign out and back in to unlock it.',
    'err.ENTRY_NOT_FOUND': 'Entry not found',
  },
};

function normalize(lang) {
  if (!lang) return null;
  const short = String(lang).toLowerCase().slice(0, 2);
  return SUPPORTED.includes(short) ? short : null;
}

let current =
  normalize(localStorage.getItem(LANG_KEY)) ||
  normalize(navigator.language) ||
  DEFAULT_LANG;

function getLang() {
  return current;
}

// Returns the string for `key` in the active language. Falls back to German and
// then to the key itself, so a missing translation degrades to readable text
// rather than an empty element.
// `vars` fills {placeholders}: t('users.created', { name: 'bob' })
function t(key, vars) {
  let s = STRINGS[current][key];
  if (s === undefined) s = STRINGS[DEFAULT_LANG][key];
  if (s === undefined) return key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(v);
  }
  return s;
}

// Translates a failed API response. Prefers the stable `code` the server sends;
// falls back to the server's own English `error` text for codes this dictionary
// does not know yet.
function tError(data, fallbackKey) {
  if (data && data.code) {
    const key = 'err.' + data.code;
    const translated = STRINGS[current][key] || STRINGS[DEFAULT_LANG][key];
    if (translated) return translated;
  }
  if (data && data.error) return data.error;
  return t(fallbackKey || 'err.INTERNAL');
}

// Walks the document and fills in every element that carries a data-i18n*
// attribute. Safe to call repeatedly — it is how a language switch re-renders.
function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  scope.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.setAttribute('placeholder', t(el.dataset.i18nPh));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  });
  scope.querySelectorAll('[data-i18n-aria]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  scope.querySelectorAll('[data-i18n-alt]').forEach(el => {
    el.setAttribute('alt', t(el.dataset.i18nAlt));
  });
  document.documentElement.lang = current;
  syncToggles(scope);
}

// Marks the active option in every language toggle on the page.
function syncToggles(root) {
  (root || document).querySelectorAll('[data-lang]').forEach(el => {
    el.classList.toggle('active', el.dataset.lang === current);
    el.setAttribute('aria-pressed', String(el.dataset.lang === current));
  });
}

function setLang(lang) {
  const next = normalize(lang);
  if (!next || next === current) return;
  current = next;
  localStorage.setItem(LANG_KEY, next);
  applyI18n();
  // Views that build their markup in JavaScript (service tiles, user rows,
  // vault entries, metrics) are not covered by data-i18n and must re-render.
  window.dispatchEvent(new CustomEvent('languagechange:zs'));
}

// Wires every [data-lang] button on the page. Called on DOMContentLoaded and
// safe to call again after markup is injected.
function initLangToggles(root) {
  (root || document).querySelectorAll('[data-lang]').forEach(el => {
    if (el.dataset.langBound) return;
    el.dataset.langBound = '1';
    el.addEventListener('click', () => setLang(el.dataset.lang));
  });
  syncToggles(root);
}

window.I18N = { t, tError, applyI18n, setLang, getLang, initLangToggles, SUPPORTED };
window.t = t; // convenience shorthand used throughout app.js

document.addEventListener('DOMContentLoaded', () => {
  applyI18n();
  initLangToggles();
});
