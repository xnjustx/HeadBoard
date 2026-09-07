/**
 * js/app.js — Point d'entrée de l'application Headscale UI.
 *
 * Rôles :
 *   - Gestion de l'état global (caches des données de l'API).
 *   - Rendu des différentes vues (nœuds, utilisateurs, clés, routes, ACL…).
 *   - Liaison des événements (navigation, modales, actions).
 *   - Orchestration avec api.js (réseau) et acl-builder.js (ACL).
 *
 * Tout s'exécute côté client (browser-only). Aucun framework, aucun build.
 */

import Headscale, { ApiError } from './api.js';
import * as ACL from './acl-builder.js';

/* ====================================================================== */
/*  État global                                                           */
/* ====================================================================== */

const state = {
  nodes: [],
  users: [],
  preauthkeys: [],
  apikeys: [],
  aclState: ACL.createEmptyState(),
  policyUpdatedAt: null,
  activeAclTab: 'visual',
  nodeSort: { key: 'name', dir: 'asc' },
};

// Contexte temporaire du modal d'édition de règle ACL.
const ruleModal = { editingIndex: null, src: [], dst: [] };

// Résolveurs des modales "prompt" / "confirm" génériques.
let promptResolve = null;
let confirmResolve = null;
let aclEntityResolve = null;

/* ====================================================================== */
/*  Utilitaires génériques                                                */
/* ====================================================================== */

/** Échappe le HTML (prévention XSS sur les données distantes). */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('fr-FR', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 0) return fmtDate(iso);
  if (s < 60) return "à l'instant";
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const days = Math.floor(h / 24);
  if (days < 30) return `il y a ${days} j`;
  return fmtDate(iso);
}

function toDateTimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromDateTimeLocal(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

/** Notification "toast". */
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = type === 'success' ? 'check-circle-2' : type === 'error' ? 'alert-triangle' : 'info';
  el.innerHTML = `<i data-lucide="${icon}"></i><span>${esc(message)}</span>`;
  container.appendChild(el);
  if (window.lucide) lucide.createIcons();
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 220);
  }, 4200);
}

/** Ré-exécute Lucide pour les icônes injectées dynamiquement. */
function refreshIcons() {
  if (window.lucide) lucide.createIcons();
}

/* ====================================================================== */
/*  Gestion des erreurs & statut de connexion                             */
/* ====================================================================== */

function setStatus(kind) {
  const map = {
    ok:       { cls: 'dot-success', text: 'Connecté' },
    error:    { cls: 'dot-danger',  text: 'Erreur / Déconnecté' },
    none:     { cls: 'dot-warning', text: 'Non configuré' },
    checking: { cls: 'dot-warning', text: 'Connexion…' },
  };
  const m = map[kind] || map.none;
  for (const id of ['sidebar-status-dot', 'header-status-dot']) {
    const el = document.getElementById(id);
    if (el) el.className = 'dot ' + m.cls;
  }
  const st = document.getElementById('sidebar-status-text');
  const ht = document.getElementById('header-status-text');
  if (st) st.textContent = m.text;
  if (ht) ht.textContent = m.text;
  const url = document.getElementById('sidebar-server-url');
  if (url) url.textContent = Headscale.config.normalizeBaseUrl(Headscale.config.get().baseUrl) || '—';
}

async function refreshStatus() {
  const cfg = Headscale.config.get();
  if (!cfg.baseUrl) { setStatus('none'); return; }
  setStatus('checking');
  try {
    await Headscale.health.check();
    setStatus('ok');
  } catch {
    setStatus('error');
  }
}

/** Gère une erreur : notification + ouverture des paramètres si non configuré. */
function handleError(err, context) {
  const msg = err instanceof ApiError ? err.message : (err.message || String(err));
  toast((context ? context + ' : ' : '') + msg, 'error');
  const cfg = Headscale.config.get();
  if (err instanceof ApiError && (err.code === 'NO_BASE_URL' || !cfg.baseUrl)) {
    openModal('modal-settings');
  }
  setStatus('error');
}

/** Wrapper try/catch renvoyant null en cas d'erreur. */
async function safe(fn, context) {
  try { return await fn(); }
  catch (err) { handleError(err, context); return null; }
}

/* ====================================================================== */
/*  Modales génériques                                                    */
/* ====================================================================== */

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

/** Modale de saisie libre (équivalent prompt). Résout null si annulé. */
function showPrompt({ title, label, hint = '', value = '' }) {
  return new Promise((resolve) => {
    promptResolve = resolve;
    document.getElementById('prompt-title').textContent = title;
    document.getElementById('prompt-label').textContent = label;
    document.getElementById('prompt-hint').textContent = hint;
    const input = document.getElementById('prompt-input');
    input.value = value;
    openModal('modal-prompt');
    setTimeout(() => input.focus(), 50);
  });
}

/** Modale de confirmation. Résout un booléen. */
function showConfirm({ title = 'Confirmer', message = 'Êtes-vous sûr ?' }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    openModal('modal-confirm');
  });
}

