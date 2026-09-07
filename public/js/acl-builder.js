/**
 * js/acl-builder.js — Moteur de génération / parsing de la politique ACL.
 *
 * La politique Headscale/Tailscale est un document JSON (format "HuJSON" pour
 * Headscale : les commentaires `//` et `/* *​/` y sont autorisés). Ce module
 * tolère ces commentaires à la lecture et les conserve au format texte.
 *
 * Contenu supporté :
 *   - groups       : { "group:name": ["user", ...] }
 *   - hosts        : { "host:name": "100.64.0.x" }
 *   - tagOwners    : { "tag:name": ["user", "group:...", ...] }
 *   - autoApprovers: { routes: {...}, exitNode: [...] }
 *   - acls         : [ { action, src[], dst[], comment } ]  (comment = métadonnée locale)
 *   - ssh, nodeAttrs, derpMap, … (transmis tels quels)
 *
 * Chaque règle ACL peut porter un champ `comment` (chaîne, éventuellement
 * multi-ligne). À la sérialisation, ces commentaires sont émis en `// …` au
 * dessus de la règle correspondante.
 */

/* ---------------------------------------------------------------------- */
/*  Modèle d'état visuel                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Crée un état ACL par défaut.
 * @returns {object} état ACL complet
 */
export function createEmptyState() {
  return {
    groups: [],          // [{ id, name, members: [] }]
    hosts: [],           // [{ id, name, ip }]
    tagOwners: [],       // [{ id, tag, owners: [] }]
    autoApprovers: {
      routes: [],        // [{ id, subnet, approvers: [] }]
      exitNode: [],      // [string]
    },
    acls: [],            // [{ id, action, src: [], dst: [], comment: '' }]
    extras: {},          // ssh, nodeAttrs, derpMap, … conservés bruts
  };
}

let idCounter = 0;
function nextId() {
  return 'r' + (++idCounter) + '_' + Math.random().toString(36).slice(2, 7);
}

/* ---------------------------------------------------------------------- */
/*  Gestion des commentaires JSON (HuJSON)                                */
/* ---------------------------------------------------------------------- */

/**
 * Supprime les commentaires `//` et `/* *​/` d'un texte JSON (hors chaînes).
 * @param {string} text
 * @returns {{cleaned: string, comments: Array<{index:number, text:string}>}}
 *   `cleaned` : JSON sans commentaires. `comments` : commentaires `//` avec
 *   leur position (`index`) dans `cleaned`, pour ré-association aux règles.
 */
function stripCommentsWithPositions(text) {
  let cleaned = '';
  const comments = [];
  let i = 0;
  let inString = false;
  let quote = '';

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (inString) {
      cleaned += c;
      if (c === '\\' && i + 1 < text.length) { cleaned += next; i += 2; continue; }
      if (c === quote) inString = false;
      i++;
      continue;
    }

    if (c === '"' || c === "'") { inString = true; quote = c; cleaned += c; i++; continue; }

    if (c === '/' && next === '/') {
      i += 2;
      let commentText = '';
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') { commentText += text[i]; i++; }
      comments.push({ index: cleaned.length, text: commentText.trim() });
      continue; // le saut de ligne est repris à l'itération suivante
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    cleaned += c;
    i++;
  }

  return { cleaned, comments };
}

/** Version simplifiée : retourne uniquement le JSON nettoyé. */
function stripJsonComments(text) {
  return stripCommentsWithPositions(text).cleaned;
}

/**
 * Repère la position (dans le JSON joli) de l'accolade d'ouverture de chaque
 * objet de premier niveau du tableau `acls`.
 * @param {string} json chaîne JSON (formatée ou non)
 * @returns {number[]} positions des `{`
 */
