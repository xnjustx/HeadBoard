/**
 * js/api.js — Module de communication avec l'API REST de Headscale.
 *
 * Responsabilités :
 *   - Persistance de la configuration (localStorage).
 *   - Construction des URLs (base + chemin + query + proxy CORS).
 *   - Wrapper générique fetch() avec gestion d'erreurs.
 *   - Méthodes typées couvrant l'intégralité des endpoints documentés.
 *
 * L'objet exporté (`Headscale`) est utilisé par app.js / acl-builder.js.
 */

const CONFIG_KEY = 'headscaleui.config.v1';

/* ---------------------------------------------------------------------- */
/*  Configuration (localStorage)                                          */
/* ---------------------------------------------------------------------- */

const DEFAULT_CONFIG = {
  baseUrl: '',          // ex : https://headscale.example.com
  apiKey: '',           // Bearer token
  corsProxyEnabled: false,
  corsProxyUrl: '',     // préfixe concaténé, ex : https://corsproxy.io/?
};

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (err) {
    console.warn('[api] configuration invalide, réinitialisation.', err);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(next) {
  const merged = { ...loadConfig(), ...next };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
  } catch (err) {
    console.warn('[api] impossible d\'écrire la configuration.', err);
  }
  return merged;
}

function getConfig() {
  return loadConfig();
}

/* ---------------------------------------------------------------------- */
/*  Utilitaires                                                           */
/* ---------------------------------------------------------------------- */

function normalizeBaseUrl(url) {
  let u = (url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

/** Construit l'URL finale en tenant compte du proxy CORS. */
function buildUrl(path, query) {
  const base = normalizeBaseUrl(getConfig().baseUrl);
  if (!base) {
    throw new ApiError('URL du serveur Headscale non configurée. Ouvrez les paramètres.', 0, 'NO_BASE_URL');
  }

  let url = base + '/api/v1' + path;

  if (query && typeof query === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += '?' + qs;
  }

  const cfg = getConfig();
  if (cfg.corsProxyEnabled && cfg.corsProxyUrl) {
    const proxy = cfg.corsProxyUrl.trim().replace(/\/+$/, '');
    url = proxy + encodeURIComponent(url);
  }

  return url;
}

/** Erreur structurée portant le code/status HTTP et le message de l'API. */
export class ApiError extends Error {
  constructor(message, status = 0, code = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/* ---------------------------------------------------------------------- */
/*  Requête générique                                                     */
/* ---------------------------------------------------------------------- */

async function request(method, path, { body, query } = {}) {
  const url = buildUrl(path, query);

  const headers = { 'Content-Type': 'application/json' };
  const apiKey = getConfig().apiKey;
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  const options = { method, headers };
  if (body !== undefined && body !== null) {
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    throw new ApiError(`Erreur réseau — impossible de joindre le serveur (${err.message}).`, 0);
  }

  // Le corps peut être vide (DELETE, expire…) : on tolère l'absence de JSON.
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const obj = data && typeof data === 'object' ? data : null;
    const message = obj
      ? (obj.message || obj.error || res.statusText)
      : (typeof data === 'string' && data ? data : res.statusText);
    throw new ApiError(message, res.status, obj ? obj.code : undefined);
  }

  return data;
}

/* Petites aides HTTP */
const GET = (path, query) => request('GET', path, { query });
const POST = (path, body, query) => request('POST', path, { body, query });
const PUT = (path, body) => request('PUT', path, { body });
const DEL = (path, query) => request('DELETE', path, { query });

/* ---------------------------------------------------------------------- */
/*  API publique (regroupée par domaine)                                  */
/* ---------------------------------------------------------------------- */

export const Headscale = {
  config: {
    get: getConfig,
    save: saveConfig,
    normalizeBaseUrl,
  },

  /* --- Santé --- */
  health: {
    check: () => GET('/health'),
  },

  /* --- Nœuds --- */
  nodes: {
    list: (user) => GET('/node', user ? { user } : undefined),
    get: (nodeId) => GET(`/node/${nodeId}`),
    remove: (nodeId) => DEL(`/node/${nodeId}`),
    register: (user, key) => POST('/node/register', undefined, { user, key }),
    backfillIps: (confirmed) => POST('/node/backfillips', undefined, { confirmed }),
    rename: (nodeId, newName) => POST(`/node/${nodeId}/rename/${encodeURIComponent(newName)}`),
    expire: (nodeId, opts = {}) => {
      const query = {};
      if (opts.expiry) query.expiry = opts.expiry;
      if (opts.disableExpiry !== undefined) query.disableExpiry = opts.disableExpiry;
      return POST(`/node/${nodeId}/expire`, undefined, query);
    },
    approveRoutes: (nodeId, routes) => POST(`/node/${nodeId}/approve_routes`, { routes }),
    setTags: (nodeId, tags) => POST(`/node/${nodeId}/tags`, { tags }),
  },

  /* --- Utilisateurs --- */
  users: {
    list: (query) => GET('/user', query),
    create: (body) => POST('/user', body),
    remove: (id) => DEL(`/user/${id}`),
    rename: (oldId, newName) => POST(`/user/${oldId}/rename/${encodeURIComponent(newName)}`),
  },

  /* --- Clés de pré-authentification --- */
  preauthkeys: {
    list: () => GET('/preauthkey'),
    create: (body) => POST('/preauthkey', body),
    expire: (id) => POST('/preauthkey/expire', { id: String(id) }),
    remove: (id) => DEL('/preauthkey', { id: String(id) }),
  },

  /* --- Clés API --- */
  apikeys: {
    list: () => GET('/apikey'),
    create: (expiration) => POST('/apikey', expiration ? { expiration } : {}),
    expire: (prefix, id) => POST('/apikey/expire', { prefix, id: String(id) }),
    remove: (prefix, id) => DEL(`/apikey/${prefix}`, id !== undefined ? { id: String(id) } : undefined),
  },

  /* --- Politique (ACL) --- */
  policy: {
    get: () => GET('/policy'),
    set: (policy) => PUT('/policy', { policy }),
    check: (policy) => POST('/policy/check', { policy }),
  },

  /* --- Authentification (enregistrement des nœuds) --- */
  auth: {
    register: (user, authId) => POST('/auth/register', { user, authId }),
    approve: (authId) => POST('/auth/approve', { authId }),
    reject: (authId) => POST('/auth/reject', { authId }),
  },

  /* --- Debug --- */
  debug: {
    createNode: (body) => POST('/debug/node', body),
  },
};

export default Headscale;