/** Affiche un objet JSON brut dans une modale éphémère. */
function showJson(title, obj) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal" style="max-width:640px">
      <div class="modal-header"><h3>${esc(title)}</h3><button class="btn btn-icon" data-close><i data-lucide="x"></i></button></div>
      <div class="modal-body"><pre class="code-editor" style="min-height:auto">${esc(JSON.stringify(obj, null, 2))}</pre></div>
    </div>`;
  document.body.appendChild(overlay);
  refreshIcons();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) overlay.remove();
  });
}

/**
 * Modale de formulaire multi-champs pour l'édition d'une entité ACL.
 * @param {object} opts { title, fields: Array<{key, label, value?, hint?, placeholder?}> }
 * @returns {Promise<object|null>} objet { key: value }, ou null si annulé.
 */
function showAclEntityForm({ title, fields }) {
  return new Promise((resolve) => {
    aclEntityResolve = resolve;
    document.getElementById('acl-entity-title').textContent = title;
    document.getElementById('acl-entity-fields').innerHTML = fields.map((f) => `
      <div>
        <label class="field-label">${esc(f.label)}</label>
        <input class="input" data-field="${esc(f.key)}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" />
        ${f.hint ? `<div class="field-hint">${esc(f.hint)}</div>` : ''}
      </div>`).join('');
    openModal('modal-acl-entity');
    const first = document.querySelector('#acl-entity-fields input');
    if (first) setTimeout(() => first.focus(), 50);
  });
}

/* ====================================================================== */
/*  Navigation                                                            */
/* ====================================================================== */

const VIEWS = {
  overview:   { title: "Vue d'ensemble",         load: loadOverview },
  nodes:      { title: 'Nœuds',                   load: () => loadNodes() },
  users:      { title: 'Utilisateurs',            load: () => loadUsers() },
  preauthkeys: { title: 'Clés Pre-Auth',          load: () => loadPreAuthKeys() },
  routes:     { title: 'Routes & Exit Nodes',     load: () => loadRoutes() },
  apikeys:    { title: 'Clés API',                load: () => loadApiKeys() },
  acl:        { title: 'Politique ACL',           load: () => loadPolicy() },
};

/* ====================================================================== */
/*  Persistance de la navigation (onglet actif gardé au rechargement)     */
/* ====================================================================== */

const LS_VIEW = 'headboard.view';
const LS_ACL_TAB = 'headboard.acltab';

/** Reflète la vue courante dans l'URL (#nodes, #acl…) sans entrée d'historique. */
function setUrlHash(value) {
  try { if ((location.hash || '').slice(1) !== value) history.replaceState(null, '', '#' + value); } catch (_) { /* no-op */ }
}

function persistView(name) {
  if (!VIEWS[name]) return;
  try { localStorage.setItem(LS_VIEW, name); } catch (_) { /* stockage indisponible */ }
  setUrlHash(name);
}

/** Vue à afficher au démarrage : hash d'abord, puis sauvegarde, sinon l'aperçu. */
function initialView() {
  const fromHash = (location.hash || '').replace(/^#/, '');
  if (VIEWS[fromHash]) return fromHash;
  try {
    const saved = localStorage.getItem(LS_VIEW);
    if (saved && VIEWS[saved]) return saved;
  } catch (_) { /* stockage indisponible */ }
  return 'overview';
}

async function switchView(name) {
  state.view = VIEWS[name] ? name : 'overview';
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === state.view);
  });
  document.querySelectorAll('.view').forEach((s) => s.classList.add('hidden'));
  const section = document.getElementById('view-' + state.view);
  if (section) section.classList.remove('hidden');
  document.getElementById('page-title').textContent = VIEWS[state.view]?.title || state.view;
  // Referme la sidebar sur mobile après sélection.
  document.getElementById('sidebar')?.classList.remove('open');
  if (VIEWS[state.view]) await VIEWS[state.view].load();
  persistView(state.view);
  // Restaure le sous-onglet ACL (constructeur visuel / code JSON) si besoin.
  if (state.view === 'acl') applyStoredAclTab();
}

/** Restaure le sous-onglet ACL mémorisé après le chargement de la politique. */
function applyStoredAclTab() {
  let tab = null;
  try { tab = localStorage.getItem(LS_ACL_TAB); } catch (_) { /* no-op */ }
  if (tab === 'json' && state.activeAclTab !== 'json') switchAclTab('json');
}

/* ====================================================================== */
/*  Chargeurs de données + rendus                                         */
/* ====================================================================== */

function updateNavCounts() {
  setText('nav-count-nodes', state.nodes.length);
  setText('nav-count-users', state.users.length);
  setText('nav-count-keys', state.preauthkeys.length);
}
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

async function loadNodes() {
  const res = await safe(() => Headscale.nodes.list());
  if (res) {
    state.nodes = res.nodes || [];
    updateNavCounts();
    renderNodes();
    setStatus('ok');
  }
}

/** Un nœud est « expiré » lorsque sa date d'expiration est passée. */
function isExpired(n) {
  if (!n.expiry) return false;
  const t = new Date(n.expiry).getTime();
  return !isNaN(t) && t <= Date.now();
}

/** Rang de statut pour le tri (expiré < en ligne < hors ligne). */
function nodeStatusRank(n) {
  if (isExpired(n)) return 0;
  return n.online ? 1 : 2;
}

/** Valeur textuelle de tri pour une clé donnée. */
function nodeSortText(n, key) {
  switch (key) {
    case 'name': return (n.givenName || n.name || '').toLowerCase();
    case 'user': return (n.user?.name || '').toLowerCase();
    default:     return '';
  }
}

/** Clé comparable pour une adresse IP (tri numérique sur les octets IPv4). */
function ipSortKey(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length === 4) return parts.map((p) => String(parseInt(p, 10) || 0).padStart(3, '0')).join('.');
  return String(ip || '');
}

/** Trie une liste de nœuds selon la clé et la direction données. */
function sortNodes(nodes, key, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return [...nodes].sort((a, b) => {
    let cmp;
    if (key === 'lastSeen') {
      const va = a.lastSeen ? new Date(a.lastSeen).getTime() : -Infinity;
      const vb = b.lastSeen ? new Date(b.lastSeen).getTime() : -Infinity;
      cmp = va < vb ? -1 : va > vb ? 1 : 0;
    } else if (key === 'ip') {
      cmp = ipSortKey((a.ipAddresses || [])[0]).localeCompare(ipSortKey((b.ipAddresses || [])[0]));
    } else if (key === 'status') {
      cmp = nodeStatusRank(a) - nodeStatusRank(b);
    } else {
      const va = nodeSortText(a, key);
      const vb = nodeSortText(b, key);
      cmp = va < vb ? -1 : va > vb ? 1 : 0;
    }
    return cmp * sign;
  });
}

/** Met à jour les indicateurs visuels (↑/↓) des en-têtes triables. */
function updateNodeSortUi() {
  document.querySelectorAll('[data-node-sort]').forEach((th) => {
    const key = th.getAttribute('data-node-sort');
    th.classList.toggle('sorted-asc', state.nodeSort.key === key && state.nodeSort.dir === 'asc');
    th.classList.toggle('sorted-desc', state.nodeSort.key === key && state.nodeSort.dir === 'desc');
  });
}

function renderNodes() {
  const tbody = document.getElementById('nodes-table-body');
  if (!tbody) return;
  const f = (document.getElementById('nodes-filter').value || '').trim().toLowerCase();
  let nodes = state.nodes.filter((n) => {
    if (!f) return true;
    const hay = [n.name, n.givenName, n.user?.name, (n.ipAddresses || []).join(' '), (n.tags || []).join(' ')]
      .join(' ').toLowerCase();
    return hay.includes(f);
  });
  nodes = sortNodes(nodes, state.nodeSort.key, state.nodeSort.dir);
  updateNodeSortUi();

  if (!nodes.length) {
    tbody.innerHTML = emptyRow(7, state.nodes.length ? 'Aucun nœud ne correspond au filtre.' : 'Aucun nœud pour le moment.');
    return;
  }
  tbody.innerHTML = nodes.map(nodeRow).join('');
  refreshIcons();
}

function nodeRow(n) {
  const ips = (n.ipAddresses || []).map((ip) => `<div class="mono text-[12px] text-zinc-400">${esc(ip)}</div>`).join('')
    || '<span class="text-zinc-600">—</span>';
  const tags = (n.tags || []).map((t) => `<span class="badge badge-cyan">${esc(t)}</span>`).join(' ')
    || '<span class="text-zinc-600">—</span>';
  const status = isExpired(n)
    ? '<span class="badge badge-danger"><span class="dot dot-danger"></span>Expiré</span>'
    : n.online
      ? '<span class="badge badge-success"><span class="dot dot-success"></span>En ligne</span>'
      : '<span class="badge badge-muted"><span class="dot dot-warning"></span>Hors ligne</span>';
  const id = String(n.id);

  return `
    <tr>
      <td>
        <div class="font-medium">${esc(n.givenName || n.name || id)}</div>
        ${n.name && n.name !== n.givenName ? `<div class="text-[11px] text-zinc-500">${esc(n.name)}</div>` : ''}
      </td>
      <td class="text-zinc-300">${esc(n.user?.name || '—')}</td>
      <td>${ips}</td>
      <td>${status}</td>
      <td class="text-zinc-400" title="${esc(fmtDate(n.lastSeen))}">${esc(timeAgo(n.lastSeen))}</td>
      <td>${tags}</td>
      <td class="text-right">
        <div class="dropdown">
          <button class="btn btn-icon btn-sm" data-toggle-menu="node-${id}"><i data-lucide="more-horizontal"></i></button>
          <div class="dropdown-menu" id="menu-node-${id}">
            <button class="dropdown-item" data-node-act="detail" data-id="${id}"><i data-lucide="eye"></i> Détails</button>
            <button class="dropdown-item" data-node-act="rename" data-id="${id}"><i data-lucide="pencil"></i> Renommer</button>
            <button class="dropdown-item" data-node-act="expire" data-id="${id}"><i data-lucide="clock"></i> Expirer</button>
            <button class="dropdown-item" data-node-act="routes" data-id="${id}"><i data-lucide="route"></i> Approuver routes</button>
            <button class="dropdown-item" data-node-act="tags" data-id="${id}"><i data-lucide="tags"></i> Définir tags</button>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item danger" data-node-act="delete" data-id="${id}"><i data-lucide="trash-2"></i> Supprimer</button>
          </div>
        </div>
      </td>
    </tr>`;
}

function emptyRow(colspan, message) {
  return `<tr><td colspan="${colspan}"><div class="empty-state" style="padding:24px"><i data-lucide="inbox"></i><p class="empty-title">${esc(message)}</p></div></td></tr>`;
}

async function loadUsers() {
  const res = await safe(() => Headscale.users.list());
  if (res) {
    state.users = res.users || [];
    updateNavCounts();
    renderUsers();
  }
}

function renderUsers() {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;
  if (!state.users.length) {
    tbody.innerHTML = emptyRow(6, 'Aucun utilisateur.');
    refreshIcons();
    return;
  }
  tbody.innerHTML = state.users.map((u) => {
    const nodeCount = state.nodes.filter((n) => String(n.user?.id) === String(u.id)).length;
    const id = String(u.id);
    return `
      <tr>
        <td>
          <div class="font-medium">${esc(u.name)}</div>
          ${u.displayName ? `<div class="text-[11px] text-zinc-500">${esc(u.displayName)}</div>` : ''}
        </td>
        <td class="text-zinc-300">${esc(u.email || '—')}</td>
        <td class="text-zinc-400">${esc(u.provider || 'local')}</td>
        <td class="text-zinc-400">${esc(fmtDate(u.createdAt))}</td>
        <td><span class="badge badge-muted">${nodeCount}</span></td>
        <td class="text-right">
          <div class="dropdown">
            <button class="btn btn-icon btn-sm" data-toggle-menu="user-${id}"><i data-lucide="more-horizontal"></i></button>
            <div class="dropdown-menu" id="menu-user-${id}">
              <button class="dropdown-item" data-user-act="rename" data-id="${id}"><i data-lucide="pencil"></i> Renommer</button>
              <button class="dropdown-item danger" data-user-act="delete" data-id="${id}"><i data-lucide="trash-2"></i> Supprimer</button>
            </div>
          </div>
        </td>
      </tr>`;
  }).join('');
  refreshIcons();
}

async function loadPreAuthKeys() {
  const res = await safe(() => Headscale.preauthkeys.list());
  if (res) {
    state.preauthkeys = res.preAuthKeys || [];
    updateNavCounts();
    renderPreAuthKeys();
  }
}

function renderPreAuthKeys() {
  const tbody = document.getElementById('preauth-table-body');
  if (!tbody) return;
  if (!state.preauthkeys.length) {
    tbody.innerHTML = emptyRow(8, 'Aucune clé de pré-authentification.');
    refreshIcons();
    return;
  }
  tbody.innerHTML = state.preauthkeys.map((k) => {
    const id = String(k.id);
    return `
      <tr>
        <td><span class="mono text-zinc-300">${esc(k.key || '—')}</span></td>
        <td class="text-zinc-300">${esc(k.user?.name || '—')}</td>
        <td>${k.reusable ? '<span class="badge badge-primary">oui</span>' : '<span class="badge badge-muted">non</span>'}</td>
        <td>${k.ephemeral ? '<span class="badge badge-violet">oui</span>' : '<span class="badge badge-muted">non</span>'}</td>
        <td>${k.used ? '<span class="badge badge-warning">utilisée</span>' : '<span class="badge badge-success">libre</span>'}</td>
        <td class="text-zinc-400">${esc(fmtDate(k.expiration))}</td>
        <td>${(k.aclTags || []).map((t) => `<span class="badge badge-cyan">${esc(t)}</span>`).join(' ') || '—'}</td>
        <td class="text-right">
          <div class="dropdown">
            <button class="btn btn-icon btn-sm" data-toggle-menu="key-${id}"><i data-lucide="more-horizontal"></i></button>
            <div class="dropdown-menu" id="menu-key-${id}">
              <button class="dropdown-item" data-key-act="expire" data-id="${id}"><i data-lucide="clock"></i> Expirer</button>
              <button class="dropdown-item danger" data-key-act="delete" data-id="${id}"><i data-lucide="trash-2"></i> Supprimer</button>
            </div>
          </div>
        </td>
      </tr>`;
  }).join('');
  refreshIcons();
}

async function loadApiKeys() {
  const res = await safe(() => Headscale.apikeys.list());
  if (res) {
    state.apikeys = res.apiKeys || [];
    renderApiKeys();
  }
}

function renderApiKeys() {
  const tbody = document.getElementById('apikeys-table-body');
  if (!tbody) return;
  if (!state.apikeys.length) {
    tbody.innerHTML = emptyRow(5, 'Aucune clé API.');
    refreshIcons();
    return;
  }
  tbody.innerHTML = state.apikeys.map((k) => {
    const prefix = k.prefix || '—';
    const id = String(k.id);
    return `
      <tr>
        <td><span class="mono text-zinc-300">${esc(prefix)}</span></td>
        <td class="text-zinc-400">${esc(fmtDate(k.expiration))}</td>
        <td class="text-zinc-400">${esc(fmtDate(k.createdAt))}</td>
        <td class="text-zinc-400" title="${esc(fmtDate(k.lastSeen))}">${esc(timeAgo(k.lastSeen))}</td>
        <td class="text-right">
          <div class="dropdown">
            <button class="btn btn-icon btn-sm" data-toggle-menu="apikey-${id}"><i data-lucide="more-horizontal"></i></button>
            <div class="dropdown-menu" id="menu-apikey-${id}">
              <button class="dropdown-item" data-apikey-act="expire" data-id="${id}" data-prefix="${esc(prefix)}"><i data-lucide="clock"></i> Expirer</button>
              <button class="dropdown-item danger" data-apikey-act="delete" data-id="${id}" data-prefix="${esc(prefix)}"><i data-lucide="trash-2"></i> Supprimer</button>
            </div>
          </div>
        </td>
      </tr>`;
  }).join('');
  refreshIcons();
}

/* --- Routes & Exit Nodes --- */

const EXIT_ROUTES = new Set(['0.0.0.0/0', '::/0']);

async function loadRoutes() {
  if (!state.nodes.length) await loadNodes();
  renderRoutes();
}

function renderRoutes() {
  const container = document.getElementById('routes-container');
  if (!container) return;

  const cards = [];
  for (const n of state.nodes) {
    const announced = n.availableRoutes || [];
    const approved = new Set(n.approvedRoutes || []);
    if (!announced.length) continue;
    const rows = announced.map((route) => {
      const isExit = EXIT_ROUTES.has(route);
      const checked = approved.has(route);
      return `
        <div class="flex items-center justify-between gap-3 py-2 border-b border-edge last:border-0">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="mono text-[13px] text-zinc-200">${esc(route)}</span>
              ${isExit ? '<span class="badge badge-violet">Exit node</span>' : '<span class="badge badge-primary">Subnet</span>'}
            </div>
          </div>
          <label class="toggle" title="${checked ? 'Révoquer' : 'Approuver'}">
            <input type="checkbox" data-route-node="${esc(n.id)}" data-route-cidr="${esc(route)}" ${checked ? 'checked' : ''} />
            <span class="track"></span>
          </label>
        </div>`;
    }).join('');
    cards.push(`
      <div class="card card-pad">
        <div class="flex items-center gap-2 mb-3">
          <i data-lucide="server" class="w-4 h-4 text-zinc-400"></i>
          <span class="font-medium">${esc(n.name || n.givenName || n.id)}</span>
          <span class="text-zinc-500 text-[12px]">(${esc(n.user?.name || '—')})</span>
        </div>
        ${rows}
      </div>`);
  }

  if (!cards.length) {
    container.innerHTML = `<div class="col-span-full card"><div class="empty-state"><i data-lucide="route"></i><p class="empty-title">Aucune route annoncée</p><p>Aucun nœud n'annonce de sous-réseau ni de nœud de sortie.</p></div></div>`;
    refreshIcons();
    return;
  }
  container.innerHTML = cards.join('');
  refreshIcons();
}