function findAclObjectPositions(json) {
  const keyIdx = json.indexOf('"acls"');
  if (keyIdx === -1) return [];
  const arrStart = json.indexOf('[', keyIdx);
  if (arrStart === -1) return [];

  const positions = [];
  let depth = 1; // on est à l'intérieur du tableau "acls"
  let inString = false;

  for (let p = arrStart + 1; p < json.length; p++) {
    const c = json[p];
    if (inString) {
      if (c === '\\') { p++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { if (depth === 1) positions.push(p); depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (c === '[') { depth++; continue; }
    if (c === ']') { depth--; if (depth === 0) break; continue; }
  }
  return positions;
}

/**
 * Associe les commentaires `//` aux règles ACL par position.
 * Un commentaire est rattaché à la première règle dont l'accolade le suit.
 * @param {string} cleaned JSON nettoyé
 * @param {Array<{index:number, text:string}>} comments
 * @returns {string[]} commentaire (éventuellement multi-ligne) par index de règle
 */
function mapCommentsToRules(cleaned, comments) {
  const positions = findAclObjectPositions(cleaned);
  if (!positions.length || !comments.length) return new Array(positions.length).fill('');

  // Ignore les commentaires placés avant le tableau "acls".
  const keyIdx = cleaned.indexOf('"acls"');
  const arrStart = keyIdx === -1 ? -1 : cleaned.indexOf('[', keyIdx);

  const result = new Array(positions.length).fill('');
  for (const c of comments) {
    if (arrStart !== -1 && c.index <= arrStart) continue;
    let target = -1;
    for (let i = 0; i < positions.length; i++) {
      if (positions[i] > c.index) { target = i; break; }
    }
    if (target >= 0) {
      result[target] = result[target] ? result[target] + '\n' + c.text : c.text;
    }
  }
  return result;
}

/* ---------------------------------------------------------------------- */
/*  Parsing JSON -> état visuel                                           */
/* ---------------------------------------------------------------------- */

const ACL_RESERVED_KEYS = new Set(['groups', 'hosts', 'tagOwners', 'autoApprovers', 'acls']);

/**
 * Convertit un document JSON de politique en état visuel.
 * Accepte un objet JS ou une chaîne JSON (avec ou sans commentaires `//`).
 * @param {object|string} policyObj
 * @returns {object} état ACL
 */
export function parsePolicy(policyObj) {
  let doc;
  let ruleComments = [];

  if (typeof policyObj === 'string') {
    const { cleaned, comments } = stripCommentsWithPositions(policyObj);
    doc = JSON.parse(cleaned);
    ruleComments = mapCommentsToRules(cleaned, comments);
  } else {
    doc = policyObj;
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Politique invalide : document JSON attendu.');
  }

  const state = createEmptyState();

  state.groups = mapRecord(doc.groups, (name, members) => ({
    id: nextId(), name, members: asArray(members),
  }));

  state.hosts = mapRecord(doc.hosts, (name, ip) => ({
    id: nextId(), name, ip: String(ip ?? ''),
  }));

  state.tagOwners = mapRecord(doc.tagOwners, (tag, owners) => ({
    id: nextId(), tag, owners: asArray(owners),
  }));

  const aa = doc.autoApprovers || {};
  state.autoApprovers.routes = mapRecord(aa.routes, (subnet, approvers) => ({
    id: nextId(), subnet, approvers: asArray(approvers),
  }));
  state.autoApprovers.exitNode = asArray(aa.exitNode);

  state.acls = asArray(doc.acls).map((r, i) => ({
    id: nextId(),
    action: r.action || 'accept',
    src: asArray(r.src),
    dst: asArray(r.dst),
    comment: ruleComments[i] || '',
  }));

  state.extras = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!ACL_RESERVED_KEYS.has(key)) state.extras[key] = value;
  }

  return state;
}

/** Convertit un objet {clé: valeur} en tableau via un mapper. */
function mapRecord(obj, mapper) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj).map(([key, value]) => mapper(key, value));
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.slice() : [value];
}

/* ---------------------------------------------------------------------- */
/*  État visuel -> JSON                                                   */
/* ---------------------------------------------------------------------- */

/**
 * Sérialise un état ACL en objet JSON conforme Headscale (sans commentaires).
 * @param {object} state état ACL
 * @returns {object} document de politique
 */
export function serializePolicy(state) {
  const doc = { ...state.extras };

  if (state.groups.length) {
    doc.groups = {};
    for (const g of state.groups) {
      if (g.name && g.members.length) doc.groups[g.name] = g.members;
    }
  }
  if (state.hosts.length) {
    doc.hosts = {};
    for (const h of state.hosts) {
      if (h.name && h.ip) doc.hosts[h.name] = h.ip;
    }
  }
  if (state.tagOwners.length) {
    doc.tagOwners = {};
    for (const t of state.tagOwners) {
      if (t.tag && t.owners.length) doc.tagOwners[t.tag] = t.owners;
    }
  }

  const routes = {};
  for (const r of state.autoApprovers.routes) {
    if (r.subnet && r.approvers.length) routes[r.subnet] = r.approvers;
  }
  if (Object.keys(routes).length || state.autoApprovers.exitNode.length) {
    doc.autoApprovers = {};
    if (Object.keys(routes).length) doc.autoApprovers.routes = routes;
    if (state.autoApprovers.exitNode.length) doc.autoApprovers.exitNode = state.autoApprovers.exitNode;
  }

  if (state.acls.length) {
    doc.acls = state.acls.map((r) => ({
      action: r.action || 'accept',
      src: r.src.length ? r.src : ['*'],
      dst: r.dst.length ? r.dst : ['*'],
    }));
  }

  return doc;
}

/**
 * Retourne le JSON joli (indenté) d'un état ACL, sans commentaires.
 * @param {object} state état ACL
 * @returns {string}
 */
export function stateToJson(state) {
  return stringifyPolicy(serializePolicy(state));
}

/* ---------------------------------------------------------------------- */
/*  Sérialisation JSON « jolie » avec règles ACL courtes compactes         */
/* ---------------------------------------------------------------------- */

/**
 * Sérialise récursivement une valeur avec indentation 2 espaces (équivalent
 * `JSON.stringify(value, null, 2)` mais réutilisable pour le cas ACL).
 */