/* ====================================================================== */
/*  Vue d'ensemble                                                        */
/* ====================================================================== */

async function loadOverview() {
  await Promise.allSettled([loadNodes(), loadUsers(), loadPreAuthKeys()]);
  const health = await safe(() => Headscale.health.check());
  renderOverview(health);
}

function renderOverview(health) {
  const total = state.nodes.length;
  const online = state.nodes.filter((n) => n.online).length;
  const onlinePct = total ? Math.round((online / total) * 100) : 0;

  const stats = [
    { label: 'Nœuds', value: total, icon: 'server', ratio: null, sub: 'machines enregistrées' },
    { label: 'En ligne', value: online, icon: 'wifi', ratio: total ? `${onlinePct}%` : '—', sub: 'de présence réseau' },
    { label: 'Utilisateurs', value: state.users.length, icon: 'users', ratio: null, sub: 'comptes actifs' },
    { label: 'Clés Pre-Auth', value: state.preauthkeys.length, icon: 'key-round', ratio: null, sub: 'jetons non expirés' },
  ];

  const statsHtml = stats.map((s, i) => `
    <div class="stat-tile" style="animation: tileIn 0.4s cubic-bezier(0.16,1,0.3,1) ${i * 55}ms both">
      <div class="stat-top">
        <span class="stat-ico"><i data-lucide="${s.icon}"></i></span>
        <span class="stat-label">${s.label}</span>
      </div>
      <div class="stat-value">${s.value}</div>
      ${s.ratio
        ? `<div class="progress" style="margin-top:auto"><span style="transform: scaleX(${onlinePct / 100});"></span></div>
           <div class="mono stat-sub">${s.ratio} de présence réseau</div>`
        : `<div class="mono stat-sub" style="margin-top:auto">${s.sub}</div>`}
    </div>`).join('');
  document.getElementById('overview-stats').innerHTML = statsHtml;

  // Santé serveur : lignes de diagnostic.
  const db = health && health.databaseConnectivity;
  const healthHtml = health
    ? `
    <div class="health-line">
      <span class="health-k">PostgreSQL</span>
      <span class="health-v">
        <span class="dot ${db ? 'dot-success' : 'dot-danger'}"></span>
        ${db ? 'connectée' : 'injoignable'}
      </span>
    </div>
    <div class="health-line">
      <span class="health-k">Endpoint</span>
      <span class="health-v"><span class="mono text-dim">GET /api/v1/health</span></span>
    </div>
    <div class="health-line">
      <span class="health-k">Statut</span>
      <span class="health-v"><span class="badge ${db ? 'badge-success' : 'badge-danger'}">${db ? 'opérationnel' : 'dégradé'}</span></span>
    </div>`
    : `<div class="dash-empty">Santé non disponible — vérifiez la connexion.</div>`;
  document.getElementById('overview-health').innerHTML = healthHtml;

  // Répartition par utilisateur : barres segmentées proportionnelles.
  const counts = {};
  for (const n of state.nodes) {
    const uname = n.user?.name || 'inconnu';
    counts[uname] = (counts[uname] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, c]) => c));
  const userHtml = entries.length
    ? entries.map(([name, c], i) => `
      <div class="peer-row">
        <span class="peer-name" title="${esc(name)}">${esc(name)}</span>
        <div class="peer-track"><span style="transform: scaleX(${(c / max) * 0.92}); transition-delay:${i * 40}ms"></span></div>
        <span class="peer-val">${c} <span>/ ${total}</span></span>
      </div>`).join('')
    : '<div class="dash-empty">Aucun nœud enregistré.</div>';
  document.getElementById('overview-users').innerHTML = userHtml;
  refreshIcons();
}

/* ====================================================================== */
/*  Politique ACL                                                         */
/* ====================================================================== */

async function loadPolicy() {
  const res = await safe(() => Headscale.policy.get());
  if (!res) { renderACL(); return; }
  state.policyUpdatedAt = res.updatedAt;
  if (res.policy) {
    try {
      state.aclState = ACL.parsePolicy(res.policy);
    } catch (err) {
      toast('Impossible de parser la politique existante : ' + err.message, 'error');
      state.aclState = ACL.createEmptyState();
    }
  } else {
    state.aclState = ACL.createEmptyState();
  }
  renderACL();
}

function updateAclUpdatedAt() {
  const el = document.getElementById('acl-updated-at');
  if (el) el.textContent = state.policyUpdatedAt ? fmtDate(state.policyUpdatedAt) : 'jamais';
}