function stringifyValue(value, level) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const pad = '  '.repeat(level);
    const inner = value.map((v) => pad + '  ' + stringifyValue(v, level + 1));
    return '[\n' + inner.join(',\n') + '\n' + pad + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    const pad = '  '.repeat(level);
    const inner = keys.map((k) => pad + '  ' + JSON.stringify(k) + ': ' + stringifyValue(value[k], level + 1));
    return '{\n' + inner.join(',\n') + '\n' + pad + '}';
  }
  return JSON.stringify(value);
}

/** Une règle ACL est « courte » si src et dst comptent chacun ≤ 2 éléments. */
function isShortRule(rule) {
  return (rule.src?.length || 0) <= 2 && (rule.dst?.length || 0) <= 2;
}

/** Formate le tableau `acls` : règles courtes sur une ligne, longues en multi-lignes. */
function formatAcls(acls) {
  if (!acls.length) return '[]';
  const pad = '  ';
  const items = acls.map((rule) => {
    const str = isShortRule(rule) ? JSON.stringify(rule) : stringifyValue(rule, 2);
    return pad + pad + str;
  });
  return '[\n' + items.join(',\n') + '\n' + pad + ']';
}

/** Sérialise le document de politique : tout en 2 espaces, sauf les règles ACL courtes. */
function stringifyPolicy(doc) {
  const pad = '  ';
  const keys = Object.keys(doc);
  const lines = keys.map((k) => {
    const valueStr = k === 'acls' ? formatAcls(doc[k]) : stringifyValue(doc[k], 1);
    return pad + JSON.stringify(k) + ': ' + valueStr;
  });
  return '{\n' + lines.join(',\n') + '\n}';
}

/**
 * Retourne le JSON joli en incluant les commentaires des règles (`// …`).
 * C'est ce format (HuJSON) qui est envoyé au serveur Headscale.
 * @param {object} state état ACL
 * @returns {string}
 */
export function stateToJsonWithComments(state) {
  const json = stateToJson(state);
  const rules = state.acls || [];
  if (!rules.length) return json;

  const positions = findAclObjectPositions(json);
  if (!positions.length) return json;

  let result = json;
  // Injection en ordre inverse pour ne pas décaler les positions précédentes.
  for (let i = rules.length - 1; i >= 0; i--) {
    const comment = (rules[i].comment || '').trim();
    const pos = positions[i];
    if (!comment || pos === undefined) continue;
    // Indentation de la règle (espaces précédant l'accolade d'ouverture).
    let lineStart = pos;
    while (lineStart > 0 && result[lineStart - 1] !== '\n') lineStart--;
    const indent = result.slice(lineStart, pos);
    const lines = comment.split('\n').map((l) => l.trim()).filter(Boolean);
    const block = lines.map((l) => indent + '// ' + l).join('\n') + '\n' + indent;
    result = result.slice(0, lineStart) + block + result.slice(pos);
  }
  return result;
}

/* ---------------------------------------------------------------------- */
/*  Aides à la construction des règles                                    */
/* ---------------------------------------------------------------------- */

/**
 * Applique des ports à une liste de cibles au format Tailscale (`cible:port`).
 * @param {string[]} targets
 * @param {string} ports chaîne libre : '*', '80,443', 'tcp:80,443'…
 * @returns {string[]}
 */
export function applyPorts(targets, ports) {
  const trimmed = (ports || '').trim();
  if (!trimmed || trimmed === '*') return targets;

  const hasPort = targets.some((t) => t.split(':').length > 2);
  if (hasPort) return targets;

  if (/^(tcp|udp):/.test(trimmed)) {
    return targets.map((t) => `${t}:${trimmed}`);
  }

  const portsList = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
  const result = [];
  for (const t of targets) {
    for (const p of portsList) result.push(`${t}:${p}`);
  }
  return result;
}

/**
 * Construit une règle ACL complète en appliquant les ports aux sources/destinations.
 * @param {object} params { action, src, dst, srcPorts, dstPorts }
 * @returns {object} { action, src, dst }
 */
export function buildRule({ action = 'accept', src = [], dst = [], srcPorts = '', dstPorts = '' }) {
  const resolvedSrc = applyPorts(src, srcPorts);
  const resolvedDst = applyPorts(dst, dstPorts);
  return {
    action,
    src: resolvedSrc.length ? resolvedSrc : ['*'],
    dst: resolvedDst.length ? resolvedDst : ['*'],
  };
}

/**
 * Sépare une cible de type "tag:server:80" en { base, port }.
 * @param {string} target
 */
export function splitTarget(target) {
  const parts = String(target).split(':');
  if (parts.length >= 3) {
    return { base: parts.slice(0, 2).join(':'), port: parts.slice(2).join(':') };
  }
  return { base: target, port: '' };
}

/* ---------------------------------------------------------------------- */
/*  Validation / vérification                                             */
/* ---------------------------------------------------------------------- */

/**
 * Valide qu'une chaîne est un JSON de politique correct (commentaires tolérés),
 * retourne l'objet JSON parsé.
 * @param {string} text
 * @returns {object} document JSON
 */
export function validateJson(text) {
  const cleaned = stripJsonComments(text);
  let doc;
  try {
    doc = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('JSON invalide : ' + err.message);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('La politique doit être un objet JSON.');
  }
  return doc;
}