function syncJsonEditor() {
  try { syncExtrasFromDom(); } catch { /* les erreurs remontent à la sauvegarde */ }
  const editor = document.getElementById('acl-json-editor');
  if (editor) editor.value = ACL.stateToJsonWithComments(state.aclState);
}

function renderACL() {
  renderAclRules();
  renderAclGroups();
  renderAclHosts();
  renderAclTagOwners();
  renderAclAutoApprovers();
  renderAclExtras();
  syncJsonEditor();
  updateAclUpdatedAt();
}

function renderAclRules() {
  const list = document.getElementById('acl-rules-list');
  if (!list) return;
  if (!state.aclState.acls.length) {
    list.innerHTML = `<div class="empty-state" style="padding:20px"><i data-lucide="shield-off"></i><p>Aucune règle définie.</p></div>`;
    refreshIcons();
    return;
  }
  list.innerHTML = state.aclState.acls.map((r, i) => {
    const src = r.src.map((s) => `<span class="acl-chip">${esc(s)}</span>`).join('');
    const dst = r.dst.map((s) => `<span class="acl-chip">${esc(s)}</span>`).join('');
    return `
      <div class="acl-card">
        <div class="flex items-start gap-3">
          <div class="flex-1 min-w-0">
            ${r.comment ? `<div class="text-[12px] text-zinc-500 italic mb-2">${esc(r.comment).replace(/\n/g, '<br>')}</div>` : ''}
            <div class="flex flex-wrap items-center gap-1">
              ${src}
              <i data-lucide="arrow-right" class="acl-arrow w-4 h-4 mx-1 shrink-0"></i>
              ${dst}
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <span class="badge ${r.action === 'drop' ? 'badge-danger' : 'badge-success'}">${r.action}</span>
            <button class="btn btn-icon btn-sm" data-acl-edit="${i}" title="Éditer"><i data-lucide="pencil"></i></button>
            <button class="btn btn-icon btn-sm btn-danger" data-acl-delete="${i}" title="Supprimer"><i data-lucide="trash-2"></i></button>
          </div>
        </div>
      </div>`;
  }).join('');
  refreshIcons();
}

function renderAclGroups() {
  const list = document.getElementById('acl-groups-list');
  if (!list) return;
  const groups = state.aclState.groups;
  if (!groups.length) {
    list.innerHTML = '<div class="text-zinc-600 text-[13px]">Aucun groupe.</div>';
    return;
  }
  list.innerHTML = groups.map((g, i) => `
    <div class="flex items-center justify-between gap-2 py-1.5 border-b border-edge last:border-0">
      <div class="min-w-0">
        <div class="mono text-[13px] text-zinc-200 truncate">${esc(g.name)}</div>
        <div class="text-[11px] text-zinc-500 truncate">${esc(g.members.join(', '))}</div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button class="btn btn-icon btn-sm" data-acl-edit-group="${i}" title="Modifier"><i data-lucide="pencil"></i></button>
        <button class="btn btn-icon btn-sm btn-danger" data-acl-del-group="${i}" title="Supprimer"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`).join('');
  refreshIcons();
}

function renderAclHosts() {
  const list = document.getElementById('acl-hosts-list');
  if (!list) return;
  const hosts = state.aclState.hosts;
  if (!hosts.length) {
    list.innerHTML = '<div class="text-zinc-600 text-[13px]">Aucun hôte.</div>';
    return;
  }
  list.innerHTML = hosts.map((h, i) => `
    <div class="flex items-center justify-between gap-2 py-1.5 border-b border-edge last:border-0">
      <div class="min-w-0">
        <div class="mono text-[13px] text-zinc-200 truncate">${esc(h.name)}</div>
        <div class="mono text-[11px] text-zinc-500 truncate">${esc(h.ip)}</div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button class="btn btn-icon btn-sm" data-acl-edit-host="${i}" title="Modifier"><i data-lucide="pencil"></i></button>
        <button class="btn btn-icon btn-sm btn-danger" data-acl-del-host="${i}" title="Supprimer"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`).join('');
  refreshIcons();
}

function renderAclTagOwners() {
  const list = document.getElementById('acl-tagowners-list');
  if (!list) return;
  const tags = state.aclState.tagOwners;
  if (!tags.length) {
    list.innerHTML = '<div class="text-zinc-600 text-[13px]">Aucun tag.</div>';
    return;
  }
  list.innerHTML = tags.map((t, i) => `
    <div class="flex items-center justify-between gap-2 py-1.5 border-b border-edge last:border-0">
      <div class="min-w-0">
        <div class="mono text-[13px] text-zinc-200 truncate">${esc(t.tag)}</div>
        <div class="text-[11px] text-zinc-500 truncate">${esc(t.owners.join(', '))}</div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button class="btn btn-icon btn-sm" data-acl-edit-tagowner="${i}" title="Modifier"><i data-lucide="pencil"></i></button>
        <button class="btn btn-icon btn-sm btn-danger" data-acl-del-tagowner="${i}" title="Supprimer"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`).join('');
  refreshIcons();
}

function renderAclAutoApprovers() {
  const list = document.getElementById('acl-autoapprovers-list');
  if (!list) return;
  const aa = state.aclState.autoApprovers;
  const routesHtml = aa.routes.length
    ? aa.routes.map((r, i) => `
        <div class="flex items-center justify-between gap-2 py-1.5 border-b border-edge last:border-0">
          <div class="min-w-0">
            <div class="mono text-[13px] text-zinc-200 truncate">${esc(r.subnet)}</div>
            <div class="text-[11px] text-zinc-500 truncate">${esc(r.approvers.join(', '))}</div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button class="btn btn-icon btn-sm" data-acl-edit-route="${i}" title="Modifier"><i data-lucide="pencil"></i></button>
            <button class="btn btn-icon btn-sm btn-danger" data-acl-del-route="${i}" title="Supprimer"><i data-lucide="trash-2"></i></button>
          </div>
        </div>`).join('')
    : '<div class="text-zinc-600 text-[13px]">Aucune route auto-approuvée.</div>';

  const exitHtml = aa.exitNode.length
    ? `<div class="mt-3">
         <div class="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Exit nodes</div>
         <div class="flex flex-wrap gap-1">${aa.exitNode.map((e, i) => `
           <span class="acl-chip" style="display:inline-flex;align-items:center;gap:5px">${esc(e)}
             <button class="btn btn-icon btn-sm" data-acl-edit-exit="${i}" title="Modifier" style="padding:2px"><i data-lucide="pencil" style="width:12px;height:12px"></i></button>
             <button class="btn btn-icon btn-sm" data-acl-del-exit="${i}" title="Supprimer" style="padding:2px"><i data-lucide="x" style="width:12px;height:12px"></i></button>
           </span>`).join('')}</div>
       </div>`
    : '';

  list.innerHTML = `
    <div class="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Routes (subnets)</div>
    ${routesHtml}
    <button class="btn btn-sm mt-2" data-acl-add-route><i data-lucide="plus"></i> Route</button>
    ${exitHtml}
    <button class="btn btn-sm mt-2" data-acl-add-exit><i data-lucide="plus"></i> Exit node</button>`;
  refreshIcons();
}

/** Sections non prises en charge (nodeAttrs, ssh, derpMap…) : rendu en JSON brut. */
function renderAclExtras() {
  const list = document.getElementById('acl-extras-list');
  if (!list) return;
  const keys = Object.keys(state.aclState.extras);
  if (!keys.length) {
    list.innerHTML = '<div class="text-zinc-600 text-[13px]">Aucune section non prise en charge.</div>';
    refreshIcons();
    return;
  }
  list.innerHTML = keys.map((key) => {
    const value = state.aclState.extras[key];
    return `
      <div class="border border-edge rounded-lg p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="mono text-[13px] text-cyan-300 font-medium">${esc(key)}</span>
          <button class="btn btn-icon btn-sm btn-danger" data-acl-del-extra="${esc(key)}" title="Supprimer la section"><i data-lucide="trash-2"></i></button>
        </div>
        <textarea class="textarea" data-extra-key="${esc(key)}" rows="4" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea>
      </div>`;
  }).join('');
  refreshIcons();
}

/**
 * Relit les textareas des sections non prises en charge et met à jour
 * `state.aclState.extras`. Lève une erreur si un JSON est invalide.
 */
function syncExtrasFromDom() {
  const list = document.getElementById('acl-extras-list');
  if (!list) return;
  const tas = list.querySelectorAll('[data-extra-key]');
  const newExtras = {};
  for (const ta of tas) {
    const key = ta.getAttribute('data-extra-key');
    const raw = ta.value.trim();
    try {
      newExtras[key] = raw ? JSON.parse(raw) : null;
    } catch (err) {
      throw new Error(`Section « ${key} » : JSON invalide (${err.message})`);
    }
  }
  state.aclState.extras = newExtras;
}

/* --- Options sources/destinations pour le modal règle --- */

function buildSourceOptions() {
  const opts = new Set(['*', 'autogroup:members']);
  for (const u of state.users) if (u.name) opts.add(u.name);
  for (const g of state.aclState.groups) if (g.name) opts.add(g.name);
  for (const h of state.aclState.hosts) if (h.name) opts.add(h.name);
  for (const t of state.aclState.tagOwners) if (t.tag) opts.add(t.tag);
  for (const n of state.nodes) {
    for (const tag of n.tags || []) opts.add(tag);
    for (const r of [...(n.subnetRoutes || []), ...(n.availableRoutes || [])]) opts.add(r);
  }
  return [...opts].sort((a, b) => a.localeCompare(b));
}

function populateAclSelects() {
  const options = buildSourceOptions();
  for (const id of ['acl-rule-src-add', 'acl-rule-dst-add']) {
    const sel = document.getElementById(id);
    sel.innerHTML = options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  }
}

function renderRuleChips() {
  renderChipList('acl-rule-src', ruleModal.src);
  renderChipList('acl-rule-dst', ruleModal.dst);
}

function renderChipList(id, list) {
  const c = document.getElementById(id);
  c.innerHTML = list.length
    ? list.map((item, i) => `
        <span class="acl-chip" style="display:inline-flex;align-items:center;gap:5px">
          ${esc(item)}
          <button class="btn btn-icon btn-sm" data-remove-chip="${i}" data-side="${id}" style="padding:2px"><i data-lucide="x" style="width:12px;height:12px"></i></button>
        </span>`).join('')
    : '<span class="text-zinc-600 text-[12px]">Aucune cible (par défaut "*").</span>';
  refreshIcons();
}

function openRuleModal(index) {
  ruleModal.editingIndex = index;
  const title = document.getElementById('acl-rule-title');
  if (index === null) {
    title.textContent = 'Ajouter une règle';
    ruleModal.src = [];
    ruleModal.dst = [];
    document.getElementById('acl-rule-action').value = 'accept';
    document.getElementById('acl-rule-src-ports').value = '';
    document.getElementById('acl-rule-dst-ports').value = '';
    document.getElementById('acl-rule-comment').value = '';
  } else {
    const r = state.aclState.acls[index];
    title.textContent = 'Modifier la règle';
    ruleModal.src = [...r.src];
    ruleModal.dst = [...r.dst];
    document.getElementById('acl-rule-action').value = r.action || 'accept';
    document.getElementById('acl-rule-src-ports').value = '';
    document.getElementById('acl-rule-dst-ports').value = '';
    document.getElementById('acl-rule-comment').value = r.comment || '';
  }
  populateAclSelects();
  renderRuleChips();
  openModal('modal-acl-rule');
}

function addRuleChip(side) {
  const selectId = side === 'src' ? 'acl-rule-src-add' : 'acl-rule-dst-add';
  const value = document.getElementById(selectId).value;
  if (!value) return;
  const list = side === 'src' ? ruleModal.src : ruleModal.dst;
  if (!list.includes(value)) list.push(value);
  renderRuleChips();
}

function removeRuleChip(side, index) {
  const list = side === 'src' ? ruleModal.src : ruleModal.dst;
  list.splice(index, 1);
  renderRuleChips();
}

function submitRule() {
  const action = document.getElementById('acl-rule-action').value;
  const srcPorts = document.getElementById('acl-rule-src-ports').value;
  const dstPorts = document.getElementById('acl-rule-dst-ports').value;
  const comment = document.getElementById('acl-rule-comment').value;
  const rule = ACL.buildRule({ action, src: ruleModal.src, dst: ruleModal.dst, srcPorts, dstPorts });
  rule.comment = comment;
  if (ruleModal.editingIndex === null) {
    state.aclState.acls.push(rule);
  } else {
    state.aclState.acls[ruleModal.editingIndex] = { ...state.aclState.acls[ruleModal.editingIndex], ...rule };
  }
  closeModal('modal-acl-rule');
  renderAclRules();
  syncJsonEditor();
  toast(ruleModal.editingIndex === null ? 'Règle ajoutée.' : 'Règle modifiée.', 'success');
}

function currentPolicyText() {
  if (state.activeAclTab === 'json') return document.getElementById('acl-json-editor').value;
  syncExtrasFromDom(); // peut lever une erreur → propagée à savePolicy/checkPolicy
  return ACL.stateToJsonWithComments(state.aclState);
}

async function savePolicy() {
  let text;
  try { text = currentPolicyText(); } catch (err) { toast(err.message, 'error'); return; }
  try { ACL.validateJson(text); } catch (err) { toast(err.message, 'error'); return; }
  const res = await safe(() => Headscale.policy.set(text), 'Sauvegarde');
  if (res) {
    state.policyUpdatedAt = res.updatedAt;
    updateAclUpdatedAt();
    toast('Politique ACL sauvegardée.', 'success');
  }
}

async function checkPolicy() {
  let text;
  try { text = currentPolicyText(); } catch (err) { toast(err.message, 'error'); return; }
  try { ACL.validateJson(text); } catch (err) { toast(err.message, 'error'); return; }
  const res = await safe(() => Headscale.policy.check(text), 'Vérification');
  if (res) toast('Politique valide.', 'success');
}

function switchAclTab(tab) {
  const visual = document.getElementById('acl-panel-visual');
  const json = document.getElementById('acl-panel-json');

  if (tab === 'json') {
    try { syncExtrasFromDom(); } catch (err) { toast(err.message, 'error'); return; }
    syncJsonEditor();
    visual.classList.add('hidden');
    json.classList.remove('hidden');
  } else {
    try {
      state.aclState = ACL.parsePolicy(document.getElementById('acl-json-editor').value);
      renderACL();
      visual.classList.remove('hidden');
      json.classList.add('hidden');
    } catch (err) {
      toast('JSON invalide : ' + err.message, 'error');
      return; // on reste sur l'onglet JSON
    }
  }
  state.activeAclTab = tab;
  document.querySelectorAll('[data-acl-tab]').forEach((b) =>
    b.classList.toggle('active', b.getAttribute('data-acl-tab') === tab));
  try { localStorage.setItem(LS_ACL_TAB, tab); } catch (_) { /* stockage indisponible */ }
}

/* ====================================================================== */
/*  Actions métier (nœuds, utilisateurs, clés…)                           */
/* ====================================================================== */

function findNode(id) {
  return state.nodes.find((n) => String(n.id) === String(id));
}

async function handleNodeAction(act, id) {
  const node = findNode(id);
  if (!node) return;
  const nodeId = String(node.id);

  if (act === 'detail') {
    showJson('Détails du nœud — ' + (node.name || nodeId), node);
    return;
  }
  if (act === 'rename') {
    const name = await showPrompt({
      title: 'Renommer le nœud', label: 'Nouveau nom',
      hint: 'Le nom DNS sera mis à jour.', value: node.givenName || node.name || '',
    });
    if (name === null || !name.trim()) return;
    const res = await safe(() => Headscale.nodes.rename(nodeId, name.trim()), 'Renommage');
    if (res) { toast('Nœud renommé.', 'success'); await loadNodes(); }
    return;
  }
  if (act === 'expire') {
    const ok = await showConfirm({ title: 'Expirer le nœud', message: `Forcer l'expiration de « ${node.name || nodeId} » ? Il devra se ré-authentifier.` });
    if (!ok) return;
    const res = await safe(() => Headscale.nodes.expire(nodeId, {}), 'Expiration');
    if (res) { toast('Nœud expiré.', 'success'); await loadNodes(); }
    return;
  }
  if (act === 'routes') {
    const current = (node.approvedRoutes || []).join(', ');
    const value = await showPrompt({
      title: 'Approuver les routes', label: 'Routes (séparées par virgule)',
      hint: 'Ex : 10.0.0.0/24, 192.168.1.0/24. Disponibles : ' + (node.availableRoutes || []).join(', '),
      value: current,
    });
    if (value === null) return;
    const routes = value.split(',').map((s) => s.trim()).filter(Boolean);
    const res = await safe(() => Headscale.nodes.approveRoutes(nodeId, routes), 'Routes');
    if (res) { toast('Routes mises à jour.', 'success'); await loadNodes(); }
    return;
  }
  if (act === 'tags') {
    const value = await showPrompt({
      title: 'Définir les tags', label: 'Tags (séparés par virgule)',
      hint: 'Ex : tag:server, tag:web', value: (node.tags || []).join(', '),
    });
    if (value === null) return;
    const tags = value.split(',').map((s) => s.trim()).filter(Boolean);
    const res = await safe(() => Headscale.nodes.setTags(nodeId, tags), 'Tags');
    if (res) { toast('Tags mis à jour.', 'success'); await loadNodes(); }
    return;
  }
  if (act === 'delete') {
    const ok = await showConfirm({ title: 'Supprimer le nœud', message: `Supprimer définitivement « ${node.name || nodeId} » ?` });
    if (!ok) return;
    const res = await safe(() => Headscale.nodes.remove(nodeId), 'Suppression');
    if (res) { toast('Nœud supprimé.', 'success'); await loadNodes(); }
  }
}

async function handleUserAction(act, id) {
  const user = state.users.find((u) => String(u.id) === String(id));
  if (!user) return;
  if (act === 'rename') {
    const name = await showPrompt({ title: 'Renommer l\'utilisateur', label: 'Nouveau nom', value: user.name });
    if (name === null || !name.trim()) return;
    const res = await safe(() => Headscale.users.rename(String(user.id), name.trim()), 'Renommage');
    if (res) { toast('Utilisateur renommé.', 'success'); await loadUsers(); }
    return;
  }
  if (act === 'delete') {
    const ok = await showConfirm({ title: 'Supprimer l\'utilisateur', message: `Supprimer « ${user.name} » ?` });
    if (!ok) return;
    const res = await safe(() => Headscale.users.remove(String(user.id)), 'Suppression');
    if (res) { toast('Utilisateur supprimé.', 'success'); await loadUsers(); }
  }
}

async function handleKeyAction(act, id) {
  if (act === 'expire') {
    const ok = await showConfirm({ title: 'Expirer la clé', message: 'Expirer cette clé de pré-authentification ?' });
    if (!ok) return;
    const res = await safe(() => Headscale.preauthkeys.expire(id), 'Expiration');
    if (res) { toast('Clé expirée.', 'success'); await loadPreAuthKeys(); }
    return;
  }
  if (act === 'delete') {
    const ok = await showConfirm({ title: 'Supprimer la clé', message: 'Supprimer définitivement cette clé ?' });
    if (!ok) return;
    const res = await safe(() => Headscale.preauthkeys.remove(id), 'Suppression');
    if (res) { toast('Clé supprimée.', 'success'); await loadPreAuthKeys(); }
  }
}

async function handleApiKeyAction(act, id, prefix) {
  if (act === 'expire') {
    const ok = await showConfirm({ title: 'Expirer la clé API', message: `Expirer la clé « ${prefix} » ?` });
    if (!ok) return;
    const res = await safe(() => Headscale.apikeys.expire(prefix, id), 'Expiration');
    if (res) { toast('Clé API expirée.', 'success'); await loadApiKeys(); }
    return;
  }
  if (act === 'delete') {
    const ok = await showConfirm({ title: 'Supprimer la clé API', message: `Supprimer la clé « ${prefix} » ?` });
    if (!ok) return;
    const res = await safe(() => Headscale.apikeys.remove(prefix, id), 'Suppression');
    if (res) { toast('Clé API supprimée.', 'success'); await loadApiKeys(); }
  }
}

async function toggleRoute(nodeId, cidr, enabled) {
  const node = findNode(nodeId);
  if (!node) return;
  const approved = new Set(node.approvedRoutes || []);
  if (enabled) approved.add(cidr); else approved.delete(cidr);
  const res = await safe(() => Headscale.nodes.approveRoutes(String(nodeId), [...approved]), 'Route');
  if (res) { toast(enabled ? 'Route approuvée.' : 'Route révoquée.', 'success'); await loadNodes(); renderRoutes(); }
}

/* ====================================================================== */
/*  Formulaires / modales métier                                          */
/* ====================================================================== */

function fillUserSelect(selectId, { placeholder = '—' } = {}) {
  const sel = document.getElementById(selectId);
  sel.innerHTML = `<option value="" disabled selected>${placeholder}</option>` +
    state.users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('');
}

async function submitUser() {
  const name = document.getElementById('user-name').value.trim();
  if (!name) { toast('Le nom d\'utilisateur est requis.', 'error'); return; }
  const body = { name };
  const displayName = document.getElementById('user-displayname').value.trim();
  const email = document.getElementById('user-email').value.trim();
  if (displayName) body.displayName = displayName;
  if (email) body.email = email;
  const res = await safe(() => Headscale.users.create(body), 'Création');
  if (res) {
    toast('Utilisateur créé.', 'success');
    closeModal('modal-user');
    document.getElementById('user-name').value = '';
    document.getElementById('user-displayname').value = '';
    document.getElementById('user-email').value = '';
    await loadUsers();
  }
}

async function submitPreAuthKey() {
  const userId = document.getElementById('preauth-user').value;
  if (!userId) { toast('Sélectionnez un utilisateur.', 'error'); return; }
  const body = {
    user: String(userId),
    reusable: document.getElementById('preauth-reusable').checked,
    ephemeral: document.getElementById('preauth-ephemeral').checked,
  };
  const expiration = fromDateTimeLocal(document.getElementById('preauth-expiration').value);
  if (expiration) body.expiration = expiration;
  const tags = document.getElementById('preauth-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (tags.length) body.aclTags = tags;

  const res = await safe(() => Headscale.preauthkeys.create(body), 'Génération');
  if (res && res.preAuthKey) {
    const key = res.preAuthKey.key || '';
    document.getElementById('preauth-result').classList.remove('hidden');
    document.getElementById('preauth-result-key').value = key;
    toast('Clé générée.', 'success');
    await loadPreAuthKeys();
  }
}

async function submitApiKey() {
  const expiration = fromDateTimeLocal(document.getElementById('apikey-expiration').value);
  const res = await safe(() => Headscale.apikeys.create(expiration), 'Création');
  if (res && res.apiKey) {
    document.getElementById('apikey-result').classList.remove('hidden');
    document.getElementById('apikey-result-key').value = res.apiKey;
    toast('Clé API créée.', 'success');
    await loadApiKeys();
  }
}

async function submitNodeRegister() {
  const userId = document.getElementById('node-register-user').value;
  const key = document.getElementById('node-register-key').value.trim();
  if (!userId) { toast('Sélectionnez un utilisateur.', 'error'); return; }
  if (!key) { toast('La clé de la machine est requise.', 'error'); return; }
  const res = await safe(() => Headscale.nodes.register(userId, key), 'Enregistrement');
  if (res) {
    toast('Nœud enregistré.', 'success');
    closeModal('modal-node-register');
    document.getElementById('node-register-key').value = '';
    await loadNodes();
  }
}

async function backfillIps() {
  const ok = await showConfirm({ title: 'Rebackfiller les IPs', message: 'Confirmer le rebackfill des adresses IP des nœuds ?' });
  if (!ok) return;
  const res = await safe(() => Headscale.nodes.backfillIps(true), 'Backfill');
  if (res) {
    const changes = (res.changes || []).length;
    toast(`Backfill terminé (${changes} changement${changes > 1 ? 's' : ''}).`, 'success');
    await loadNodes();
  }
}

/* --- Paramètres --- */

function openSettings() {
  const cfg = Headscale.config.get();
  document.getElementById('cfg-baseurl').value = cfg.baseUrl;
  document.getElementById('cfg-apikey').value = cfg.apiKey;
  document.getElementById('cfg-proxy-enabled').checked = cfg.corsProxyEnabled;
  document.getElementById('cfg-proxyurl').value = cfg.corsProxyUrl;
  openModal('modal-settings');
}

function saveSettings() {
  Headscale.config.save({
    baseUrl: document.getElementById('cfg-baseurl').value,
    apiKey: document.getElementById('cfg-apikey').value,
    corsProxyEnabled: document.getElementById('cfg-proxy-enabled').checked,
    corsProxyUrl: document.getElementById('cfg-proxyurl').value,
  });
  closeModal('modal-settings');
  toast('Paramètres enregistrés.', 'success');
  refreshStatus();
  // Recharge les données pour la vue courante.
  if (VIEWS[state.view]) VIEWS[state.view].load();
}

async function testConnection() {
  // Persiste temporairement les champs pour tester la saisie en cours.
  Headscale.config.save({
    baseUrl: document.getElementById('cfg-baseurl').value,
    apiKey: document.getElementById('cfg-apikey').value,
    corsProxyEnabled: document.getElementById('cfg-proxy-enabled').checked,
    corsProxyUrl: document.getElementById('cfg-proxyurl').value,
  });
  setStatus('checking');
  try {
    const health = await Headscale.health.check();
    toast(`Connexion réussie — base de données : ${health.databaseConnectivity ? 'connectée' : 'injoignable'}.`, 'success');
    setStatus('ok');
  } catch (err) {
    handleError(err, 'Test de connexion');
  }
}

/* ====================================================================== */
/*  Liaison des événements                                                */
/* ====================================================================== */

function bindStaticEvents() {
  // Navigation
  document.querySelectorAll('[data-view]').forEach((btn) =>
    btn.addEventListener('click', () => switchView(btn.getAttribute('data-view'))));

  // Boutons de la topbar
  document.getElementById('btn-refresh').addEventListener('click', () => {
    refreshStatus();
    if (VIEWS[state.view]) VIEWS[state.view].load();
  });
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-menu').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Fermeture des modales (boutons [data-close] + clic sur l'overlay + Échap)
  document.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close'))));
  document.querySelectorAll('.modal-overlay').forEach((ov) =>
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('open'); }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.open').forEach((ov) => ov.classList.remove('open'));
      if (promptResolve) { promptResolve(null); promptResolve = null; }
      if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
      if (aclEntityResolve) { aclEntityResolve(null); aclEntityResolve = null; }
    }
  });

  // Modale prompt / confirm
  document.getElementById('btn-prompt-ok').addEventListener('click', () => {
    if (promptResolve) { promptResolve(document.getElementById('prompt-input').value); promptResolve = null; }
    closeModal('modal-prompt');
  });
  document.getElementById('prompt-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-prompt-ok').click();
  });
  document.getElementById('btn-confirm-ok').addEventListener('click', () => {
    if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
    closeModal('modal-confirm');
  });

  // Modale d'édition d'entité ACL (groupe / hôte / tag / auto-approver).
  document.getElementById('btn-acl-entity-submit').addEventListener('click', () => {
    if (!aclEntityResolve) return;
    const result = {};
    document.querySelectorAll('#acl-entity-fields [data-field]').forEach((inp) => {
      result[inp.getAttribute('data-field')] = inp.value;
    });
    aclEntityResolve(result);
    aclEntityResolve = null;
    closeModal('modal-acl-entity');
  });

  // Annulation des modales prompt / confirm / entité ACL (Annuler, X, overlay ou Échap).
  const cancelPrompt = () => { if (promptResolve) { promptResolve(null); promptResolve = null; } };
  const cancelConfirm = () => { if (confirmResolve) { confirmResolve(false); confirmResolve = null; } };
  const cancelAclEntity = () => { if (aclEntityResolve) { aclEntityResolve(null); aclEntityResolve = null; } };
  document.getElementById('modal-prompt').addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.closest('[data-close]')) cancelPrompt();
  });
  document.getElementById('modal-confirm').addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.closest('[data-close]')) cancelConfirm();
  });
  document.getElementById('modal-acl-entity').addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.closest('[data-close]')) cancelAclEntity();
  });

  // Paramètres
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-test-connection').addEventListener('click', testConnection);

  // Utilisateurs
  document.getElementById('btn-user-create').addEventListener('click', () => openModal('modal-user'));
  document.getElementById('btn-user-submit').addEventListener('click', submitUser);

  // Pre-Auth keys
  document.getElementById('btn-preauth-create').addEventListener('click', () => {
    fillUserSelect('preauth-user');
    document.getElementById('preauth-result').classList.add('hidden');
    document.getElementById('preauth-expiration').value = '';
    document.getElementById('preauth-tags').value = '';
    document.getElementById('preauth-reusable').checked = true;
    document.getElementById('preauth-ephemeral').checked = false;
    openModal('modal-preauth');
  });
  document.getElementById('btn-preauth-submit').addEventListener('click', submitPreAuthKey);
  document.getElementById('btn-copy-key').addEventListener('click', () => {
    navigator.clipboard?.writeText(document.getElementById('preauth-result-key').value)
      .then(() => toast('Copiée.', 'success')).catch(() => toast('Copie impossible.', 'error'));
  });

  // API keys
  document.getElementById('btn-apikey-create').addEventListener('click', () => {
    document.getElementById('apikey-result').classList.add('hidden');
    document.getElementById('apikey-expiration').value = '';
    openModal('modal-apikey');
  });
  document.getElementById('btn-apikey-submit').addEventListener('click', submitApiKey);
  document.getElementById('btn-copy-apikey').addEventListener('click', () => {
    navigator.clipboard?.writeText(document.getElementById('apikey-result-key').value)
      .then(() => toast('Copiée.', 'success')).catch(() => toast('Copie impossible.', 'error'));
  });

  // Enregistrement manuel de nœud
  document.getElementById('btn-node-register').addEventListener('click', () => {
    fillUserSelect('node-register-user');
    document.getElementById('node-register-key').value = '';
    openModal('modal-node-register');
  });
  document.getElementById('btn-node-register-submit').addEventListener('click', submitNodeRegister);

  // Backfill IPs
  document.getElementById('btn-backfill').addEventListener('click', backfillIps);

  // Filtre nœuds
  document.getElementById('nodes-filter').addEventListener('input', renderNodes);

  // Tri des nœuds (en-têtes de colonne triables)
  document.querySelectorAll('[data-node-sort]').forEach((th) =>
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-node-sort');
      if (state.nodeSort.key === key) {
        state.nodeSort.dir = state.nodeSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.nodeSort = { key, dir: 'asc' };
      }
      renderNodes();
    }));

  // ACL : onglets & actions
  document.querySelectorAll('[data-acl-tab]').forEach((b) =>
    b.addEventListener('click', () => switchAclTab(b.getAttribute('data-acl-tab'))));
  document.getElementById('btn-acl-load').addEventListener('click', loadPolicy);
  document.getElementById('btn-acl-save').addEventListener('click', savePolicy);
  document.getElementById('btn-acl-check').addEventListener('click', checkPolicy);
  document.getElementById('btn-acl-format').addEventListener('click', () => {
    const editor = document.getElementById('acl-json-editor');
    try { editor.value = JSON.stringify(ACL.validateJson(editor.value), null, 2); }
    catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('btn-acl-add-rule').addEventListener('click', () => openRuleModal(null));
  document.getElementById('btn-acl-rule-submit').addEventListener('click', submitRule);
  document.getElementById('btn-acl-src-add').addEventListener('click', () => addRuleChip('src'));
  document.getElementById('btn-acl-dst-add').addEventListener('click', () => addRuleChip('dst'));

  document.getElementById('btn-acl-add-group').addEventListener('click', addGroup);
  document.getElementById('btn-acl-add-host').addEventListener('click', addHost);
  document.getElementById('btn-acl-add-tagowner').addEventListener('click', addTagOwner);
  document.getElementById('btn-acl-add-extra').addEventListener('click', addExtra);
}

/* --- Ajouts ACL (groupes / hôtes / tags) --- */

async function addGroup() {
  const name = await showPrompt({ title: 'Nouveau groupe', label: 'Nom du groupe', hint: 'Convention : group:nom', value: 'group:' });
  if (name === null || !name.trim()) return;
  const members = await showPrompt({ title: 'Membres', label: 'Membres (séparés par virgule)', hint: 'Noms d\'utilisateurs, ex : alice, bob' });
  if (members === null) return;
  state.aclState.groups.push({
    name: name.trim(),
    members: members.split(',').map((s) => s.trim()).filter(Boolean),
  });
  renderAclGroups();
  syncJsonEditor();
  toast('Groupe ajouté.', 'success');
}

async function addHost() {
  const name = await showPrompt({ title: 'Nouvel hôte', label: 'Nom de l\'hôte', hint: 'Convention : host:nom', value: 'host:' });
  if (name === null || !name.trim()) return;
  const ip = await showPrompt({ title: 'Adresse IP', label: 'Adresse IP (ex : 100.64.0.10)' });
  if (ip === null || !ip.trim()) return;
  state.aclState.hosts.push({ name: name.trim(), ip: ip.trim() });
  renderAclHosts();
  syncJsonEditor();
  toast('Hôte ajouté.', 'success');
}

async function addTagOwner() {
  const tag = await showPrompt({ title: 'Nouveau tag', label: 'Nom du tag', hint: 'Convention : tag:nom', value: 'tag:' });
  if (tag === null || !tag.trim()) return;
  const owners = await showPrompt({ title: 'Propriétaires', label: 'Propriétaires (séparés par virgule)', hint: 'Utilisateurs ou groupes, ex : group:admins' });
  if (owners === null) return;
  state.aclState.tagOwners.push({
    tag: tag.trim(),
    owners: owners.split(',').map((s) => s.trim()).filter(Boolean),
  });
  renderAclTagOwners();
  syncJsonEditor();
  toast('Tag ajouté.', 'success');
}

/* --- Éditions ACL (groupes / hôtes / tags / auto-approvers) --- */

function splitList(value) {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

async function editGroup(i) {
  const g = state.aclState.groups[i];
  if (!g) return;
  const res = await showAclEntityForm({
    title: 'Modifier le groupe',
    fields: [
      { key: 'name', label: 'Nom du groupe', value: g.name, hint: 'Convention : group:nom' },
      { key: 'members', label: 'Membres (séparés par virgule)', value: g.members.join(', '), hint: 'Noms d\'utilisateurs, ex : alice, bob' },
    ],
  });
  if (!res) return;
  const name = res.name.trim();
  if (!name) return;
  state.aclState.groups[i] = { ...g, name, members: splitList(res.members) };
  renderAclGroups();
  syncJsonEditor();
  toast('Groupe modifié.', 'success');
}

async function editHostItem(i) {
  const h = state.aclState.hosts[i];
  if (!h) return;
  const res = await showAclEntityForm({
    title: 'Modifier l\'hôte',
    fields: [
      { key: 'name', label: 'Nom de l\'hôte', value: h.name, hint: 'Convention : host:nom' },
      { key: 'ip', label: 'Adresse IP', value: h.ip, hint: 'Ex : 100.64.0.10' },
    ],
  });
  if (!res) return;
  const name = res.name.trim();
  if (!name) return;
  state.aclState.hosts[i] = { ...h, name, ip: res.ip.trim() };
  renderAclHosts();
  syncJsonEditor();
  toast('Hôte modifié.', 'success');
}

async function editTagOwner(i) {
  const t = state.aclState.tagOwners[i];
  if (!t) return;
  const res = await showAclEntityForm({
    title: 'Modifier le tag',
    fields: [
      { key: 'tag', label: 'Nom du tag', value: t.tag, hint: 'Convention : tag:nom' },
      { key: 'owners', label: 'Propriétaires (séparés par virgule)', value: t.owners.join(', '), hint: 'Utilisateurs ou groupes, ex : group:admins' },
    ],
  });
  if (!res) return;
  const tag = res.tag.trim();
  if (!tag) return;
  state.aclState.tagOwners[i] = { ...t, tag, owners: splitList(res.owners) };
  renderAclTagOwners();
  syncJsonEditor();
  toast('Tag modifié.', 'success');
}

async function editAutoRoute(i) {
  const r = state.aclState.autoApprovers.routes[i];
  if (!r) return;
  const res = await showAclEntityForm({
    title: 'Route auto-approuvée',
    fields: [
      { key: 'subnet', label: 'Sous-réseau', value: r.subnet, hint: 'Ex : 10.0.0.0/24' },
      { key: 'approvers', label: 'Approbateurs (séparés par virgule)', value: r.approvers.join(', '), hint: 'Utilisateurs ou groupes' },
    ],
  });
  if (!res) return;
  const subnet = res.subnet.trim();
  if (!subnet) return;
  state.aclState.autoApprovers.routes[i] = { ...r, subnet, approvers: splitList(res.approvers) };
  renderAclAutoApprovers();
  syncJsonEditor();
  toast('Route auto-approuvée modifiée.', 'success');
}

async function editExitItem(i) {
  const list = state.aclState.autoApprovers.exitNode;
  if (!list[i]) return;
  const res = await showAclEntityForm({
    title: 'Exit node auto-approuvé',
    fields: [{ key: 'value', label: 'Utilisateurs / groupes (séparés par virgule)', value: list[i], hint: 'Ex : alice, group:admins' }],
  });
  if (!res) return;
  const value = res.value.trim();
  if (!value) return;
  list[i] = value;
  renderAclAutoApprovers();
  syncJsonEditor();
  toast('Exit node modifié.', 'success');
}

/* ====================================================================== */
/*  Délégation d'événements (éléments générés dynamiquement)              */
/* ====================================================================== */

function bindDelegatedEvents() {
  document.addEventListener('click', (e) => {
    // Ferme les menus déroulants au clic extérieur.
    if (!e.target.closest('.dropdown')) {
      document.querySelectorAll('.dropdown-menu.open').forEach((m) => m.classList.remove('open'));
    }

    // Toggle des menus déroulants.
    const toggle = e.target.closest('[data-toggle-menu]');
    if (toggle) {
      e.stopPropagation();
      const menuId = toggle.getAttribute('data-toggle-menu');
      const menu = document.getElementById('menu-' + menuId);
      if (menu) {
        const wasOpen = menu.classList.contains('open');
        document.querySelectorAll('.dropdown-menu.open').forEach((m) => m.classList.remove('open'));
        if (!wasOpen) {
          menu.classList.add('open');
          // Si le menu déborde en bas de l'écran, on l'ouvre vers le haut.
          menu.classList.toggle('up', menu.getBoundingClientRect().bottom > window.innerHeight);
        }
      }
      return;
    }

    // Actions nœuds / utilisateurs / clés.
    const nodeAct = e.target.closest('[data-node-act]');
    if (nodeAct) { handleNodeAction(nodeAct.getAttribute('data-node-act'), nodeAct.getAttribute('data-id')); return; }
    const userAct = e.target.closest('[data-user-act]');
    if (userAct) { handleUserAction(userAct.getAttribute('data-user-act'), userAct.getAttribute('data-id')); return; }
    const keyAct = e.target.closest('[data-key-act]');
    if (keyAct) { handleKeyAction(keyAct.getAttribute('data-key-act'), keyAct.getAttribute('data-id')); return; }
    const apiKeyAct = e.target.closest('[data-apikey-act]');
    if (apiKeyAct) { handleApiKeyAction(apiKeyAct.getAttribute('data-apikey-act'), apiKeyAct.getAttribute('data-id'), apiKeyAct.getAttribute('data-prefix')); return; }

    // ACL : édition / suppression de règles.
    const edit = e.target.closest('[data-acl-edit]');
    if (edit) { openRuleModal(Number(edit.getAttribute('data-acl-edit'))); return; }
    const del = e.target.closest('[data-acl-delete]');
    if (del) {
      state.aclState.acls.splice(Number(del.getAttribute('data-acl-delete')), 1);
      renderAclRules(); syncJsonEditor(); return;
    }

    // ACL : suppressions groupes / hôtes / tags / auto-approvers.
    // ACL : éditions groupes / hôtes / tags / auto-approvers.
    const editGroupEl = e.target.closest('[data-acl-edit-group]');
    if (editGroupEl) { editGroup(Number(editGroupEl.getAttribute('data-acl-edit-group'))); return; }
    const editHostEl = e.target.closest('[data-acl-edit-host]');
    if (editHostEl) { editHostItem(Number(editHostEl.getAttribute('data-acl-edit-host'))); return; }
    const editTagEl = e.target.closest('[data-acl-edit-tagowner]');
    if (editTagEl) { editTagOwner(Number(editTagEl.getAttribute('data-acl-edit-tagowner'))); return; }
    const editRouteEl = e.target.closest('[data-acl-edit-route]');
    if (editRouteEl) { editAutoRoute(Number(editRouteEl.getAttribute('data-acl-edit-route'))); return; }
    const editExitEl = e.target.closest('[data-acl-edit-exit]');
    if (editExitEl) { editExitItem(Number(editExitEl.getAttribute('data-acl-edit-exit'))); return; }

    const delGroup = e.target.closest('[data-acl-del-group]');
    if (delGroup) { state.aclState.groups.splice(Number(delGroup.getAttribute('data-acl-del-group')), 1); renderAclGroups(); syncJsonEditor(); return; }
    const delHost = e.target.closest('[data-acl-del-host]');
    if (delHost) { state.aclState.hosts.splice(Number(delHost.getAttribute('data-acl-del-host')), 1); renderAclHosts(); syncJsonEditor(); return; }
    const delTag = e.target.closest('[data-acl-del-tagowner]');
    if (delTag) { state.aclState.tagOwners.splice(Number(delTag.getAttribute('data-acl-del-tagowner')), 1); renderAclTagOwners(); syncJsonEditor(); return; }
    const delRoute = e.target.closest('[data-acl-del-route]');
    if (delRoute) { state.aclState.autoApprovers.routes.splice(Number(delRoute.getAttribute('data-acl-del-route')), 1); renderAclAutoApprovers(); syncJsonEditor(); return; }
    const delExit = e.target.closest('[data-acl-del-exit]');
    if (delExit) { state.aclState.autoApprovers.exitNode.splice(Number(delExit.getAttribute('data-acl-del-exit')), 1); renderAclAutoApprovers(); syncJsonEditor(); return; }

    const delExtra = e.target.closest('[data-acl-del-extra]');
    if (delExtra) {
      delete state.aclState.extras[delExtra.getAttribute('data-acl-del-extra')];
      renderAclExtras(); syncJsonEditor(); return;
    }

    const addRoute = e.target.closest('[data-acl-add-route]');
    if (addRoute) { addAutoApproverRoute(); return; }
    const addExit = e.target.closest('[data-acl-add-exit]');
    if (addExit) { addAutoApproverExit(); return; }

    // Suppression de chip dans le modal règle.
    const rmChip = e.target.closest('[data-remove-chip]');
    if (rmChip) {
      const side = rmChip.getAttribute('data-side') === 'acl-rule-src' ? 'src' : 'dst';
      removeRuleChip(side, Number(rmChip.getAttribute('data-remove-chip')));
      return;
    }
  });

  // Toggles des routes (change).
  document.addEventListener('change', (e) => {
    const t = e.target.closest('[data-route-node]');
    if (t) {
      toggleRoute(t.getAttribute('data-route-node'), t.getAttribute('data-route-cidr'), t.checked);
    }
  });
}

async function addAutoApproverRoute() {
  const subnet = await showPrompt({ title: 'Route auto-approuvée', label: 'Sous-réseau', hint: 'Ex : 10.0.0.0/24' });
  if (subnet === null || !subnet.trim()) return;
  const approvers = await showPrompt({ title: 'Approbateurs', label: 'Approbateurs (séparés par virgule)', hint: 'Utilisateurs ou groupes' });
  if (approvers === null) return;
  state.aclState.autoApprovers.routes.push({
    subnet: subnet.trim(),
    approvers: approvers.split(',').map((s) => s.trim()).filter(Boolean),
  });
  renderAclAutoApprovers();
  syncJsonEditor();
  toast('Route auto-approuvée ajoutée.', 'success');
}

async function addAutoApproverExit() {
  const value = await showPrompt({ title: 'Exit node auto-approuvé', label: 'Utilisateurs / groupes (séparés par virgule)', hint: 'Ex : alice, group:admins' });
  if (value === null || !value.trim()) return;
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of list) if (!state.aclState.autoApprovers.exitNode.includes(item)) state.aclState.autoApprovers.exitNode.push(item);
  renderAclAutoApprovers();
  syncJsonEditor();
  toast('Exit node auto-approuvé ajouté.', 'success');
}

async function addExtra() {
  const key = await showPrompt({ title: 'Nouvelle section', label: 'Nom de la clé', hint: 'Ex : nodeAttrs, ssh, derpMap…' });
  if (key === null || !key.trim()) return;
  const k = key.trim();
  if (state.aclState.extras[k] !== undefined) { toast(`La section « ${k} » existe déjà.`, 'error'); return; }
  state.aclState.extras[k] = {};
  renderAclExtras();
  syncJsonEditor();
  toast(`Section « ${k} » ajoutée.`, 'success');
}

/* ====================================================================== */
/*  Initialisation                                                        */
/* ====================================================================== */

async function init() {
  bindStaticEvents();
  bindDelegatedEvents();
  refreshIcons();

  const cfg = Headscale.config.get();
  setStatus(cfg.baseUrl ? 'checking' : 'none');

  if (cfg.baseUrl) {
    await switchView(initialView());
    refreshStatus();
  } else {
    switchView(initialView()); // rend la vue sans appel réseau
    openModal('modal-settings');
  }
}

init();
