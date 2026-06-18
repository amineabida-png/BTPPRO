/* ===================== État & utilitaires ===================== */
let token = localStorage.getItem("btp_token") || null;
let me = JSON.parse(localStorage.getItem("btp_user") || "null");
let selected = null;
const now = new Date();
const period = { mois: now.getMonth() + 1, annee: now.getFullYear() };
const MOIS = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
const fmt = (n) => (Number(n) || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const el = (id) => document.getElementById(id);
const V = () => el("view");
const opt = (arr) => arr.map((v) => ({ value: v, label: v.replace(/_/g, " ") }));
const caches = {};

let activeCompany = localStorage.getItem("btp_company") || null;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(activeCompany ? { "X-Company-Id": activeCompany } : {}), ...(opts.headers || {}) } });
  if (res.status === 401) { logout(); throw new Error("Session expirée"); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 402) { showPaywall(); throw new Error(data.error || "Abonnement expiré"); }
  if (!res.ok) throw new Error(data.error || "Erreur");
  return data;
}
async function getCache(rel) {
  if (caches[rel]) return caches[rel];
  caches[rel] = await api("/api/" + rel);
  return caches[rel];
}
function clearCache(rel) { delete caches[rel]; }
function chantierLabel(id) { const c = (caches.chantiers || []).find((x) => x.id == id); return c ? c.code : (id || ""); }
function relLabel(rel, id, key) { const o = (caches[rel] || []).find((x) => x.id == id); return o ? o[key] : (id || ""); }

/* ===================== Auth ===================== */
let pending2FA = null;
el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault(); el("login-err").textContent = "";
  const email = el("email").value, password = el("password").value;
  const codeField = el("twofa-code");
  const body = { email, password };
  if (pending2FA && codeField) body.code = codeField.value;
  try {
    const d = await api("/api/auth/login", { method: "POST", body: JSON.stringify(body) });
    if (d.require_2fa) {
      pending2FA = { email, password };
      el("login-err").textContent = "Entrez le code de votre application d'authentification.";
      if (!el("twofa-code")) {
        const inp = document.createElement("input");
        inp.id = "twofa-code"; inp.placeholder = "Code à 6 chiffres"; inp.inputMode = "numeric";
        inp.style = "margin-top:8px"; el("login-form").insertBefore(inp, el("login-err"));
      }
      return;
    }
    token = d.token; me = d.user;
    localStorage.setItem("btp_token", token); localStorage.setItem("btp_user", JSON.stringify(me));
    pending2FA = null; if (el("twofa-code")) el("twofa-code").remove();
    if (d.blocked) { showPaywall(d.subscription); return; }
    enterApp();
  } catch (err) { el("login-err").textContent = err.message; }
});
el("logout").addEventListener("click", logout);
function logout() { token = null; me = null; activeCompany = null; localStorage.clear(); el("app").classList.add("hide"); el("login").classList.remove("hide"); }
function enterApp() { el("login").classList.add("hide"); el("app").classList.remove("hide"); el("who").textContent = me ? (me.name || me.email) : ""; loadCompanies().then(loadPerms).then(() => { if (me && me.company_id) { document.querySelector('.nav[data-view="onboarding"]')?.classList.add("hide"); document.querySelector('.nav[data-view="superadmin"]')?.classList.add("hide"); } if (typeof refreshAlertBadge === "function") refreshAlertBadge(); }); }
function showPaywall(sub) {
  const prix = "30 jours : 99 DH · 1 an : 990 DH · À vie : 3990 DH";
  el("app").classList.add("hide"); el("login").classList.add("hide");
  let o = el("paywall"); if (!o) { o = document.createElement("div"); o.id = "paywall"; document.body.appendChild(o); }
  o.innerHTML = `<div class="pw-card"><div class="pw-ico">🔒</div><h2>Abonnement expiré</h2>
    <p>Votre accès à BTP360 est actuellement <b>suspendu ou expiré</b>${sub && sub.plan ? " (formule " + sub.plan + ")" : ""}.</p>
    <p>Pour réactiver votre compte, contactez votre fournisseur.</p>
    <div class="pw-prix">${prix}</div>
    <button class="btn" onclick="logout();document.getElementById('paywall').remove()">Retour à la connexion</button></div>`;
}

/* ===================== Multi-société ===================== */
async function loadCompanies() {
  try {
    const cos = await api("/api/companies");
    window._companies = cos;
    if (!activeCompany || !cos.find((c) => String(c.id) === String(activeCompany))) {
      activeCompany = cos.length ? String(cos[0].id) : null;
      if (activeCompany) localStorage.setItem("btp_company", activeCompany);
    }
    const sel = el("company-switch");
    if (sel) {
      sel.innerHTML = cos.map((c) => `<option value="${c.id}" ${String(c.id) === String(activeCompany) ? "selected" : ""}>${c.raison_sociale}</option>`).join("") +
        (me && me.role === "DIRECTEUR" ? `<option value="__new">+ Nouvelle société…</option>` : "");
    }
  } catch { /* ignore */ }
}
async function switchCompany(v) {
  if (v === "__new") {
    const d = await modalForm("Nouvelle société", [{ key: "raison_sociale", label: "Raison sociale" }, { key: "ice", label: "ICE" }]);
    if (d) { try { const c = await api("/api/companies", { method: "POST", body: JSON.stringify(d) }); activeCompany = String(c.id); localStorage.setItem("btp_company", activeCompany); } catch (e) { alert(e.message); } }
    await loadCompanies(); show("dash"); return;
  }
  activeCompany = v; localStorage.setItem("btp_company", v);
  for (const k of Object.keys(caches)) delete caches[k];
  show("dash");
}

/* ===================== 2FA ===================== */
async function open2FA() {
  const st = await api("/api/2fa/status");
  if (st.totp_enabled) {
    el("modal-root").innerHTML = `<div class="overlay"><div class="modal"><h3>Authentification à deux facteurs</h3>
      <p class="sub">La 2FA est <b>activée</b> sur votre compte.</p>
      <div class="mform"><div class="field"><label>Code actuel pour désactiver</label><input id="dis-code" placeholder="6 chiffres"></div></div>
      <div class="mactions"><button class="btn ghost" onclick="el('modal-root').innerHTML=''">Fermer</button><button class="btn danger" onclick="disable2FA()">Désactiver</button></div></div></div>`;
    return;
  }
  const s = await api("/api/2fa/setup", { method: "POST", body: "{}" });
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal"><h3>Activer la 2FA</h3>
    <p class="sub">Scannez ce QR code avec Google Authenticator / Authy, puis saisissez le code.</p>
    <div style="text-align:center"><img src="${s.qr}" alt="QR 2FA" style="width:180px;height:180px"/></div>
    <p class="muted" style="font-size:11px;word-break:break-all">Clé manuelle : ${s.secret}</p>
    <div class="mform"><div class="field"><label>Code de vérification</label><input id="act-code" placeholder="6 chiffres"></div></div>
    <div class="mactions"><button class="btn ghost" onclick="el('modal-root').innerHTML=''">Annuler</button><button class="btn" onclick="activate2FA()">Activer</button></div></div></div>`;
}
async function activate2FA() {
  try { await api("/api/2fa/activate", { method: "POST", body: JSON.stringify({ code: el("act-code").value }) }); el("modal-root").innerHTML = ""; alert("2FA activée. Elle sera demandée à la prochaine connexion."); }
  catch (e) { alert(e.message); }
}
async function disable2FA() {
  try { await api("/api/2fa/disable", { method: "POST", body: JSON.stringify({ code: el("dis-code").value }) }); el("modal-root").innerHTML = ""; alert("2FA désactivée."); }
  catch (e) { alert(e.message); }
}

const VIEW_DOMAIN = {
  dash: "dashboard", rentabilite: "rentabilite", emps: "rh", organigramme: "rh", paie: "paie", conges: "conges", runs: "paie",
  chantiers: "chantiers", incidents: "securite", documents: "ged", ouvrages: "devis", devis: "devis", factures: "facturation",
  articles: "stock", "demandes-achat": "achats", "bons-commande": "achats", fournisseurs: "tiers", clients: "tiers", "sous-traitants": "tiers",
  integrations: null, users: "admin", societe: "admin",
  planning: "chantiers", pointage: "chantiers", tresorerie: "facturation",
  materiel: "chantiers", rapports: "chantiers", alertes: null,
  compta: "rentabilite", journal: "admin", onboarding: "admin", bordereaux: "devis", superadmin: "admin",
};
let myPerms = ["*"];
function allowed(domain) { return domain == null || myPerms.includes("*") || myPerms.includes(domain); }
async function loadPerms() {
  try {
    const m = await api("/api/me");
    myPerms = m.permissions || ["*"];
    if (m.user) el("role-badge").textContent = m.user.role;
  } catch { myPerms = ["*"]; }
  document.querySelectorAll(".nav").forEach((b) => { b.style.display = allowed(VIEW_DOMAIN[b.dataset.view]) ? "" : "none"; });
  // Aller à la première vue autorisée
  const first = [...document.querySelectorAll(".nav")].find((b) => b.style.display !== "none");
  show(first ? first.dataset.view : "dash");
}

/* ===================== Navigation ===================== */
document.querySelectorAll(".nav").forEach((b) => (b.onclick = () => { show(b.dataset.view); document.getElementById("app").classList.remove("side-open"); }));
const ROUTES = {
  dash: renderDash, rentabilite: renderRentabilite, users: renderUsers, emps: renderEmps,
  organigramme: renderOrganigramme, paie: renderPaie, conges: renderConges, runs: renderRuns,
  ouvrages: renderOuvrages, devis: renderDevis, factures: renderFactures, articles: renderStock,
  "bons-commande": renderCommandes, chantiers: renderChantiers, incidents: renderSecurite,
  documents: renderGED, fournisseurs: renderFournisseurs, clients: renderClients, "sous-traitants": renderSousTraitants,
  integrations: renderIntegrations, societe: renderSociete,
  planning: renderPlanning, pointage: renderPointage, tresorerie: renderTresorerie,
  materiel: renderMateriel, rapports: renderRapports, alertes: renderAlertes,
  compta: renderCompta, journal: renderActivite, onboarding: renderOnboarding, bordereaux: renderBordereaux, superadmin: renderSuperAdmin,
};
async function show(v) {
  if (!allowed(VIEW_DOMAIN[v])) { V().innerHTML = `<div class="warn">⛔ Accès non autorisé pour votre rôle.</div>`; return; }
  document.querySelectorAll(".nav").forEach((n) => n.classList.toggle("active", n.dataset.view === v));
  window.scrollTo(0, 0);
  try {
    const fn = ROUTES[v] || (() => renderMod(v));
    await fn();
    enhanceView();
  } catch (err) { V().innerHTML = `<div class="warn">⚠️ ${err.message}</div>`; }
}

/* Recherche + tri automatiques sur toutes les listes */
function enhanceView() {
  V().querySelectorAll(".card table").forEach((table) => {
    const tbody = table.querySelector("tbody"); if (!tbody) return;
    const dataRows = () => [...tbody.rows].filter((r) => !r.querySelector("td[colspan]"));
    const toNum = (s) => { const t = s.replace(/(MAD|%|\s)/g, "").trim(); return /^-?\d+([.,]\d+)?$/.test(t) ? parseFloat(t.replace(",", ".")) : null; };
    // Tri en cliquant sur les colonnes
    const ths = [...table.querySelectorAll("thead th")];
    ths.forEach((th, i) => {
      if (!th.textContent.trim() || th.dataset.sortable) return;
      th.dataset.sortable = "1"; th.style.cursor = "pointer"; th.title = "Trier par cette colonne";
      th.addEventListener("click", () => {
        const dir = th.dataset.dir === "asc" ? "desc" : "asc";
        ths.forEach((t) => { t.dataset.dir = ""; const c = t.querySelector(".sort-caret"); if (c) c.remove(); });
        th.dataset.dir = dir;
        const rows = dataRows();
        rows.sort((a, b) => {
          const x = (a.cells[i]?.textContent || "").trim(), y = (b.cells[i]?.textContent || "").trim();
          const nx = toNum(x), ny = toNum(y);
          const r = (nx !== null && ny !== null) ? nx - ny : x.localeCompare(y, "fr", { numeric: true });
          return dir === "asc" ? r : -r;
        });
        rows.forEach((r) => tbody.appendChild(r));
        const car = document.createElement("span"); car.className = "sort-caret"; car.textContent = dir === "asc" ? " ▲" : " ▼"; th.appendChild(car);
      });
    });
    // Barre d'outils : recherche + export + impression
    const card = table.closest(".card"); if (!card || card.dataset.tooled) return;
    card.dataset.tooled = "1";
    const title = (V().querySelector("h1")?.textContent || "Liste").trim();
    const big = dataRows().length >= 6;
    const bar = document.createElement("div"); bar.className = "ltools";
    bar.innerHTML = `${big ? `<input class="tsearch-input" placeholder="🔎  Rechercher…"><span class="tcount"></span>` : ""}<span class="lspacer"></span>
      <button class="btn sm ghost xbtn" data-x="xlsx">⬇️ Excel</button>
      <button class="btn sm ghost xbtn" data-x="csv">⬇️ CSV</button>
      <button class="btn sm ghost xbtn" data-x="print">🖨️ Imprimer</button>`;
    card.insertBefore(bar, card.firstChild);
    bar.querySelector('[data-x="xlsx"]').onclick = () => exportXLSX(table, title);
    bar.querySelector('[data-x="csv"]').onclick = () => exportCSV(table, title);
    bar.querySelector('[data-x="print"]').onclick = () => window.print();
    const input = bar.querySelector(".tsearch-input");
    if (input) {
      const count = bar.querySelector(".tcount");
      input.addEventListener("input", () => {
        const q = input.value.toLowerCase().trim(); let n = 0;
        dataRows().forEach((r) => { const m = r.textContent.toLowerCase().includes(q); r.style.display = m ? "" : "none"; if (m) n++; });
        count.textContent = q ? `${n} résultat${n > 1 ? "s" : ""}` : "";
      });
    }
  });
}

/* Extraction + export des listes */
function extractTable(table) {
  const ths = [...table.querySelectorAll("thead th")];
  const keep = ths.map((th) => th.textContent.trim() !== "");
  const headers = ths.filter((_, i) => keep[i]).map((th) => th.textContent.trim());
  const rows = [...table.querySelectorAll("tbody tr")].filter((tr) => !tr.querySelector("td[colspan]"))
    .map((tr) => [...tr.cells].filter((_, i) => keep[i]).map((td) => td.textContent.trim().replace(/\s+/g, " ")));
  return { headers, rows };
}
function exportCSV(table, title) {
  const { headers, rows } = extractTable(table);
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [headers.map(esc).join(";"), ...rows.map((r) => r.map(esc).join(";"))].join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = (title || "liste").replace(/[^\w-]+/g, "_") + ".csv"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
async function exportXLSX(table, title) {
  const { headers, rows } = extractTable(table);
  try {
    const res = await fetch("/api/export/xlsx", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, "X-Company-Id": activeCompany || "" }, body: JSON.stringify({ title, headers, rows }) });
    if (!res.ok) { alert("Erreur lors de l'export Excel"); return; }
    const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = (title || "liste").replace(/[^\w-]+/g, "_") + ".xlsx"; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}

/* ===================== Modale générique ===================== */
function modalForm(title, fields, initial = {}) {
  return new Promise(async (resolve) => {
    for (const f of fields) if (f.rel) f.options = (await getCache(f.rel)).map((o) => ({ value: o.id, label: o.code ? `${o.code} — ${o.nom}` : (o.raison_sociale || o.designation || o.matricule + " " + o.nom || o.id) }));
    const inputs = fields.map((f) => {
      const val = initial[f.key] ?? "";
      if (f.type === "select") return `<div class="field"><label>${f.label}</label><select data-k="${f.key}">${(f.options || []).map((o) => `<option value="${o.value}" ${val == o.value ? "selected" : ""}>${o.label}</option>`).join("")}</select></div>`;
      return `<div class="field"><label>${f.label}</label><input data-k="${f.key}" type="${f.type || "text"}" value="${val}"></div>`;
    }).join("");
    el("modal-root").innerHTML = `<div class="overlay"><div class="modal"><h3>${title}</h3><div class="mform">${inputs}</div>
      <div class="mactions"><button class="btn ghost" id="m-cancel">Annuler</button><button class="btn" id="m-ok">Enregistrer</button></div></div></div>`;
    const close = (r) => { el("modal-root").innerHTML = ""; resolve(r); };
    el("m-cancel").onclick = () => close(null);
    el("m-ok").onclick = () => {
      const out = {}; document.querySelectorAll("#modal-root [data-k]").forEach((i) => { if (i.value !== "") out[i.dataset.k] = i.value; });
      close(out);
    };
  });
}

/* ===================== Édition générique ===================== */
function rhDocs(id, mat) {
  const b = (path, lbl, file) => `<button class="btn ghost" style="justify-content:flex-start" onclick="downloadDoc('/api/employees/${id}/${path}/pdf','${file}-${mat || id}.pdf')">📄 ${lbl}</button>`;
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal"><h3>Documents RH</h3>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${b("attestation-travail", "Attestation de travail", "attestation-travail")}
      ${b("attestation-salaire", "Attestation de salaire", "attestation-salaire")}
      ${b("solde-tout-compte", "Reçu pour solde de tout compte", "solde-tout-compte")}
    </div>
    <div class="mactions"><button class="btn ghost" onclick="el('modal-root').innerHTML=''">Fermer</button></div>
    </div></div>`;
}
async function editEntity(ep, fields, obj, after) {
  const init = {}; fields.forEach((f) => { if (obj[f.key] != null) init[f.key] = obj[f.key]; });
  const d = await modalForm("Modifier la fiche", fields, init);
  if (!d) return;
  try { await api(ep + "/" + obj.id, { method: "PUT", body: JSON.stringify(d) }); after && after(); }
  catch (e) { alert(e.message); }
}
function findCached(key, id) { return (caches[key] || []).find((x) => x.id === id); }
function editEmp(id) { const o = findCached("employees", id); if (o) editEntity("/api/employees", [{ key: "nom", label: "Nom" }, { key: "poste", label: "Poste" }, { key: "cin", label: "CIN" }, { key: "cnss", label: "N° CNSS" }, { key: "mois_anciennete", label: "Ancienneté (mois)", type: "number" }, { key: "personnes_charge", label: "Personnes à charge", type: "number" }], o, () => { clearCache("employees"); renderEmps(); }); }
function editChantier(id) { const o = findCached("chantiers", id); if (o) editEntity("/api/chantiers", [{ key: "code", label: "Code" }, { key: "nom", label: "Nom" }, { key: "client", label: "Client" }, { key: "ville", label: "Ville" }, { key: "budget_prevu", label: "Budget prévu", type: "number" }, { key: "statut", label: "Statut", type: "select", options: opt(["prospect", "en_cours", "suspendu", "clos"]) }], o, () => { clearCache("chantiers"); renderChantiers(); }); }
function editArticle(id) { const o = findCached("articles", id); if (o) editEntity("/api/articles", [{ key: "reference", label: "Référence" }, { key: "designation", label: "Désignation" }, { key: "unite", label: "Unité" }, { key: "seuil", label: "Seuil d'alerte", type: "number" }], o, () => renderStock()); }
function editFournisseur(id) { const o = findCached("fournisseurs", id); if (o) editEntity("/api/fournisseurs", [{ key: "raison_sociale", label: "Raison sociale" }, { key: "ice", label: "ICE" }, { key: "contact", label: "Contact" }, { key: "telephone", label: "Téléphone" }, { key: "email", label: "Email" }, { key: "conditions_paiement", label: "Conditions de paiement" }], o, () => renderFournisseurs()); }
function editST(id) { const o = findCached("sous-traitants", id); if (o) editEntity("/api/sous-traitants", [{ key: "raison_sociale", label: "Raison sociale" }, { key: "specialite", label: "Spécialité" }, { key: "contact", label: "Contact" }, { key: "telephone", label: "Téléphone" }], o, () => renderSousTraitants()); }
function editMod(key, id) { const m = MOD[key]; const o = (caches["mod:" + key] || []).find((x) => x.id === id); if (o) editEntity(m.ep, m.fields, o, () => { if (m.cache) clearCache(m.cache); renderMod(key); }); }
function companyName() { const c = (window._companies || []).find((x) => String(x.id) === String(activeCompany)); return c ? c.raison_sociale : "Société"; }
async function renderDash() {
  const d = await api("/api/dashboard");
  const card = (lbl, val, unit, cls, ic) => `<div class="card kpi ${cls || ""}"><span class="ic">${ic || ""}</span><div class="lbl">${lbl}</div><div class="val mono">${val} <small>${unit || ""}</small></div></div>`;
  const money = [
    card("Effectif", d.effectif, "", "flat", "👷"),
    card("Masse salariale brute", fmt(d.masse_brute), "MAD", "", "💰"),
    card("Net à payer", fmt(d.net_total), "MAD", "ok", "🧾"),
    card("Coût employeur", fmt(d.cout_total), "MAD", "", "🏛️"),
  ];
  const op = [
    card("Chantiers actifs", d.chantiers_actifs, "", "flat", "🏗️"),
    card("Devis en cours", d.devis_en_cours, "", "flat", "📝"),
    card("CA facturé", fmt(d.ca_facture), "MAD", "ok", "💶"),
    card("Congés en attente", d.conges_attente, "", d.conges_attente > 0 ? "warn" : "flat", "🌴"),
    card("Alertes stock", d.stock_alertes, "", d.stock_alertes > 0 ? "alert" : "ok", "📦"),
    card("Incidents ouverts", d.incidents_ouverts, "", d.incidents_ouverts > 0 ? "alert" : "ok", "⛑️"),
  ];
  // Structure de la masse salariale (mini-barres)
  const maxv = Math.max(d.cout_total, d.masse_brute, d.net_total, 1);
  const bar = (lbl, v, color) => `<div class="mrow"><div class="ml">${lbl}</div><div class="mtrack"><div class="mfill" style="width:${(v / maxv * 100).toFixed(1)}%;background:${color}">${fmt(v)}</div></div></div>`;
  const tile = (v, ic, tt, ts) => `<button class="tile" onclick="show('${v}')"><span class="ti">${ic}</span><span class="tt">${tt}</span><span class="ts">${ts}</span></button>`;

  V().innerHTML = `
    <div class="hero"><div class="co">${companyName()}</div><h1>Tableau de bord</h1>
      <div class="per">Exercice ${period.annee} · ${MOIS[period.mois - 1]}</div></div>
    <div class="grid kpis">${money.join("")}</div>
    <div class="grid kpis" style="margin-top:14px">${op.join("")}</div>
    <div class="card" style="margin-top:18px"><div class="colhead">Structure de la masse salariale (mensuelle)</div>
      <div class="mbars">
        ${bar("Brut imposable", d.masse_brute, "var(--steel)")}
        ${bar("Net à payer", d.net_total, "var(--green)")}
        ${bar("Coût employeur", d.cout_total, "var(--hazard)")}
      </div>
      <div class="muted" style="margin-top:10px;font-size:12px">Charges patronales ≈ ${fmt(d.cout_total - d.masse_brute)} MAD · soit ${d.masse_brute > 0 ? Math.round((d.cout_total - d.masse_brute) / d.masse_brute * 100) : 0} % du brut</div>
    </div>
    <div style="margin-top:18px"><div class="colhead">Accès rapides</div>
      <div class="tiles">
        ${tile("paie", "🧾", "Lancer la paie", "Générer les bulletins du mois")}
        ${tile("devis", "📝", "Nouveau devis", "Déboursé, marge, prix de vente")}
        ${tile("chantiers", "🏗️", "Chantiers", "Budget réel vs prévu")}
        ${tile("rentabilite", "📈", "Rentabilité", "Marge par chantier")}
      </div>
    </div>`;
}

/* ===================== Rentabilité ===================== */
async function renderRentabilite() {
  const d = await api("/api/dashboard/rentabilite");
  const g = d.global;
  const kpis = [
    ["CA facturé (HT)", fmt(g.ca_facture), "MAD"],
    ["Marge brute chantiers", fmt(g.marge_brute_chantiers), "MAD", g.marge_brute_chantiers >= 0],
    ["Coût réel chantiers", fmt(g.total_cout_reel), "MAD"],
    ["Masse salariale brute", fmt(g.masse_brute), "MAD"],
    ["Coût employeur", fmt(g.cout_employeur), "MAD"],
    ["Marge prévue (devis)", fmt(g.marge_devis), "MAD"],
    ["Valeur du stock", fmt(g.valeur_stock), "MAD"],
    ["Budget chantiers prévu", fmt(g.total_budget_prevu), "MAD"],
  ];
  // Graphique CA vs coût réel par chantier (barres CSS)
  const max = Math.max(1, ...d.chantiers.map((c) => Math.max(c.ca_facture, c.cout_reel)));
  const bars = d.chantiers.map((c) => `
    <div class="chrow">
      <div class="chlbl">${c.code}<div class="muted" style="font-size:11px">${c.nom}</div></div>
      <div class="chbars">
        <div class="chbar"><div class="fill ca" style="width:${(c.ca_facture / max * 100).toFixed(1)}%"></div><span class="chval mono">CA ${fmt(c.ca_facture)}</span></div>
        <div class="chbar"><div class="fill cost" style="width:${(c.cout_reel / max * 100).toFixed(1)}%"></div><span class="chval mono">Coût ${fmt(c.cout_reel)}</span></div>
      </div>
    </div>`).join("");

  V().innerHTML = `<h1>Rentabilité</h1><div class="sub">Consolidation : devis, chantiers, paie, facturation, stock.</div>
    <div class="grid kpis" style="grid-template-columns:repeat(4,1fr)">
      ${kpis.map(([l, v, u, pos]) => `<div class="card kpi"><div class="lbl">${l}</div><div class="val mono" ${pos === false ? 'style="color:var(--rose)"' : pos === true ? 'style="color:var(--green)"' : ""}>${v} <small>${u}</small></div></div>`).join("")}
    </div>
    <div class="card" style="margin-top:16px"><div class="colhead">CA facturé vs coût réel par chantier</div>
      ${d.chantiers.length ? `<div class="chart">${bars}</div>
      <div style="display:flex;gap:16px;margin-top:8px;font-size:12px"><span><span class="dot ca"></span> CA facturé</span><span><span class="dot cost"></span> Coût réel</span></div>` : `<div class="muted">Aucun chantier.</div>`}
    </div>
    <div class="card" style="margin-top:16px"><div class="colhead">Rentabilité par chantier</div>
      <table><thead><tr><th>Code</th><th>Nom</th><th>Statut</th><th class="r">Budget prévu</th><th class="r">Coût réel</th><th class="r">CA facturé</th><th class="r">Marge</th><th class="r">Taux</th></tr></thead><tbody>
      ${d.chantiers.map((c) => `<tr><td class="mono">${c.code}</td><td class="row" onclick="budgetChantier2('${c.code}')">${c.nom}</td><td><span class="pill">${c.statut}</span></td><td class="r mono">${fmt(c.budget_prevu)}</td><td class="r mono">${fmt(c.cout_reel)}</td><td class="r mono">${fmt(c.ca_facture)}</td><td class="r mono ${c.marge < 0 ? "neg" : ""}" style="${c.marge >= 0 ? "color:var(--green)" : ""}">${fmt(c.marge)}</td><td class="r mono">${c.taux_marge == null ? "—" : c.taux_marge + " %"}</td></tr>`).join("")}
      </tbody></table>
    </div>
    <p class="muted" style="margin-top:10px">Marge brute chantier = CA facturé − coût réel (main d'œuvre allouée + matériaux reçus + sous-traitance + dépenses directes). Indicatif.</p>`;
}
async function budgetChantier2(code) { if (!caches.chantiers) caches.chantiers = await api("/api/chantiers"); const c = caches.chantiers.find((x) => x.code === code); if (c) budgetChantier(c.id); }

async function renderEmps() {
  const emps = await api("/api/employees"); caches.employees = emps;
  if (!selected && emps.length) selected = emps[0].id;
  V().innerHTML = `<div class="bar"><div><h1>Salariés</h1><div class="sub">Fiche complète, contrats, paie. Le contrat actif pilote le salaire.</div></div>
    <button class="btn sm" onclick="addEmp()">+ Ajouter</button></div>
    <div class="card"><table><thead><tr><th>Matricule</th><th>Salarié</th><th>Poste</th><th>Contrat</th><th class="r">Ancienneté</th><th class="r">Salaire</th><th class="r">Net</th><th></th></tr></thead><tbody>
    ${emps.map((e) => { const a = Math.floor(e.mois_anciennete / 12); return `<tr><td class="mono">${e.matricule}</td><td class="row" onclick="fiche(${e.id})">${e.nom}</td><td><span class="pill">${e.poste || ""}</span></td><td>${e.contrat_type ? `<span class="pill">${e.contrat_type}</span>` : ""}</td><td class="r">${a} an${a > 1 ? "s" : ""}</td><td class="r mono">${fmt(e.salaire_effectif || e.salaire_base)}</td><td class="r mono">${fmt(e.paie.netAPayer)}</td>
      <td class="r"><button class="btn sm" onclick="fiche(${e.id})">Fiche</button> <button class="btn sm ghost" onclick="editEmp(${e.id})">✏️</button> <button class="btn sm ghost" onclick="rhDocs(${e.id},'${(e.matricule || "").replace(/'/g, "")}')">📄 Docs</button> <button class="btn sm ghost" onclick="goPaie(${e.id})">Paie</button> <button class="btn sm danger" onclick="delEmp(${e.id})">×</button></td></tr>`; }).join("")}
    </tbody></table></div>`;
}
async function addEmp() {
  const d = await modalForm("Nouveau salarié", [
    { key: "matricule", label: "Matricule" }, { key: "nom", label: "Nom complet" }, { key: "poste", label: "Poste" }, { key: "cin", label: "CIN" }, { key: "cnss", label: "N° CNSS" },
    { key: "salaire_base", label: "Salaire de base", type: "number" }, { key: "mois_anciennete", label: "Ancienneté (mois)", type: "number" }, { key: "personnes_charge", label: "Personnes à charge", type: "number" }]);
  if (!d) return;
  try { await api("/api/employees", { method: "POST", body: JSON.stringify(d) }); renderEmps(); } catch (e) { alert(e.message); }
}
async function delEmp(id) { if (confirm("Désactiver ce salarié ?")) { await api("/api/employees/" + id, { method: "DELETE" }); renderEmps(); } }
function goPaie(id) { selected = id; show("paie"); }

/* ===================== Fiche salarié ===================== */
async function fiche(id) {
  const f = await api("/api/employees/" + id + "/fiche");
  const ca = f.contrat_actif;
  const note = (n) => "★".repeat(n) + "☆".repeat(5 - n);
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>${f.nom} <span class="pill">${f.matricule}</span></h3>
    <div class="sub">${f.poste || ""}${f.manager ? " · N+1 : " + f.manager.nom : ""}${f.cin ? " · CIN " + f.cin : ""}</div>
    <div class="grid kpis" style="grid-template-columns:repeat(3,1fr);margin:10px 0">
      <div class="card kpi"><div class="lbl">Contrat actif</div><div class="val" style="font-size:18px">${ca ? ca.type : "—"}</div></div>
      <div class="card kpi"><div class="lbl">Salaire (contrat)</div><div class="val mono" style="font-size:18px">${fmt(ca ? ca.salaire_base : f.salaire_base)}</div></div>
      <div class="card kpi"><div class="lbl">Net à payer</div><div class="val mono" style="font-size:18px">${fmt(f.paie.netAPayer)}</div></div>
    </div>
    <div class="bar"><div class="colhead">Contrats (historique)</div><button class="btn sm" onclick="addContrat(${f.id})">+ Avenant / contrat</button></div>
    <table class="lines"><thead><tr><th>Type</th><th>Poste</th><th class="r">Salaire</th><th>Début</th><th>Fin</th><th>Actif</th></tr></thead><tbody>
    ${f.contrats.map((c) => `<tr><td><span class="pill">${c.type}</span></td><td>${c.poste || ""}</td><td class="r mono">${fmt(c.salaire_base)}</td><td>${(c.date_debut || "").slice(0, 10)}</td><td>${(c.date_fin || "").slice(0, 10)}</td><td>${c.actif ? "✅" : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Aucun contrat.</td></tr>`}
    </tbody></table>
    <div class="colhead" style="margin-top:12px">Affectations chantiers</div>
    <table class="lines"><tbody>${f.affectations.map((a) => `<tr><td>${a.chantier_code} — ${a.chantier_nom}</td><td>${a.role || ""}</td><td>${(a.date_debut || "").slice(0, 10)} → ${(a.date_fin || "en cours").slice(0, 10)}</td></tr>`).join("") || `<tr><td class="muted">Aucune.</td></tr>`}</tbody></table>
    <div class="bar" style="margin-top:12px"><div class="colhead">Évaluations</div><button class="btn sm ghost" onclick="addEval(${f.id})">+ Évaluation</button></div>
    <table class="lines"><tbody>${f.evaluations.map((e) => `<tr><td>${(e.date_eval || "").slice(0, 10)}</td><td>${note(e.note || 0)}</td><td>${e.evaluateur || ""}</td><td>${e.commentaire || ""}</td></tr>`).join("") || `<tr><td class="muted">Aucune évaluation.</td></tr>`}</tbody></table>
    <div class="mactions"><button class="btn" onclick="el('modal-root').innerHTML=''">Fermer</button></div></div></div>`;
}
async function addContrat(id) {
  const d = await modalForm("Nouveau contrat / avenant", [
    { key: "type", label: "Type", type: "select", options: opt(["CDI", "CDD", "essai", "anapec", "interim"]) },
    { key: "poste", label: "Poste" }, { key: "salaire_base", label: "Salaire de base", type: "number" },
    { key: "date_debut", label: "Date de début", type: "date" }, { key: "date_fin", label: "Date de fin (CDD)", type: "date" }]);
  if (!d) return;
  await api(`/api/employees/${id}/contrats`, { method: "POST", body: JSON.stringify(d) });
  clearCache("employees"); fiche(id);
}
async function addEval(id) {
  const d = await modalForm("Nouvelle évaluation", [
    { key: "note", label: "Note (1 à 5)", type: "number" }, { key: "evaluateur", label: "Évaluateur" }, { key: "commentaire", label: "Commentaire" }]);
  if (!d) return; d.employee_id = id; await api("/api/evaluations", { method: "POST", body: JSON.stringify(d) }); fiche(id);
}

/* ===================== Organigramme ===================== */
function orgNode(n) {
  return `<li><div class="org-card"><b>${n.nom}</b><div class="muted">${n.poste || ""} · ${n.matricule}</div></div>${n.equipe && n.equipe.length ? `<ul>${n.equipe.map(orgNode).join("")}</ul>` : ""}</li>`;
}
async function renderOrganigramme() {
  const tree = await api("/api/organigramme");
  V().innerHTML = `<h1>Organigramme</h1><div class="sub">Hiérarchie des équipes (N+1).</div>
    <div class="card"><ul class="org">${tree.map(orgNode).join("")}</ul></div>`;
}

/* ===================== Paie / bulletin ===================== */
async function renderPaie() {
  const emps = await api("/api/employees"); caches.employees = emps;
  const e = emps.find((x) => x.id === selected) || emps[0];
  if (!e) { V().innerHTML = "<h1>Paie</h1><div class='sub'>Aucun salarié.</div>"; return; }
  const c = await api("/api/payroll/preview", { method: "POST", body: JSON.stringify({ salaireBase: Number(e.salaire_base), moisAnciennete: e.mois_anciennete, personnesCharge: e.personnes_charge }) });
  const fpTaux = c.fraisProTaux === 0.35 ? "35 %" : "25 %", trLbl = c.trancheIR === 0 ? "exonéré" : "tranche " + Math.round(c.trancheIR * 100) + " %";
  const pick = emps.map((x) => `<option value="${x.id}" ${x.id === e.id ? "selected" : ""}>${x.matricule} — ${x.nom}</option>`).join("");
  const aco = (window._companies || []).find((x) => String(x.id) === String(activeCompany)) || {};
  V().innerHTML = `<div class="bar"><div><h1>Bulletin de paie</h1><div class="sub">${MOIS[period.mois - 1]} ${period.annee}</div></div>
    <div style="display:flex;gap:8px;align-items:center"><select id="emp-pick" onchange="selected=Number(this.value);renderPaie()">${pick}</select>
    <button class="btn sm" onclick="genRun()">Générer la paie du mois</button></div></div>
    <div class="sheet">
      <div class="sheet-head"><div><div style="font-weight:600">🏢 ${aco.raison_sociale || "Ma société"}</div><div class="t">Bulletin — ${MOIS[period.mois - 1]} ${period.annee}</div></div>
        <div style="text-align:right"><div style="font-weight:600">${e.nom}</div><div class="t mono">${e.matricule} · ${e.poste || ""}</div></div></div>
      <div class="cols">
        <div><div class="colhead">Gains</div>
          ${line("Salaire de base", fmt(c.salaireBase / 191) + " MAD/h · 191 h", c.salaireBase)}
          ${line("Prime d'ancienneté", c.tauxAnciennete > 0 ? Math.round(c.tauxAnciennete * 100) + " % · Art. 350" : "aucune (< 2 ans)", c.primeAnciennete)}
          ${line("Brut imposable", "", c.brutImposable, false, true)}</div>
        <div><div class="colhead">Retenues salarié</div>
          ${line("CNSS prestations", "4,48 % · plafond 6 000", c.cnssPrestations, true)}
          ${line("AMO", "2,26 % · sans plafond", c.amo, true)}
          ${line("Frais professionnels", fpTaux + " · abattement IR", c.fraisPro, true)}
          ${line("Revenu net imposable", "", c.revenuNetImposable, false, true)}
          ${line("IR (" + trLbl + ")", c.deductionsFamiliales > 0 ? "− " + fmt(c.deductionsFamiliales) + " charges famille" : "barème 2026", c.ir, true)}</div>
      </div>
      <div class="net"><div><div class="lbl">Net à payer</div></div><div class="fig mono">${fmt(c.netAPayer)} <span style="font-size:15px">MAD</span></div></div>
      <div class="emp"><div class="colhead">Charges patronales (≈ 21,09 %)</div>
        <div class="cols" style="padding:0;gap:0 36px">
          <div>${line("Prestations", "8,98 %", c.cotisationsEmployeur.prestations)}${line("Allocations familiales", "6,40 %", c.cotisationsEmployeur.allocations)}</div>
          <div>${line("AMO employeur", "4,11 %", c.cotisationsEmployeur.amo)}${line("Taxe formation", "1,60 %", c.cotisationsEmployeur.tfp)}</div></div>
        ${line("Coût total employeur", "", c.coutTotal, false, true)}</div>
    </div>
    ${(c.warnings || []).map((w) => `<div class="warn">⚠️ <span>${w}</span></div>`).join("")}
    <div style="margin-top:14px;text-align:right"><button class="btn ghost" onclick="window.print()">🖨️ Imprimer</button></div>`;
}
function line(lbl, basis, amt, neg, strong) {
  return `<div class="line${strong ? " strong" : ""}"><div><div>${lbl}</div>${basis ? `<div class="lbasis">${basis}</div>` : ""}</div><div class="mono${neg ? " neg" : ""}">${neg ? "− " : ""}${fmt(amt)}</div></div>`;
}
async function genRun() {
  try { const r = await api("/api/payroll/runs", { method: "POST", body: JSON.stringify(period) }); alert(`Paie générée : ${r.bulletins} bulletins · net total ${fmt(r.run.total_net)} MAD.`); show("runs"); }
  catch (e) { alert(e.message); }
}
async function renderRuns() {
  const runs = await api("/api/payroll/runs");
  V().innerHTML = `<h1>Historique des paies</h1><div class="sub">Lots générés et archivés. Ouvre un lot pour télécharger les bulletins PDF.</div>
    <div class="card"><table><thead><tr><th>Période</th><th>Statut</th><th class="r">Brut</th><th class="r">Net</th><th class="r">Coût employeur</th><th></th></tr></thead><tbody>
    ${runs.length ? runs.map((r) => `<tr><td class="row" onclick="runDetail(${r.id},'${MOIS[r.periode_mois - 1]} ${r.periode_annee}')">${MOIS[r.periode_mois - 1]} ${r.periode_annee}</td><td><span class="pill">${r.statut}</span></td><td class="r mono">${fmt(r.total_brut)}</td><td class="r mono">${fmt(r.total_net)}</td><td class="r mono">${fmt(r.total_cout)}</td><td class="r"><button class="btn sm" onclick="runDetail(${r.id},'${MOIS[r.periode_mois - 1]} ${r.periode_annee}')">Bulletins</button> <button class="btn sm ghost" onclick="runDocs(${r.id})">📄 États</button></td></tr>`).join("") : `<tr><td colspan="6" class="muted">Aucune paie générée.</td></tr>`}
    </tbody></table></div>`;
}
function runDocs(id) {
  const b = (path, lbl, file) => `<button class="btn ghost" style="justify-content:flex-start" onclick="downloadDoc('/api/payroll/runs/${id}/${path}/pdf','${file}-${id}.pdf')">📄 ${lbl}</button>`;
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal"><h3>États de paie collectifs</h3>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${b("livre", "Livre de paie (journal du mois)", "livre-paie")}
      ${b("virement", "Ordre de virement des salaires", "ordre-virement")}
      ${b("bds", "Bordereau de déclaration CNSS", "bordereau-cnss")}
    </div>
    <div class="muted" style="font-size:12px;margin-top:10px">Le bordereau CNSS est un document préparatoire à la télédéclaration Damancom.</div>
    <div class="mactions"><button class="btn ghost" onclick="el('modal-root').innerHTML=''">Fermer</button></div>
    </div></div>`;
}
async function runDetail(runId, label) {
  const ps = await api(`/api/payroll/runs/${runId}/payslips`);
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>Bulletins — ${label}</h3>
    <table class="lines"><thead><tr><th>Matricule</th><th>Salarié</th><th class="r">Net à payer</th><th></th></tr></thead><tbody>
    ${ps.map((p) => `<tr><td class="mono">${p.matricule}</td><td>${p.nom}</td><td class="r mono">${fmt(p.net)}</td><td class="r"><button class="btn sm" onclick="downloadPdf(${p.id},'${p.matricule}')">📄 PDF</button></td></tr>`).join("")}
    </tbody></table>
    <div class="mactions"><button class="btn" onclick="el('modal-root').innerHTML=''">Fermer</button></div></div></div>`;
}
async function downloadPdf(id, mat) { return downloadDoc(`/api/payslips/${id}/pdf`, `bulletin-${mat}.pdf`); }
async function downloadDoc(path, filename) {
  try {
    const res = await fetch(path, { headers: { Authorization: "Bearer " + token, "X-Company-Id": activeCompany || "" } });
    if (!res.ok) { alert("Erreur lors de la génération du PDF"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}
// Ouvre le PDF dans un nouvel onglet (aperçu/impression du vrai document, avec en-tête société, sans interface)
async function openDoc(path) {
  const w = window.open("", "_blank");
  if (w) { try { w.document.write("<!doctype html><meta charset='utf-8'><title>Document</title><body style='font-family:sans-serif;color:#555;padding:24px'>Préparation du document…</body>"); } catch (_) {} }
  try {
    const res = await fetch(path, { headers: { Authorization: "Bearer " + token, "X-Company-Id": activeCompany || "" } });
    if (!res.ok) { if (w) w.close(); alert("Erreur lors de la génération du PDF"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (w) { w.location.href = url; } else { window.location.href = url; }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { if (w) w.close(); alert(e.message); }
}

/* ===================== Utilisateurs (RBAC) ===================== */
async function renderUsers() {
  const [users, me2] = await Promise.all([api("/api/users"), api("/api/me")]);
  const roles = me2.roles || ["DIRECTEUR", "RH", "COMPTABLE", "CHEF_CHANTIER", "OUVRIER"];
  window._roles = roles;
  V().innerHTML = `<div class="bar"><div><h1>Utilisateurs</h1><div class="sub">Gestion des accès par rôle (RBAC).</div></div>
    <button class="btn sm" onclick="addUser()">+ Utilisateur</button></div>
    <div class="card"><table><thead><tr><th>Email</th><th>Nom</th><th>Rôle</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr><td>${u.email}</td><td>${u.full_name || ""}</td><td><span class="pill">${u.role}</span></td><td class="r">${u.id === me.id ? '<span class="muted">vous</span>' : `<button class="btn sm danger" onclick="delUser(${u.id})">×</button>`}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="card" style="margin-top:14px"><div class="colhead">Droits par rôle</div>
      <table class="lines"><tbody>
        <tr><td><b>DIRECTEUR</b></td><td>Tout</td></tr>
        <tr><td><b>RH</b></td><td>RH, Paie, Congés, Tableau de bord</td></tr>
        <tr><td><b>COMPTABLE</b></td><td>Devis, Facturation, Achats, Tiers, Stock, Rentabilité</td></tr>
        <tr><td><b>CHEF_CHANTIER</b></td><td>Chantiers, Sécurité, GED, Stock</td></tr>
        <tr><td><b>OUVRIER</b></td><td>Tableau de bord (consultation)</td></tr>
      </tbody></table></div>`;
}
async function addUser() {
  const d = await modalForm("Nouvel utilisateur", [
    { key: "email", label: "Email" }, { key: "full_name", label: "Nom complet" },
    { key: "password", label: "Mot de passe", type: "text" },
    { key: "role", label: "Rôle", type: "select", options: (window._roles || ["DIRECTEUR", "RH", "COMPTABLE", "CHEF_CHANTIER", "OUVRIER"]).map((r) => ({ value: r, label: r })) }]);
  if (!d) return;
  try { await api("/api/users", { method: "POST", body: JSON.stringify(d) }); renderUsers(); } catch (e) { alert(e.message); }
}
async function delUser(id) { if (confirm("Supprimer cet utilisateur ?")) { try { await api("/api/users/" + id, { method: "DELETE" }); renderUsers(); } catch (e) { alert(e.message); } } }


/* ===================== Congés ===================== */
async function renderConges() {
  const [list, soldes] = await Promise.all([api("/api/conges"), api("/api/conges/soldes")]);
  if (!caches.employees) caches.employees = await api("/api/employees");
  V().innerHTML = `<div class="bar"><div><h1>Congés</h1><div class="sub">Acquisition 1,5 j/mois (Art. 231). Validation hiérarchique + soldes.</div></div>
    <button class="btn sm" onclick="addConge()">+ Demande</button></div>
    <div class="card" style="margin-bottom:14px"><div class="colhead">Soldes congés annuels</div>
      <table><thead><tr><th>Matricule</th><th>Salarié</th><th class="r">Acquis</th><th class="r">Pris</th><th class="r">Solde</th></tr></thead><tbody>
      ${soldes.map((s) => `<tr><td class="mono">${s.matricule}</td><td>${s.nom}</td><td class="r mono">${s.acquis}</td><td class="r mono">${s.pris}</td><td class="r mono ${s.solde < 0 ? "neg" : ""}">${s.solde}</td></tr>`).join("")}
      </tbody></table></div>
    <div class="card"><table><thead><tr><th>Salarié</th><th>Type</th><th>Du</th><th>Au</th><th class="r">Jours</th><th>Statut</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((c) => `<tr><td>${relLabel("employees", c.employee_id, "nom")}</td><td><span class="pill">${c.type}</span></td><td>${c.date_debut || ""}</td><td>${c.date_fin || ""}</td><td class="r mono">${c.jours || ""}</td><td><span class="pill">${c.statut}</span></td>
      <td class="r">${c.statut === "demande" ? `<button class="btn sm" onclick="setConge(${c.id},'valide')">Valider</button> <button class="btn sm danger" onclick="setConge(${c.id},'refuse')">Refuser</button>` : ""}</td></tr>`).join("") : `<tr><td colspan="7" class="muted">Aucune demande.</td></tr>`}
    </tbody></table></div>`;
}
async function addConge() {
  const d = await modalForm("Nouvelle demande de congé", [
    { key: "employee_id", label: "Salarié", type: "select", rel: "employees" },
    { key: "type", label: "Type", type: "select", options: opt(["annuel", "maladie", "maternite", "paternite", "exceptionnel"]) },
    { key: "date_debut", label: "Du", type: "date" }, { key: "date_fin", label: "Au", type: "date" },
    { key: "jours", label: "Jours", type: "number" }, { key: "motif", label: "Motif" }]);
  if (!d) return; await api("/api/conges", { method: "POST", body: JSON.stringify(d) }); renderConges();
}
async function setConge(id, statut) { await api(`/api/conges/${id}/statut`, { method: "POST", body: JSON.stringify({ statut }) }); renderConges(); }

/* ===================== Bibliothèque d'ouvrages (sous-détails de prix) ===================== */
async function renderOuvrages() {
  const list = await api("/api/ouvrages");
  V().innerHTML = `<div class="bar"><div><h1>Bibliothèque de prix</h1><div class="sub">Ouvrages et sous-détails (déboursé sec : main d'œuvre + matériaux + matériel).</div></div>
    <button class="btn sm" onclick="addOuvrage()">+ Ouvrage</button></div>
    <div class="card"><table><thead><tr><th>Code</th><th>Désignation</th><th>Unité</th><th class="r">Déboursé sec</th><th></th></tr></thead><tbody>
    ${list.map((o) => `<tr><td class="mono">${o.code}</td><td class="row" onclick="viewOuvrage(${o.id})">${o.designation}</td><td>${o.unite}</td><td class="r mono">${fmt(o.debourse_sec)}</td><td class="r"><button class="btn sm" onclick="viewOuvrage(${o.id})">Détail</button> <button class="btn sm danger" onclick="delOuvrage(${o.id})">×</button></td></tr>`).join("")}
    </tbody></table></div>`;
}
async function viewOuvrage(id) {
  const o = await api("/api/ouvrages/" + id);
  const T = { main_oeuvre: "Main d'œuvre", materiau: "Matériau", materiel: "Matériel" };
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>${o.code} — ${o.designation}</h3>
    <div class="sub">Sous-détail de prix · unité : ${o.unite}</div>
    <table class="lines"><thead><tr><th>Type</th><th>Désignation</th><th class="r">Qté</th><th class="r">P.U.</th><th class="r">Montant</th></tr></thead><tbody>
    ${o.composants.map((c) => `<tr><td><span class="pill">${T[c.type] || c.type}</span></td><td>${c.designation}</td><td class="r mono">${c.quantite}</td><td class="r mono">${fmt(c.prix_unitaire)}</td><td class="r mono">${fmt(Number(c.quantite) * Number(c.prix_unitaire))}</td></tr>`).join("")}
    </tbody></table>
    <div class="totaux"><div><b>Déboursé sec <span class="mono">${fmt(o.debourse_sec)} MAD/${o.unite}</span></b></div></div>
    <div class="mactions"><button class="btn" onclick="el('modal-root').innerHTML=''">Fermer</button></div></div></div>`;
}
async function addOuvrage() {
  const h = await modalForm("Nouvel ouvrage", [{ key: "code", label: "Code" }, { key: "designation", label: "Désignation" }, { key: "unite", label: "Unité" }]);
  if (!h) return;
  const o = await api("/api/ouvrages", { method: "POST", body: JSON.stringify(h) });
  // ajouter des composants
  let more = true;
  while (more) {
    const c = await modalForm("Composant de " + o.code + " (Annuler pour terminer)", [
      { key: "type", label: "Type", type: "select", options: opt(["main_oeuvre", "materiau", "materiel"]) },
      { key: "designation", label: "Désignation" }, { key: "unite", label: "Unité" },
      { key: "quantite", label: "Quantité", type: "number" }, { key: "prix_unitaire", label: "Prix unitaire", type: "number" }]);
    if (!c) more = false; else await api(`/api/ouvrages/${o.id}/composants`, { method: "POST", body: JSON.stringify(c) });
  }
  renderOuvrages();
}
async function delOuvrage(id) { if (confirm("Supprimer cet ouvrage ?")) { await api("/api/ouvrages/" + id, { method: "DELETE" }); renderOuvrages(); } }

/* ===================== Devis (déboursé → marge → prix de vente) ===================== */
let devisLignes = [];
let ouvragesCache = [];
let devisFiltre = "";
function bordereauDialog() {
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal"><h3>Bordereau des prix — modèle vierge</h3>
    <div class="form" style="grid-template-columns:1fr 1fr">
      <div class="field"><label>Nombre de chapitres</label><input type="number" id="bd-ch" value="3" min="1" max="20"></div>
      <div class="field"><label>Lignes par chapitre</label><input type="number" id="bd-li" value="14" min="1" max="50"></div>
    </div>
    <div class="muted" style="font-size:12px;margin-top:8px">Chaque chapitre est généré complet : titre (à renommer), lignes vides à remplir et <b>sous-total automatique</b>. Les totaux HT / TVA 20 % / TTC se calculent seuls.</div>
    <div class="mactions"><button class="btn ghost" onclick="el('modal-root').innerHTML=''">Annuler</button><button class="btn" onclick="genBordereau()">⬇️ Télécharger</button></div>
  </div></div>`;
}
function genBordereau() {
  const ch = Math.min(Math.max(parseInt(el("bd-ch").value, 10) || 2, 1), 20);
  const li = Math.min(Math.max(parseInt(el("bd-li").value, 10) || 14, 1), 50);
  downloadDoc(`/api/bordereau/template?chapitres=${ch}&lignes=${li}`, "bordereau-prix-vierge.xlsx");
  el("modal-root").innerHTML = "";
}
async function renderDevis() {
  const all = await api("/api/devis");
  const list = devisFiltre ? all.filter((d) => (d.statut || "brouillon") === devisFiltre) : all;
  const stOpt = (cur) => ["brouillon", "envoye", "accepte", "refuse", "facture"].map((s) => `<option value="${s}" ${cur === s ? "selected" : ""}>${s}</option>`).join("");
  V().innerHTML = `<div class="bar"><div><h1>Devis</h1><div class="sub">Déboursé sec · coefficient de marge · prix de vente · TVA 20 %.</div></div>
    <div style="display:flex;gap:8px;align-items:center"><select onchange="devisFiltre=this.value;renderDevis()"><option value="">Tous les statuts</option>${["brouillon", "envoye", "accepte", "refuse", "facture"].map((s) => `<option value="${s}" ${devisFiltre === s ? "selected" : ""}>${s}</option>`).join("")}</select>
    <button class="btn sm ghost" onclick="bordereauDialog()">📋 Bordereau vierge</button>
    <button class="btn sm" onclick="newDevis()">+ Nouveau devis</button></div></div>
    <div class="card"><table><thead><tr><th>N°</th><th>Client</th><th>Objet</th><th class="r">TTC</th><th>Statut</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((d) => `<tr><td class="mono">${d.numero || d.id}</td><td>${d.client || ""}</td><td>${d.objet || ""}</td><td class="r mono">${fmt(d.total_ttc)}</td>
      <td><select class="stsel" onchange="setDevisStatut(${d.id},this.value)">${stOpt(d.statut || "brouillon")}</select></td>
      <td class="r"><button class="btn sm ghost" onclick="downloadDoc('/api/devis/${d.id}/pdf','devis-${d.numero || d.id}.pdf')">📄</button> ${d.statut !== "facture" ? `<button class="btn sm" onclick="facturerDevis(${d.id})">Facturer</button>` : ""} <button class="btn sm ghost" onclick="situationFrom(${d.id})">Situation</button> <button class="btn sm ghost" onclick="acompteFrom(${d.id})">Acompte</button> <button class="btn sm danger" onclick="delDevis(${d.id})">×</button></td></tr>`).join("") : `<tr><td colspan="6" class="muted">Aucun devis.</td></tr>`}
    </tbody></table></div>`;
}
async function setDevisStatut(id, statut) { try { await api("/api/devis/" + id, { method: "PUT", body: JSON.stringify({ statut }) }); } catch (e) { alert(e.message); } }
async function facturerDevis(id) {
  if (!confirm("Convertir ce devis en facture ?")) return;
  try { const f = await api("/api/devis/" + id + "/facturer", { method: "POST" }); await downloadDoc("/api/factures/" + f.id + "/pdf", "facture-" + (f.numero || f.id) + ".pdf"); alert("Facture " + (f.numero || "") + " créée."); renderDevis(); }
  catch (e) { alert(e.message); }
}
async function newDevis() {
  ouvragesCache = await api("/api/ouvrages");
  devisLignes = [{ ouvrage_id: "", designation: "", quantite: 1, debourse_unitaire: 0, coef_marge: 1.2 }];
  drawDevisModal();
}
function ligneCalc(l) {
  const du = Number(l.debourse_unitaire) || 0, coef = Number(l.coef_marge) || 1, q = Number(l.quantite) || 0;
  const pv = du * coef; return { pv, pvTotal: pv * q, debTotal: du * q };
}
function drawDevisModal() {
  let deb = 0, ht = 0;
  devisLignes.forEach((l) => { const c = ligneCalc(l); deb += c.debTotal; ht += c.pvTotal; });
  const marge = ht - deb, tva = ht * 0.2, ttc = ht + tva;
  const ouvOpts = (id) => `<option value="">— libre —</option>` + ouvragesCache.map((o) => `<option value="${o.id}" ${id == o.id ? "selected" : ""}>${o.code} — ${o.designation}</option>`).join("");
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>Nouveau devis</h3>
    <div class="mform"><div class="field"><label>N° (vide = automatique)</label><input id="d-num" placeholder="Automatique"></div>
      <div class="field"><label>Client</label><input id="d-cli"></div>
      <div class="field"><label>ICE client (B2B)</label><input id="d-ice" placeholder="15 chiffres"></div>
      <div class="field" style="grid-column:1/-1"><label>Objet</label><input id="d-obj"></div></div>
    <div class="colhead" style="margin-top:8px">Lignes (déboursé → ×marge → prix de vente)</div>
    <table class="lines"><thead><tr><th>Ouvrage</th><th>Désignation</th><th class="r">Qté</th><th class="r">Déboursé U.</th><th class="r">×Marge</th><th class="r">P.V.</th><th class="r">Total HT</th><th></th></tr></thead><tbody>
    ${devisLignes.map((l, i) => { const c = ligneCalc(l); return `<tr>
      <td><select style="width:130px" onchange="pickOuvrage(${i},this.value)">${ouvOpts(l.ouvrage_id)}</select></td>
      <td><input style="width:140px" value="${l.designation}" oninput="updL(${i},'designation',this.value)"></td>
      <td class="r"><input type="number" style="width:60px" value="${l.quantite}" oninput="updL(${i},'quantite',this.value)"></td>
      <td class="r"><input type="number" style="width:80px" value="${l.debourse_unitaire}" oninput="updL(${i},'debourse_unitaire',this.value)"></td>
      <td class="r"><input type="number" step="0.05" style="width:60px" value="${l.coef_marge}" oninput="updL(${i},'coef_marge',this.value)"></td>
      <td class="r mono">${fmt(c.pv)}</td><td class="r mono">${fmt(c.pvTotal)}</td>
      <td class="r"><button class="btn sm danger" onclick="rmLigne(${i})">×</button></td></tr>`; }).join("")}
    </tbody></table>
    <button class="btn sm ghost" onclick="addLigne()">+ Ligne</button>
    <div class="totaux"><div>Déboursé <span class="mono">${fmt(deb)}</span></div><div>Marge <span class="mono">${fmt(marge)}</span></div><div>HT <span class="mono">${fmt(ht)}</span></div><div>TVA <span class="mono">${fmt(tva)}</span></div><div><b>TTC <span class="mono">${fmt(ttc)}</span></b></div></div>
    <div class="mactions"><button class="btn ghost" onclick="el('modal-root').innerHTML=''">Annuler</button><button class="btn" onclick="saveDevis()">Enregistrer</button></div>
    </div></div>`;
}
function updL(i, k, v) { devisLignes[i][k] = v; if (k !== "designation") drawDevisModal(); }
function pickOuvrage(i, id) {
  const o = ouvragesCache.find((x) => x.id == id);
  if (o) { devisLignes[i].ouvrage_id = id; devisLignes[i].designation = o.designation; devisLignes[i].debourse_unitaire = o.debourse_sec; }
  else devisLignes[i].ouvrage_id = "";
  drawDevisModal();
}
function addLigne() { devisLignes.push({ ouvrage_id: "", designation: "", quantite: 1, debourse_unitaire: 0, coef_marge: 1.2 }); drawDevisModal(); }
function rmLigne(i) { devisLignes.splice(i, 1); drawDevisModal(); }
async function saveDevis() {
  const body = { numero: el("d-num").value, client: el("d-cli").value, client_ice: el("d-ice").value, objet: el("d-obj").value, lignes: devisLignes };
  await api("/api/devis/deep", { method: "POST", body: JSON.stringify(body) }); el("modal-root").innerHTML = ""; renderDevis();
}
async function delDevis(id) { if (confirm("Supprimer ce devis ?")) { await api("/api/devis/" + id, { method: "DELETE" }); renderDevis(); } }
async function acompteFrom(id) {
  const pct = prompt("Pourcentage d'acompte sur le devis (%) :", "30"); if (pct === null) return;
  try { const f = await api("/api/factures/acompte", { method: "POST", body: JSON.stringify({ devis_id: id, pct: Number(pct) || 30 }) }); await downloadDoc("/api/factures/" + f.id + "/pdf", "acompte-" + (f.numero || f.id) + ".pdf"); alert("Facture d'acompte " + (f.numero || "") + " créée."); }
  catch (e) { alert(e.message); }
}
async function avoirFrom(id) {
  const motif = prompt("Motif de l'avoir :", "Annulation / correction"); if (motif === null) return;
  try { const f = await api("/api/factures/avoir", { method: "POST", body: JSON.stringify({ facture_id: id, motif }) }); await downloadDoc("/api/factures/" + f.id + "/pdf", "avoir-" + (f.numero || f.id) + ".pdf"); renderFactures(); }
  catch (e) { alert(e.message); }
}

/* ===================== Facturation (situations + retenue de garantie) ===================== */
async function renderFactures() {
  const list = await api("/api/factures");
  V().innerHTML = `<div class="bar"><div><h1>Factures &amp; situations</h1><div class="sub">Situations de travaux (avancement), retenue de garantie, net à payer.</div></div>
    <button class="btn sm" onclick="situationFrom()">+ Situation</button></div>
    <div class="card"><table><thead><tr><th>N°</th><th>Client</th><th>Type</th><th class="r">Avanc.</th><th class="r">HT</th><th class="r">TTC</th><th class="r">RG</th><th class="r">Net à payer</th><th>Statut</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((f) => `<tr><td class="mono">${f.numero || f.id}</td><td>${f.client || ""}</td><td><span class="pill">${f.type}</span></td><td class="r">${f.avancement ? f.avancement + " %" : ""}</td><td class="r mono">${fmt(f.montant_ht)}</td><td class="r mono">${fmt(f.montant_ttc)}</td><td class="r mono">${fmt(f.retenue_garantie)}</td><td class="r mono">${fmt(f.net_a_payer || f.montant_ttc)}</td><td><span class="pill">${f.statut}</span></td><td class="r"><button class="btn sm ghost" onclick="downloadDoc('/api/factures/${f.id}/pdf','${f.type}-${f.numero || f.id}.pdf')">📄 PDF</button> ${f.type !== "avoir" ? `<button class="btn sm ghost" onclick="avoirFrom(${f.id})">Avoir</button>` : ""} <button class="btn sm danger" onclick="delFacture(${f.id})">×</button></td></tr>`).join("") : `<tr><td colspan="10" class="muted">Aucune facture.</td></tr>`}
    </tbody></table></div>`;
}
async function situationFrom(devisId) {
  const devs = await api("/api/devis");
  if (!devs.length) { alert("Crée d'abord un devis."); return; }
  const d = await modalForm("Nouvelle situation de travaux", [
    { key: "devis_id", label: "Devis", type: "select", options: devs.map((x) => ({ value: x.id, label: `${x.numero || x.id} — ${x.client || ""} (HT ${fmt(x.total_ht)})` })) },
    { key: "avancement", label: "Avancement cumulé (%)", type: "number" },
    { key: "rg_taux", label: "Retenue de garantie (%)", type: "number" }], devisId ? { devis_id: devisId } : {});
  if (!d) return;
  try { await api("/api/factures/situation", { method: "POST", body: JSON.stringify(d) }); show("factures"); }
  catch (e) { alert(e.message); }
}
async function delFacture(id) { if (confirm("Supprimer ?")) { await api("/api/factures/" + id, { method: "DELETE" }); renderFactures(); } }

/* ===================== Stock (valorisation CMUP) ===================== */
async function renderStock() {
  const v = await api("/api/stock/valorisation");
  caches.articles = v.articles;
  V().innerHTML = `<div class="bar"><div><h1>Stock</h1><div class="sub">Valorisation au CMUP (coût moyen unitaire pondéré).</div></div>
    <div style="display:flex;gap:8px;align-items:center"><div class="pill">Valeur totale : <b class="mono">${fmt(v.total)} MAD</b></div><button class="btn sm" onclick="addArticle()">+ Article</button></div></div>
    <div class="card"><table><thead><tr><th>Référence</th><th>Désignation</th><th class="r">Stock</th><th class="r">Seuil</th><th class="r">CMUP</th><th class="r">Valeur</th><th></th></tr></thead><tbody>
    ${v.articles.map((a) => `<tr><td class="mono">${a.reference}</td><td>${a.designation}</td><td class="r mono ${Number(a.stock) < Number(a.seuil) ? "neg" : ""}">${fmt(a.stock)} ${a.unite}</td><td class="r mono">${fmt(a.seuil)}</td><td class="r mono">${fmt(a.cmup)}</td><td class="r mono">${fmt(a.valeur)}</td>
      <td class="r"><button class="btn sm" onclick="mvtStock(${a.id})">Mouvement</button> <button class="btn sm ghost" onclick="inventaire(${a.id},${a.stock})">Inventaire</button> <button class="btn sm ghost" onclick="editArticle(${a.id})">✏️</button></td></tr>`).join("")}
    </tbody></table></div>`;
}
async function addArticle() {
  const d = await modalForm("Nouvel article", [{ key: "reference", label: "Référence" }, { key: "designation", label: "Désignation" }, { key: "unite", label: "Unité" }, { key: "stock", label: "Stock initial", type: "number" }, { key: "seuil", label: "Seuil d'alerte", type: "number" }, { key: "prix_unitaire", label: "Prix unitaire (CMUP initial)", type: "number" }]);
  if (!d) return; if (d.prix_unitaire) d.cmup = d.prix_unitaire; await api("/api/articles", { method: "POST", body: JSON.stringify(d) }); renderStock();
}
async function mvtStock(id) {
  const d = await modalForm("Mouvement de stock", [{ key: "type", label: "Type", type: "select", options: opt(["entree", "sortie"]) }, { key: "quantite", label: "Quantité", type: "number" }, { key: "prix_unitaire", label: "Prix d'achat (si entrée)", type: "number" }, { key: "motif", label: "Motif" }]);
  if (!d) return; await api("/api/stock/mouvements", { method: "POST", body: JSON.stringify({ article_id: id, ...d }) }); renderStock();
}
async function inventaire(id, stockActuel) {
  const d = await modalForm("Inventaire (stock physique compté)", [{ key: "quantite_comptee", label: `Quantité réelle (théorique : ${stockActuel})`, type: "number" }]);
  if (!d) return; await api("/api/stock/inventaire", { method: "POST", body: JSON.stringify({ article_id: id, ...d }) }); renderStock();
}

/* ===================== Achats : commandes + réception ===================== */
let cmdLignes = [];
async function renderCommandes() {
  const list = await api("/api/commandes");
  V().innerHTML = `<div class="bar"><div><h1>Bons de commande</h1><div class="sub">Réception → entrée en stock automatique (CMUP recalculé).</div></div>
    <button class="btn sm" onclick="newCommande()">+ Commande</button></div>
    <div class="card"><table><thead><tr><th>N°</th><th>Fournisseur</th><th>Chantier</th><th class="r">Montant</th><th>Statut</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((c) => `<tr><td class="mono">${c.numero}</td><td>${c.fournisseur || ""}</td><td>${c.chantier_code || ""}</td><td class="r mono">${fmt(c.montant)}</td><td><span class="pill">${c.statut}</span></td>
      <td class="r"><button class="btn sm ghost" onclick="downloadDoc('/api/commandes/${c.id}/pdf','bon-commande-${c.numero || c.id}.pdf')">📄 BC</button> <button class="btn sm ghost" onclick="downloadDoc('/api/commandes/${c.id}/reception/pdf','bon-reception-${c.numero || c.id}.pdf')">Réception</button> ${c.statut !== "recue" ? `<button class="btn sm" onclick="recevoir(${c.id})">Réceptionner</button> ` : ""}<button class="btn sm danger" onclick="delCommande(${c.id})">×</button></td></tr>`).join("") : `<tr><td colspan="6" class="muted">Aucune commande.</td></tr>`}
    </tbody></table></div>`;
}
async function newCommande() {
  await Promise.all([getCache("fournisseurs"), getCache("chantiers"), getCache("articles")]);
  if (!caches.articles) caches.articles = await api("/api/articles");
  cmdLignes = [{ article_id: "", designation: "", quantite: 1, prix_unitaire: 0 }];
  drawCmdModal();
}
function drawCmdModal() {
  const montant = cmdLignes.reduce((s, l) => s + (Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0), 0);
  const fOpts = (caches.fournisseurs || []).map((f) => `<option value="${f.id}">${f.raison_sociale}</option>`).join("");
  const cOpts = `<option value="">— aucun —</option>` + (caches.chantiers || []).map((c) => `<option value="${c.id}">${c.code} — ${c.nom}</option>`).join("");
  const aOpts = (id) => `<option value="">— libre —</option>` + (caches.articles || []).map((a) => `<option value="${a.id}" ${id == a.id ? "selected" : ""}>${a.reference} — ${a.designation}</option>`).join("");
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>Nouveau bon de commande</h3>
    <div class="mform"><div class="field"><label>Fournisseur</label><select id="c-four">${fOpts}</select></div>
      <div class="field"><label>Chantier</label><select id="c-chan">${cOpts}</select></div></div>
    <div class="colhead" style="margin-top:8px">Lignes</div>
    <table class="lines"><thead><tr><th>Article</th><th>Désignation</th><th class="r">Qté</th><th class="r">P.U. achat</th><th class="r">Total</th><th></th></tr></thead><tbody>
    ${cmdLignes.map((l, i) => `<tr>
      <td><select style="width:150px" onchange="pickArt(${i},this.value)">${aOpts(l.article_id)}</select></td>
      <td><input style="width:130px" value="${l.designation}" oninput="updC(${i},'designation',this.value)"></td>
      <td class="r"><input type="number" style="width:60px" value="${l.quantite}" oninput="updC(${i},'quantite',this.value)"></td>
      <td class="r"><input type="number" style="width:80px" value="${l.prix_unitaire}" oninput="updC(${i},'prix_unitaire',this.value)"></td>
      <td class="r mono">${fmt((Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0))}</td>
      <td class="r"><button class="btn sm danger" onclick="rmCmd(${i})">×</button></td></tr>`).join("")}
    </tbody></table>
    <button class="btn sm ghost" onclick="addCmd()">+ Ligne</button>
    <div class="totaux"><div><b>Montant <span class="mono">${fmt(montant)}</span></b></div></div>
    <div class="mactions"><button class="btn ghost" onclick="el('modal-root').innerHTML=''">Annuler</button><button class="btn" onclick="saveCommande()">Enregistrer</button></div>
    </div></div>`;
}
function updC(i, k, v) { cmdLignes[i][k] = v; if (k !== "designation") drawCmdModal(); }
function pickArt(i, id) { const a = (caches.articles || []).find((x) => x.id == id); if (a) { cmdLignes[i].article_id = id; cmdLignes[i].designation = a.designation; cmdLignes[i].prix_unitaire = a.cmup || a.prix_unitaire; } else cmdLignes[i].article_id = ""; drawCmdModal(); }
function addCmd() { cmdLignes.push({ article_id: "", designation: "", quantite: 1, prix_unitaire: 0 }); drawCmdModal(); }
function rmCmd(i) { cmdLignes.splice(i, 1); drawCmdModal(); }
async function saveCommande() {
  const body = { fournisseur_id: el("c-four").value || null, chantier_id: el("c-chan").value || null, lignes: cmdLignes };
  await api("/api/commandes", { method: "POST", body: JSON.stringify(body) }); el("modal-root").innerHTML = ""; renderCommandes();
}
async function recevoir(id) { if (confirm("Réceptionner cette commande ? (entrée en stock)")) { await api(`/api/commandes/${id}/reception`, { method: "POST", body: "{}" }); alert("Réceptionnée — stock mis à jour."); renderCommandes(); } }
async function delCommande(id) { if (confirm("Supprimer ?")) { await api("/api/commandes/" + id, { method: "DELETE" }); renderCommandes(); } }

/* ===================== Chantiers (budget réel vs prévu) ===================== */
async function renderChantiers() {
  const list = await api("/api/chantiers"); caches.chantiers = list;
  V().innerHTML = `<div class="bar"><div><h1>Chantiers</h1><div class="sub">Budget prévu vs réel (main d'œuvre + matériaux + sous-traitance + divers).</div></div>
    <button class="btn sm" onclick="addChantier()">+ Chantier</button></div>
    <div class="card"><table><thead><tr><th>Code</th><th>Nom</th><th>Client</th><th>Ville</th><th>Statut</th><th class="r">Budget prévu</th><th></th></tr></thead><tbody>
    ${list.map((c) => `<tr><td class="mono">${c.code}</td><td>${c.nom}</td><td>${c.client || ""}</td><td>${c.ville || ""}</td><td><span class="pill">${c.statut}</span></td><td class="r mono">${fmt(c.budget_prevu)}</td>
      <td class="r"><button class="btn sm" onclick="budgetChantier(${c.id})">Budget</button> <button class="btn sm ghost" onclick="downloadDoc('/api/chantiers/${c.id}/pv/pdf','pv-${c.code || c.id}.pdf')">PV</button> <button class="btn sm ghost" onclick="downloadDoc('/api/chantiers/${c.id}/os/pdf','os-${c.code || c.id}.pdf')">OS</button> <button class="btn sm ghost" onclick="editChantier(${c.id})">✏️</button> <button class="btn sm danger" onclick="delChantier(${c.id})">×</button></td></tr>`).join("")}
    </tbody></table></div>`;
}
async function addChantier() {
  const d = await modalForm("Nouveau chantier", [{ key: "code", label: "Code" }, { key: "nom", label: "Nom" }, { key: "client", label: "Client" }, { key: "ville", label: "Ville" }, { key: "budget_prevu", label: "Budget prévu", type: "number" }, { key: "statut", label: "Statut", type: "select", options: opt(["prospect", "en_cours", "suspendu", "clos"]) }]);
  if (!d) return; await api("/api/chantiers", { method: "POST", body: JSON.stringify(d) }); clearCache("chantiers"); renderChantiers();
}
async function delChantier(id) { if (confirm("Supprimer ?")) { await api("/api/chantiers/" + id, { method: "DELETE" }); clearCache("chantiers"); renderChantiers(); } }
async function budgetChantier(id) {
  const b = await api(`/api/chantiers/${id}/budget`);
  const pct = b.pct_consomme;
  const barColor = pct == null ? "#475569" : pct > 100 ? "#be123c" : pct > 85 ? "#b45309" : "#047857";
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal"><h3>Budget — ${b.chantier.code} ${b.chantier.nom}</h3>
    <div class="line strong"><div>Budget prévu</div><div class="mono">${fmt(b.chantier.budget_prevu)}</div></div>
    <div class="colhead" style="margin-top:10px">Coûts réels</div>
    <div class="line"><div>Main d'œuvre</div><div class="mono">${fmt(b.detail.main_oeuvre)}</div></div>
    <div class="line"><div>Matériaux (commandes reçues)</div><div class="mono">${fmt(b.detail.materiaux)}</div></div>
    <div class="line"><div>Sous-traitance</div><div class="mono">${fmt(b.detail.sous_traitance)}</div></div>
    <div class="line"><div>Dépenses directes</div><div class="mono">${fmt(b.detail.depenses_directes)}</div></div>
    <div class="line strong"><div>Total réel</div><div class="mono">${fmt(b.reel)}</div></div>
    <div class="line strong"><div>Écart</div><div class="mono ${b.ecart < 0 ? "neg" : ""}">${fmt(b.ecart)}</div></div>
    ${pct != null ? `<div style="margin-top:12px"><div style="font-size:12px;color:var(--slate)">Consommé : ${pct} %</div>
      <div style="height:10px;background:#e2e8f0;border-radius:6px;overflow:hidden;margin-top:4px"><div style="height:100%;width:${Math.min(pct, 100)}%;background:${barColor}"></div></div></div>` : ""}
    <div class="mactions"><button class="btn" onclick="el('modal-root').innerHTML=''">Fermer</button></div></div></div>`;
}

/* ===================== Sécurité chantier (HSE) ===================== */
async function renderSecurite() {
  const [stats, incidents, controles, epis] = await Promise.all([
    api("/api/securite/stats"), api("/api/incidents"), api("/api/controles"), api("/api/epi")]);
  await getCache("chantiers"); if (!caches.employees) caches.employees = await api("/api/employees");
  const kpis = [
    ["Incidents", stats.incidents, ""], ["Accidents", stats.accidents, ""],
    ["Jours d'arrêt", stats.jours_arret, ""], ["Taux fréquence", stats.taux_frequence, "TF"],
    ["Taux gravité", stats.taux_gravite, "TG"], ["Conformité contrôles", stats.taux_conformite == null ? "—" : stats.taux_conformite, "%"],
  ];
  V().innerHTML = `<h1>Sécurité chantier</h1><div class="sub">Registre HSE, contrôles, EPI et indicateurs (TF = accidents avec arrêt / M heures · TG = jours perdus / 1000 h).</div>
    <div class="grid kpis" style="grid-template-columns:repeat(6,1fr)">
      ${kpis.map(([l, v, u]) => `<div class="card kpi"><div class="lbl">${l}</div><div class="val mono" style="font-size:20px">${v} <small>${u}</small></div></div>`).join("")}</div>

    <div class="card" style="margin-top:16px"><div class="bar"><div class="colhead">Registre incidents / accidents</div><button class="btn sm" onclick="addIncident()">+ Déclarer</button></div>
      <table><thead><tr><th>Date</th><th>Chantier</th><th>Type</th><th>Gravité</th><th>Blessé</th><th class="r">Arrêt (j)</th><th>Statut</th><th></th></tr></thead><tbody>
      ${incidents.length ? incidents.map((i) => `<tr><td>${(i.date_incident || "").slice(0, 10)}</td><td>${chantierLabel(i.chantier_id)}</td><td><span class="pill">${i.type}</span></td><td><span class="pill">${i.gravite || ""}</span></td><td>${i.employee_id ? relLabel("employees", i.employee_id, "nom") : ""}</td><td class="r mono">${i.jours_arret || 0}</td><td><span class="pill">${i.statut}</span></td><td class="r"><button class="btn sm danger" onclick="delGen('incidents',${i.id},renderSecurite)">×</button></td></tr>`).join("") : `<tr><td colspan="8" class="muted">Aucun.</td></tr>`}
      </tbody></table></div>

    <div class="card" style="margin-top:16px"><div class="bar"><div class="colhead">Contrôles de sécurité</div><button class="btn sm" onclick="addControle()">+ Contrôle</button></div>
      <table><thead><tr><th>Date</th><th>Chantier</th><th>Type</th><th>Conforme</th><th>Contrôleur</th><th>Observations</th><th></th></tr></thead><tbody>
      ${controles.length ? controles.map((c) => `<tr><td>${(c.date_controle || "").slice(0, 10)}</td><td>${chantierLabel(c.chantier_id)}</td><td>${c.type || ""}</td><td>${c.conforme ? "✅" : "❌"}</td><td>${c.controleur || ""}</td><td>${c.observations || ""}</td><td class="r"><button class="btn sm danger" onclick="delGen('controles',${c.id},renderSecurite)">×</button></td></tr>`).join("") : `<tr><td colspan="7" class="muted">Aucun.</td></tr>`}
      </tbody></table></div>

    <div class="card" style="margin-top:16px"><div class="bar"><div class="colhead">EPI attribués</div><button class="btn sm" onclick="addEpi()">+ Attribution</button></div>
      <table><thead><tr><th>Salarié</th><th>Équipement</th><th>Type</th><th>Remis le</th><th>État</th><th></th></tr></thead><tbody>
      ${epis.length ? epis.map((e) => `<tr><td>${relLabel("employees", e.employee_id, "nom")}</td><td>${e.designation}</td><td><span class="pill">${e.type || ""}</span></td><td>${(e.date_remise || "").slice(0, 10)}</td><td><span class="pill">${e.etat}</span></td><td class="r"><button class="btn sm danger" onclick="delGen('epi',${e.id},renderSecurite)">×</button></td></tr>`).join("") : `<tr><td colspan="6" class="muted">Aucun.</td></tr>`}
      </tbody></table></div>`;
}
async function addIncident() {
  const d = await modalForm("Déclarer un incident", [
    { key: "chantier_id", label: "Chantier", type: "select", rel: "chantiers" },
    { key: "type", label: "Type", type: "select", options: opt(["incident", "accident", "presqu_accident"]) },
    { key: "gravite", label: "Gravité", type: "select", options: opt(["faible", "moyenne", "grave"]) },
    { key: "employee_id", label: "Blessé (si accident)", type: "select", rel: "employees" },
    { key: "jours_arret", label: "Jours d'arrêt", type: "number" },
    { key: "description", label: "Description" }, { key: "mesures", label: "Mesures correctives" },
    { key: "date_incident", label: "Date", type: "date" }]);
  if (!d) return; await api("/api/incidents", { method: "POST", body: JSON.stringify(d) }); renderSecurite();
}
async function addControle() {
  const d = await modalForm("Contrôle de sécurité", [
    { key: "chantier_id", label: "Chantier", type: "select", rel: "chantiers" },
    { key: "type", label: "Type de contrôle" },
    { key: "conforme", label: "Conforme", type: "select", options: [{ value: "true", label: "Oui" }, { value: "false", label: "Non" }] },
    { key: "controleur", label: "Contrôleur" }, { key: "observations", label: "Observations" },
    { key: "date_controle", label: "Date", type: "date" }]);
  if (!d) return; await api("/api/controles", { method: "POST", body: JSON.stringify(d) }); renderSecurite();
}
async function addEpi() {
  const d = await modalForm("Attribution d'EPI", [
    { key: "employee_id", label: "Salarié", type: "select", rel: "employees" },
    { key: "designation", label: "Équipement" },
    { key: "type", label: "Type", type: "select", options: opt(["tete", "pieds", "mains", "yeux", "corps", "auditif"]) },
    { key: "date_remise", label: "Remis le", type: "date" }]);
  if (!d) return; await api("/api/epi", { method: "POST", body: JSON.stringify(d) }); renderSecurite();
}
async function delGen(ep, id, cb) { if (confirm("Supprimer ?")) { await api(`/api/${ep}/${id}`, { method: "DELETE" }); cb(); } }

/* ===================== GED (versions + signatures) ===================== */
async function renderGED() {
  const docs = await api("/api/documents"); await getCache("chantiers");
  V().innerHTML = `<div class="bar"><div><h1>Documents (GED)</h1><div class="sub">Versioning et circuit de signature. (Pas d'OCR.)</div></div>
    <button class="btn sm" onclick="addDoc()">+ Document</button></div>
    <div class="card"><table><thead><tr><th>Nom</th><th>Catégorie</th><th>Type</th><th>Chantier</th><th class="r">Version</th><th></th></tr></thead><tbody>
    ${docs.length ? docs.map((d) => `<tr><td class="row" onclick="docFull(${d.id})">${d.nom}</td><td><span class="pill">${d.categorie || ""}</span></td><td>${d.type || ""}</td><td>${chantierLabel(d.chantier_id)}</td><td class="r mono">v${d.version || 1}</td><td class="r"><button class="btn sm" onclick="docFull(${d.id})">Ouvrir</button> <button class="btn sm danger" onclick="delGen('documents',${d.id},renderGED)">×</button></td></tr>`).join("") : `<tr><td colspan="6" class="muted">Aucun document.</td></tr>`}
    </tbody></table></div>`;
}
async function addDoc() {
  const d = await modalForm("Nouveau document", [
    { key: "nom", label: "Nom" },
    { key: "categorie", label: "Catégorie", type: "select", options: opt(["technique", "administratif", "juridique", "securite", "financier"]) },
    { key: "type", label: "Type", type: "select", options: opt(["contrat", "plan", "pv", "facture", "attachement"]) },
    { key: "chantier_id", label: "Chantier", type: "select", rel: "chantiers" }, { key: "url", label: "Lien / URL" }]);
  if (!d) return; await api("/api/documents", { method: "POST", body: JSON.stringify({ ...d, version: 1 }) }); renderGED();
}
async function docFull(id) {
  const d = await api("/api/documents/" + id + "/full");
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>${d.nom} <span class="pill">v${d.version}</span></h3>
    <div class="sub">${d.categorie || ""} · ${d.type || ""}${d.url ? ` · <a href="${d.url}" target="_blank">ouvrir le fichier</a>` : ""}</div>
    <div class="bar" style="margin-top:8px"><div class="colhead">Historique des versions</div><button class="btn sm" onclick="addVersion(${d.id})">+ Nouvelle version</button></div>
    <table class="lines"><thead><tr><th>Version</th><th>Auteur</th><th>Note</th><th>Date</th></tr></thead><tbody>
    ${d.versions.map((v) => `<tr><td>v${v.version}</td><td>${v.auteur || ""}</td><td>${v.note || ""}</td><td>${(v.created_at || "").slice(0, 10)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">—</td></tr>`}
    </tbody></table>
    <div class="bar" style="margin-top:12px"><div class="colhead">Circuit de signature</div><button class="btn sm ghost" onclick="reqSign(${d.id})">+ Demander signature</button></div>
    <table class="lines"><tbody>
    ${d.signatures.map((s) => `<tr><td>${s.signataire}</td><td><span class="pill">${s.statut}</span></td><td>${s.date_signature ? (s.date_signature || "").slice(0, 10) : ""}</td><td class="r">${s.statut !== "signe" ? `<button class="btn sm" onclick="doSign(${s.id},${d.id})">Signer</button>` : "✅"}</td></tr>`).join("") || `<tr><td class="muted">Aucune signature demandée.</td></tr>`}
    </tbody></table>
    <div class="mactions"><button class="btn" onclick="el('modal-root').innerHTML=''">Fermer</button></div></div></div>`;
}
async function addVersion(id) {
  const d = await modalForm("Nouvelle version", [{ key: "url", label: "Lien / URL" }, { key: "auteur", label: "Auteur" }, { key: "note", label: "Note de version" }]);
  if (!d) return; await api(`/api/documents/${id}/versions`, { method: "POST", body: JSON.stringify(d) }); docFull(id);
}
async function reqSign(id) {
  const d = await modalForm("Demander une signature", [{ key: "signataire", label: "Signataire" }]);
  if (!d) return; await api(`/api/documents/${id}/signatures`, { method: "POST", body: JSON.stringify(d) }); docFull(id);
}
async function doSign(sigId, docId) { await api(`/api/signatures/${sigId}/sign`, { method: "POST", body: "{}" }); docFull(docId); }

/* ===================== Fournisseurs ===================== */
const stars = (n) => n == null ? "—" : "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n)) + " " + n;
/* ===================== Clients ===================== */
async function renderClients() {
  const list = await api("/api/clients"); caches.clients = list;
  V().innerHTML = `<div class="bar"><div><h1>Clients</h1><div class="sub">Répertoire des clients (maîtres d'ouvrage, particuliers, entreprises).</div></div>
    <button class="btn sm" onclick="addClient()">+ Client</button></div>
    <div class="card"><table><thead><tr><th>Raison sociale</th><th>ICE</th><th>Contact</th><th>Tél</th><th>Ville</th><th></th></tr></thead><tbody>
    ${list.map((c) => `<tr><td>${c.raison_sociale}</td><td class="mono">${c.ice || ""}</td><td>${c.contact || ""}</td><td>${c.telephone || ""}</td><td>${c.ville || ""}</td><td class="r"><button class="btn sm ghost" onclick="editClient(${c.id})">✏️</button> <button class="btn sm danger" onclick="delGen('clients',${c.id},renderClients)">×</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">Aucun client. Cliquez sur « + Client » pour en ajouter un.</td></tr>`}
    </tbody></table></div>`;
}
async function addClient() {
  const d = await modalForm("Nouveau client", [{ key: "raison_sociale", label: "Raison sociale / Nom" }, { key: "ice", label: "ICE" }, { key: "contact", label: "Contact" }, { key: "telephone", label: "Téléphone" }, { key: "email", label: "Email" }, { key: "adresse", label: "Adresse" }, { key: "ville", label: "Ville" }]);
  if (!d) return;
  try { await api("/api/clients", { method: "POST", body: JSON.stringify(d) }); renderClients(); } catch (e) { alert(e.message); }
}
function editClient(id) {
  const o = findCached("clients", id);
  if (o) editEntity("/api/clients", [{ key: "raison_sociale", label: "Raison sociale / Nom" }, { key: "ice", label: "ICE" }, { key: "contact", label: "Contact" }, { key: "telephone", label: "Téléphone" }, { key: "email", label: "Email" }, { key: "adresse", label: "Adresse" }, { key: "ville", label: "Ville" }], o, () => renderClients());
}

/* ===================== Fournisseurs ===================== */
async function renderFournisseurs() {
  const list = await api("/api/fournisseurs"); caches.fournisseurs = list;
  V().innerHTML = `<div class="bar"><div><h1>Fournisseurs</h1><div class="sub">Conditions, historique des commandes et évaluations.</div></div>
    <button class="btn sm" onclick="addFournisseur()">+ Fournisseur</button></div>
    <div class="card"><table><thead><tr><th>Raison sociale</th><th>ICE</th><th>Contact</th><th>Tél</th><th></th></tr></thead><tbody>
    ${list.map((f) => `<tr><td class="row" onclick="ficheFour(${f.id})">${f.raison_sociale}</td><td class="mono">${f.ice || ""}</td><td>${f.contact || ""}</td><td>${f.telephone || ""}</td><td class="r"><button class="btn sm" onclick="ficheFour(${f.id})">Fiche</button> <button class="btn sm ghost" onclick="editFournisseur(${f.id})">✏️</button> <button class="btn sm danger" onclick="delGen('fournisseurs',${f.id},renderFournisseurs)">×</button></td></tr>`).join("")}
    </tbody></table></div>`;
}
async function addFournisseur() {
  const d = await modalForm("Nouveau fournisseur", [{ key: "raison_sociale", label: "Raison sociale" }, { key: "ice", label: "ICE" }, { key: "contact", label: "Contact" }, { key: "telephone", label: "Téléphone" }, { key: "email", label: "Email" }, { key: "conditions_paiement", label: "Conditions de paiement" }, { key: "delai_livraison", label: "Délai livraison (j)", type: "number" }]);
  if (!d) return; await api("/api/fournisseurs", { method: "POST", body: JSON.stringify(d) }); renderFournisseurs();
}
async function ficheFour(id) {
  const f = await api("/api/fournisseurs/" + id + "/fiche");
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>${f.raison_sociale}</h3>
    <div class="sub">ICE ${f.ice || "—"} · ${f.contact || ""} · ${f.telephone || ""}${f.conditions_paiement ? " · " + f.conditions_paiement : ""}</div>
    <div class="grid kpis" style="grid-template-columns:repeat(4,1fr);margin:10px 0">
      <div class="card kpi"><div class="lbl">Commandes</div><div class="val mono" style="font-size:18px">${f.stats.nb_commandes}</div></div>
      <div class="card kpi"><div class="lbl">Total commandé</div><div class="val mono" style="font-size:18px">${fmt(f.stats.total_commande)}</div></div>
      <div class="card kpi"><div class="lbl">Total reçu</div><div class="val mono" style="font-size:18px">${fmt(f.stats.total_recu)}</div></div>
      <div class="card kpi"><div class="lbl">Note moyenne</div><div class="val" style="font-size:16px">${stars(f.note_moyenne)}</div></div>
    </div>
    <div class="colhead">Commandes</div>
    <table class="lines"><tbody>${f.commandes.map((c) => `<tr><td class="mono">${c.numero}</td><td class="r mono">${fmt(c.montant)}</td><td><span class="pill">${c.statut}</span></td></tr>`).join("") || `<tr><td class="muted">Aucune.</td></tr>`}</tbody></table>
    <div class="bar" style="margin-top:12px"><div class="colhead">Évaluations (qualité / délai / prix)</div><button class="btn sm ghost" onclick="evalFour(${f.id})">+ Évaluation</button></div>
    <table class="lines"><tbody>${f.evaluations.map((e) => `<tr><td>${(e.date_eval || "").slice(0, 10)}</td><td>Q${e.note_qualite}/D${e.note_delai}/P${e.note_prix}</td><td>${e.commentaire || ""}</td></tr>`).join("") || `<tr><td class="muted">Aucune.</td></tr>`}</tbody></table>
    <div class="mactions"><button class="btn" onclick="el('modal-root').innerHTML=''">Fermer</button></div></div></div>`;
}
async function evalFour(id) {
  const d = await modalForm("Évaluer le fournisseur", [{ key: "note_qualite", label: "Qualité (1-5)", type: "number" }, { key: "note_delai", label: "Délai (1-5)", type: "number" }, { key: "note_prix", label: "Prix (1-5)", type: "number" }, { key: "commentaire", label: "Commentaire" }]);
  if (!d) return; d.fournisseur_id = id; await api("/api/fournisseur-evals", { method: "POST", body: JSON.stringify(d) }); ficheFour(id);
}

/* ===================== Sous-traitants ===================== */
async function renderSousTraitants() {
  const list = await api("/api/sous-traitants"); caches["sous-traitants"] = list;
  V().innerHTML = `<div class="bar"><div><h1>Sous-traitants</h1><div class="sub">Contrats de marché, situations de paiement (avancement + retenue de garantie), évaluations.</div></div>
    <button class="btn sm" onclick="addST()">+ Sous-traitant</button></div>
    <div class="card"><table><thead><tr><th>Raison sociale</th><th>Spécialité</th><th>Contact</th><th>Tél</th><th></th></tr></thead><tbody>
    ${list.map((s) => `<tr><td class="row" onclick="ficheST(${s.id})">${s.raison_sociale}</td><td><span class="pill">${s.specialite || ""}</span></td><td>${s.contact || ""}</td><td>${s.telephone || ""}</td><td class="r"><button class="btn sm" onclick="ficheST(${s.id})">Fiche</button> <button class="btn sm ghost" onclick="editST(${s.id})">✏️</button> <button class="btn sm danger" onclick="delGen('sous-traitants',${s.id},renderSousTraitants)">×</button></td></tr>`).join("")}
    </tbody></table></div>`;
}
async function addST() {
  const d = await modalForm("Nouveau sous-traitant", [{ key: "raison_sociale", label: "Raison sociale" }, { key: "specialite", label: "Spécialité" }, { key: "contact", label: "Contact" }, { key: "telephone", label: "Téléphone" }]);
  if (!d) return; await api("/api/sous-traitants", { method: "POST", body: JSON.stringify(d) }); renderSousTraitants();
}
async function ficheST(id) {
  const s = await api("/api/sous-traitants/" + id + "/fiche");
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>${s.raison_sociale} <span class="pill">${s.specialite || ""}</span></h3>
    <div class="grid kpis" style="grid-template-columns:repeat(3,1fr);margin:10px 0">
      <div class="card kpi"><div class="lbl">Total marchés</div><div class="val mono" style="font-size:18px">${fmt(s.synthese.total_marche)}</div></div>
      <div class="card kpi"><div class="lbl">Total payé (net)</div><div class="val mono" style="font-size:18px">${fmt(s.synthese.total_paye)}</div></div>
      <div class="card kpi"><div class="lbl">Note moyenne</div><div class="val" style="font-size:16px">${stars(s.synthese.note_moyenne)}</div></div>
    </div>
    <div class="bar"><div class="colhead">Contrats de marché</div><button class="btn sm" onclick="addContratST(${s.id})">+ Contrat</button></div>
    <table class="lines"><thead><tr><th>Objet</th><th>Chantier</th><th class="r">Montant marché</th><th class="r">RG</th><th>Statut</th><th></th></tr></thead><tbody>
    ${s.contrats.map((c) => `<tr><td>${c.objet || ""}</td><td>${c.chantier_code || ""}</td><td class="r mono">${fmt(c.montant_marche)}</td><td class="r">${c.rg_taux} %</td><td><span class="pill">${c.statut}</span></td><td class="r"><button class="btn sm" onclick="situST(${c.id},${s.id})">Situation</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">Aucun contrat.</td></tr>`}
    </tbody></table>
    <div class="colhead" style="margin-top:12px">Situations de paiement</div>
    <table class="lines"><thead><tr><th>Date</th><th class="r">Avanc.</th><th class="r">Montant</th><th class="r">RG</th><th class="r">Net à payer</th><th>Statut</th></tr></thead><tbody>
    ${s.situations.map((x) => `<tr><td>${(x.date_situation || "").slice(0, 10)}</td><td class="r">${x.avancement || 0} %</td><td class="r mono">${fmt(x.montant)}</td><td class="r mono">${fmt(x.retenue_garantie)}</td><td class="r mono">${fmt(x.net_a_payer)}</td><td><span class="pill">${x.statut}</span></td></tr>`).join("") || `<tr><td colspan="6" class="muted">Aucune.</td></tr>`}
    </tbody></table>
    <div class="bar" style="margin-top:12px"><div class="colhead">Évaluations</div><button class="btn sm ghost" onclick="evalST(${s.id})">+ Évaluation</button></div>
    <table class="lines"><tbody>${s.evaluations.map((e) => `<tr><td>${(e.date_eval || "").slice(0, 10)}</td><td>${stars(e.note)}</td><td>${e.commentaire || ""}</td></tr>`).join("") || `<tr><td class="muted">Aucune.</td></tr>`}</tbody></table>
    <div class="mactions"><button class="btn" onclick="el('modal-root').innerHTML=''">Fermer</button></div></div></div>`;
}
async function addContratST(id) {
  await getCache("chantiers");
  const d = await modalForm("Nouveau contrat de marché", [
    { key: "chantier_id", label: "Chantier", type: "select", rel: "chantiers" },
    { key: "objet", label: "Objet" }, { key: "montant_marche", label: "Montant du marché", type: "number" },
    { key: "rg_taux", label: "Retenue de garantie (%)", type: "number" }, { key: "date_debut", label: "Début", type: "date" }]);
  if (!d) return; d.sous_traitant_id = id; await api("/api/st-contrats", { method: "POST", body: JSON.stringify(d) }); ficheST(id);
}
async function situST(contratId, stId) {
  const d = await modalForm("Situation de paiement", [{ key: "avancement", label: "Avancement cumulé (%)", type: "number" }]);
  if (!d) return;
  try { await api("/api/soustraitants/situation", { method: "POST", body: JSON.stringify({ contrat_id: contratId, avancement: d.avancement }) }); ficheST(stId); }
  catch (e) { alert(e.message); }
}
async function evalST(id) {
  const d = await modalForm("Évaluer le sous-traitant", [{ key: "note", label: "Note (1-5)", type: "number" }, { key: "commentaire", label: "Commentaire" }]);
  if (!d) return; d.sous_traitant_id = id; await api("/api/st-evals", { method: "POST", body: JSON.stringify(d) }); ficheST(id);
}

/* ===================== Modules génériques ===================== */
const MOD = {
  chantiers: { title: "Chantiers", ep: "/api/chantiers", cache: "chantiers",
    cols: [["code", "Code", "mono"], ["nom", "Nom"], ["client", "Client"], ["ville", "Ville"], ["statut", "Statut", "pill"], ["budget_prevu", "Budget", "num"]],
    fields: [{ key: "code", label: "Code" }, { key: "nom", label: "Nom" }, { key: "client", label: "Client" }, { key: "ville", label: "Ville" }, { key: "budget_prevu", label: "Budget prévu", type: "number" }, { key: "date_debut", label: "Début", type: "date" }, { key: "statut", label: "Statut", type: "select", options: opt(["prospect", "en_cours", "suspendu", "clos"]) }] },
  incidents: { title: "Sécurité chantier", ep: "/api/incidents",
    cols: [["date_incident", "Date"], ["chantier_id", "Chantier", "chantier"], ["type", "Type"], ["gravite", "Gravité", "pill"], ["statut", "Statut", "pill"]],
    fields: [{ key: "chantier_id", label: "Chantier", type: "select", rel: "chantiers" }, { key: "type", label: "Type", type: "select", options: opt(["incident", "accident", "presqu_accident"]) }, { key: "gravite", label: "Gravité", type: "select", options: opt(["faible", "moyenne", "grave"]) }, { key: "description", label: "Description" }, { key: "date_incident", label: "Date", type: "date" }] },
  documents: { title: "Documents (GED)", ep: "/api/documents",
    cols: [["nom", "Nom"], ["type", "Type", "pill"], ["chantier_id", "Chantier", "chantier"], ["version", "Version"]],
    fields: [{ key: "nom", label: "Nom" }, { key: "type", label: "Type", type: "select", options: opt(["contrat", "plan", "pv", "facture", "attachement"]) }, { key: "chantier_id", label: "Chantier", type: "select", rel: "chantiers" }, { key: "url", label: "Lien / URL" }] },
  factures: { title: "Factures", ep: "/api/factures",
    cols: [["numero", "N°", "mono"], ["client", "Client"], ["type", "Type", "pill"], ["montant_ttc", "TTC", "num"], ["statut", "Statut", "pill"]],
    fields: [{ key: "numero", label: "N°" }, { key: "client", label: "Client" }, { key: "chantier_id", label: "Chantier", type: "select", rel: "chantiers" }, { key: "type", label: "Type", type: "select", options: opt(["facture", "situation", "acompte", "decompte"]) }, { key: "montant_ht", label: "Montant HT", type: "number" }, { key: "montant_ttc", label: "Montant TTC", type: "number" }, { key: "statut", label: "Statut", type: "select", options: opt(["brouillon", "emise", "payee"]) }] },
  "demandes-achat": { title: "Demandes d'achat", ep: "/api/demandes-achat",
    cols: [["objet", "Objet"], ["chantier_id", "Chantier", "chantier"], ["statut", "Statut", "pill"]],
    fields: [{ key: "objet", label: "Objet" }, { key: "chantier_id", label: "Chantier", type: "select", rel: "chantiers" }, { key: "statut", label: "Statut", type: "select", options: opt(["demande", "approuvee", "commandee", "recue"]) }] },
  fournisseurs: { title: "Fournisseurs", ep: "/api/fournisseurs", cache: "fournisseurs",
    cols: [["raison_sociale", "Raison sociale"], ["ice", "ICE", "mono"], ["contact", "Contact"], ["telephone", "Tél"], ["email", "Email"]],
    fields: [{ key: "raison_sociale", label: "Raison sociale" }, { key: "ice", label: "ICE" }, { key: "contact", label: "Contact" }, { key: "telephone", label: "Téléphone" }, { key: "email", label: "Email" }] },
  "sous-traitants": { title: "Sous-traitants", ep: "/api/sous-traitants", cache: "sous-traitants",
    cols: [["raison_sociale", "Raison sociale"], ["specialite", "Spécialité", "pill"], ["contact", "Contact"], ["telephone", "Tél"]],
    fields: [{ key: "raison_sociale", label: "Raison sociale" }, { key: "specialite", label: "Spécialité" }, { key: "contact", label: "Contact" }, { key: "telephone", label: "Téléphone" }] },
};
function cell(row, [key, , kind]) {
  const v = row[key];
  if (kind === "num") return `<td class="r mono">${fmt(v)}</td>`;
  if (kind === "mono") return `<td class="mono">${v ?? ""}</td>`;
  if (kind === "pill") return `<td>${v ? `<span class="pill">${v}</span>` : ""}</td>`;
  if (kind === "chantier") return `<td>${chantierLabel(v)}</td>`;
  return `<td>${v ?? ""}</td>`;
}
async function renderMod(key) {
  const m = MOD[key]; if (!m) { V().innerHTML = `<div class="warn">Module inconnu.</div>`; return; }
  if (m.fields.some((f) => f.rel === "chantiers")) await getCache("chantiers");
  const list = await api(m.ep); if (m.cache) caches[m.cache] = list; caches["mod:" + key] = list;
  V().innerHTML = `<div class="bar"><div><h1>${m.title}</h1></div><button class="btn sm" onclick="addMod('${key}')">+ Ajouter</button></div>
    <div class="card"><table><thead><tr>${m.cols.map((c) => `<th class="${c[2] === "num" ? "r" : ""}">${c[1]}</th>`).join("")}<th></th></tr></thead><tbody>
    ${list.length ? list.map((row) => `<tr>${m.cols.map((c) => cell(row, c)).join("")}<td class="r"><button class="btn sm ghost" onclick="editMod('${key}',${row.id})">✏️</button> <button class="btn sm danger" onclick="delMod('${key}',${row.id})">×</button></td></tr>`).join("") : `<tr><td colspan="${m.cols.length + 1}" class="muted">Aucun élément.</td></tr>`}
    </tbody></table></div>`;
}
async function addMod(key) {
  const m = MOD[key]; const d = await modalForm("Ajouter — " + m.title, m.fields);
  if (!d) return;
  try { await api(m.ep, { method: "POST", body: JSON.stringify(d) }); if (m.cache) clearCache(m.cache); renderMod(key); } catch (e) { alert(e.message); }
}
async function delMod(key, id) { const m = MOD[key]; if (confirm("Supprimer ?")) { await api(`${m.ep}/${id}`, { method: "DELETE" }); if (m.cache) clearCache(m.cache); renderMod(key); } }

/* ===================== Ma société (en-tête des documents) ===================== */
let _logoData = null;
async function renderSociete() {
  const c = await api("/api/companies/" + activeCompany);
  _logoData = c.logo || null;
  const f = (k, lbl, val) => `<div class="field"><label>${lbl}</label><input data-k="${k}" value="${(val ?? "").toString().replace(/"/g, "&quot;")}"></div>`;
  V().innerHTML = `<div class="bar"><div><h1>Ma société</h1><div class="sub">Ces informations apparaissent en en-tête de vos devis et factures.</div></div>
    <div style="display:flex;gap:8px"><button class="btn ghost" onclick="downloadDoc('/api/export/backup','sauvegarde-btppro.json')">💾 Sauvegarde</button><button class="btn" onclick="saveSociete()">Enregistrer</button></div></div>
    <div class="card" style="margin-bottom:14px"><div class="colhead">Logo</div>
      <div style="display:flex;align-items:center;gap:18px">
        <div style="width:130px;height:64px;border:1px dashed #cbd5e1;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#fbfcfd">
          <img id="logo-preview" src="${_logoData || ""}" style="max-width:124px;max-height:58px;${_logoData ? "" : "display:none"}"/>
          <span id="logo-empty" class="muted" style="${_logoData ? "display:none" : ""}">Aucun logo</span>
        </div>
        <div><input type="file" accept="image/*" onchange="onLogoPick(this)"><div class="muted" style="font-size:11px;margin-top:4px">PNG ou JPG. Redimensionné automatiquement.</div>
        ${_logoData ? `<button class="btn sm danger" style="margin-top:6px" onclick="_logoData=null;document.getElementById('logo-preview').style.display='none';document.getElementById('logo-empty').style.display=''">Retirer</button>` : ""}</div>
      </div></div>
    <div id="soc-form" class="card"><div class="colhead">Identité &amp; coordonnées</div>
      <div class="form" style="grid-template-columns:repeat(3,1fr)">
        ${f("raison_sociale", "Raison sociale", c.raison_sociale)}
        ${f("ice", "ICE", c.ice)}
        ${f("rc", "Registre de commerce (RC)", c.rc)}
        ${f("if_fiscal", "Identifiant fiscal (IF)", c.if_fiscal)}
        ${f("patente", "Patente", c.patente)}
        ${f("cnss", "N° CNSS", c.cnss)}
        ${f("adresse", "Adresse", c.adresse)}
        ${f("ville", "Ville", c.ville)}
        ${f("telephone", "Téléphone", c.telephone)}
        ${f("email", "Email", c.email)}
        ${f("rib", "RIB", c.rib)}
        ${f("tva_taux", "Taux TVA (%)", c.tva_taux)}
      </div></div>
    <div id="soc-num" class="card" style="margin-top:14px"><div class="colhead">Numérotation automatique des documents</div>
      <div class="muted" style="margin-bottom:10px;font-size:12px">Variables : <b>{AAAA}</b> année · <b>{AA}</b> année sur 2 chiffres · <b>{MM}</b> mois · <b>####</b> compteur (le nombre de # fixe le nombre de chiffres). Le « prochain n° » indique le compteur actuel ; le suivant sera +1.</div>
      <div class="form" style="grid-template-columns:repeat(2,1fr)">
        <div class="field"><label>Format des devis</label><input data-n="devis_format" value="${(c.devis_format || "DEV-{AAAA}-{####}").replace(/"/g, "&quot;")}"></div>
        <div class="field"><label>Format des factures</label><input data-n="facture_format" value="${(c.facture_format || "FAC-{AAAA}-{####}").replace(/"/g, "&quot;")}"></div>
        <div class="field"><label>Devis déjà émis (compteur)</label><input data-n="devis_compteur" type="number" value="${c.devis_compteur || 0}"></div>
        <div class="field"><label>Factures déjà émises (compteur)</label><input data-n="facture_compteur" type="number" value="${c.facture_compteur || 0}"></div>
      </div>
      <div class="muted" style="margin-top:8px;font-size:12px">Prochain devis : <b id="nx-d">${formatNumeroJS(c.devis_format || "DEV-{AAAA}-{####}", (Number(c.devis_compteur) || 0) + 1)}</b> · Prochaine facture : <b id="nx-f">${formatNumeroJS(c.facture_format || "FAC-{AAAA}-{####}", (Number(c.facture_compteur) || 0) + 1)}</b></div>
    </div>`;
  document.querySelectorAll('#soc-num [data-n]').forEach((i) => i.addEventListener("input", refreshNumPreview));
}
function formatNumeroJS(fmt, seq) {
  const d = new Date();
  let s = String(fmt || "").replace(/\{AAAA\}/g, d.getFullYear()).replace(/\{AA\}/g, String(d.getFullYear()).slice(-2)).replace(/\{MM\}/g, String(d.getMonth() + 1).padStart(2, "0"));
  return s.replace(/\{?#+\}?/g, (m) => String((Number(seq) || 0)).padStart((m.match(/#/g) || []).length, "0")) || ("N-" + seq);
}
function refreshNumPreview() {
  const g = (k) => document.querySelector(`#soc-num [data-n="${k}"]`).value;
  el("nx-d").textContent = formatNumeroJS(g("devis_format"), (Number(g("devis_compteur")) || 0) + 1);
  el("nx-f").textContent = formatNumeroJS(g("facture_format"), (Number(g("facture_compteur")) || 0) + 1);
}
function onLogoPick(input) {
  const file = input.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 360, sc = Math.min(1, max / img.width);
      const cv = document.createElement("canvas"); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      _logoData = cv.toDataURL("image/png");
      const p = el("logo-preview"); p.src = _logoData; p.style.display = ""; el("logo-empty").style.display = "none";
    };
    img.src = r.result;
  };
  r.readAsDataURL(file);
}
async function saveSociete() {
  const body = {}; document.querySelectorAll("#soc-form [data-k]").forEach((i) => body[i.dataset.k] = i.value);
  document.querySelectorAll("#soc-num [data-n]").forEach((i) => body[i.dataset.n] = i.value);
  body.logo = _logoData || "";
  try { await api("/api/companies/" + activeCompany, { method: "PUT", body: JSON.stringify(body) }); await loadCompanies(); alert("Paramètres de la société enregistrés."); }
  catch (e) { alert(e.message); }
}

/* ===================== Pointage des heures ===================== */
let ptPeriod = null;
async function renderPointage() {
  if (!ptPeriod) ptPeriod = { annee: period.annee, mois: period.mois };
  await Promise.all([getCache("employees"), getCache("chantiers")]);
  const emps = caches.employees || [], chs = caches.chantiers || [];
  const all = await api("/api/pointages");
  const pts = all.filter((p) => { const d = new Date(p.date_jour); return d.getFullYear() === ptPeriod.annee && (d.getMonth() + 1) === ptPeriod.mois; });
  const recap = await api(`/api/pointages-recap?annee=${ptPeriod.annee}&mois=${ptPeriod.mois}`);
  const eName = (id) => { const e = emps.find((x) => x.id == id); return e ? e.nom : "—"; };
  const cName = (id) => { const c = chs.find((x) => x.id == id); return c ? c.code : "—"; };
  V().innerHTML = `
  <div class="bar"><div><h1>Pointage des heures</h1><div class="sub">${MOIS[ptPeriod.mois - 1]} ${ptPeriod.annee} · alimente le coût réel des chantiers</div></div>
    <div style="display:flex;gap:6px"><button class="btn sm ghost" onclick="shiftPt(-1)">← Mois</button><button class="btn sm ghost" onclick="shiftPt(1)">Mois →</button></div></div>
  <div class="card" style="margin-bottom:14px"><div class="colhead">Saisir un pointage</div>
    <div class="form" style="grid-template-columns:repeat(5,1fr)">
      <div class="field"><label>Salarié</label><select id="pt-emp">${emps.map((e) => `<option value="${e.id}">${e.nom}</option>`).join("")}</select></div>
      <div class="field"><label>Chantier</label><select id="pt-ch">${chs.map((c) => `<option value="${c.id}">${c.code} — ${c.nom}</option>`).join("")}</select></div>
      <div class="field"><label>Date</label><input type="date" id="pt-date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>Heures</label><input type="number" id="pt-h" value="8"></div>
      <div class="field"><label>H. sup.</label><input type="number" id="pt-hs" value="0"></div>
    </div>
    <div style="margin-top:10px"><button class="btn sm" onclick="savePointage()">+ Ajouter</button></div></div>
  <div class="grid kpis" style="grid-template-columns:repeat(2,1fr);margin-bottom:14px">
    <div class="card kpi"><div class="lbl">Total heures du mois</div><div class="val mono">${recap.total_heures}</div></div>
    <div class="card kpi"><div class="lbl">Coût main-d'œuvre estimé</div><div class="val mono">${fmt(recap.total_cout)} <small>MAD</small></div></div></div>
  <div class="card" style="margin-bottom:14px"><div class="colhead">Coût par chantier</div>
    <table><thead><tr><th>Chantier</th><th class="r">Heures</th><th class="r">H. sup.</th><th class="r">Coût (MAD)</th></tr></thead><tbody>
    ${recap.lignes.length ? recap.lignes.map((l) => `<tr><td>${l.code ? l.code + " — " + (l.nom || "") : "(non affecté)"}</td><td class="r mono">${l.heures}</td><td class="r mono">${l.heures_sup}</td><td class="r mono">${fmt(l.cout)}</td></tr>`).join("") : `<tr><td colspan="4" class="muted">Aucun pointage ce mois.</td></tr>`}
    </tbody></table></div>
  <div class="card"><div class="colhead">Détail des pointages</div>
    <table><thead><tr><th>Date</th><th>Salarié</th><th>Chantier</th><th class="r">Heures</th><th class="r">H. sup.</th><th></th></tr></thead><tbody>
    ${pts.length ? pts.map((p) => `<tr><td>${new Date(p.date_jour).toLocaleDateString("fr-FR")}</td><td>${eName(p.employee_id)}</td><td>${cName(p.chantier_id)}</td><td class="r mono">${p.heures}</td><td class="r mono">${p.heures_sup}</td><td class="r"><button class="btn sm danger" onclick="delPointage(${p.id})">×</button></td></tr>`).join("") : `<tr><td colspan="6" class="muted">Aucun pointage.</td></tr>`}
    </tbody></table></div>`;
}
function shiftPt(d) { let m = ptPeriod.mois + d, y = ptPeriod.annee; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } ptPeriod = { annee: y, mois: m }; renderPointage(); }
async function savePointage() {
  const body = { employee_id: +el("pt-emp").value, chantier_id: +el("pt-ch").value, date_jour: el("pt-date").value, heures: +el("pt-h").value || 0, heures_sup: +el("pt-hs").value || 0 };
  try { await api("/api/pointages", { method: "POST", body: JSON.stringify(body) }); renderPointage(); } catch (e) { alert(e.message); }
}
async function delPointage(id) { if (confirm("Supprimer ce pointage ?")) { await api("/api/pointages/" + id, { method: "DELETE" }); renderPointage(); } }

/* ===================== Planning de chantier (Gantt) ===================== */
let planChantier = "";
const tacheFields = () => [{ key: "libelle", label: "Tâche" }, { key: "date_debut", label: "Début", type: "date" }, { key: "date_fin", label: "Fin", type: "date" }, { key: "avancement", label: "Avancement (%)", type: "number" }, { key: "responsable", label: "Responsable" }, { key: "statut", label: "Statut", type: "select", options: opt(["a_faire", "en_cours", "termine", "bloque"]) }];
async function renderPlanning() {
  await getCache("chantiers");
  const chs = caches.chantiers || [];
  if (!planChantier && chs.length) planChantier = String(chs[0].id);
  const all = await api("/api/taches");
  const taches = all.filter((t) => String(t.chantier_id) === String(planChantier));
  const ds = taches.flatMap((t) => [t.date_debut, t.date_fin]).filter(Boolean).map((d) => new Date(d).getTime());
  const min = ds.length ? Math.min(...ds) : Date.now(), max = ds.length ? Math.max(...ds) : Date.now() + 2592e6;
  const span = Math.max(max - min, 864e5);
  const bar = (t) => { const s = t.date_debut ? new Date(t.date_debut).getTime() : min; const e = t.date_fin ? new Date(t.date_fin).getTime() : s + 864e5; const left = (s - min) / span * 100, width = Math.max((e - s) / span * 100, 3); return `<div class="gbar" style="left:${left}%;width:${width}%"><div class="gfill" style="width:${t.avancement || 0}%"></div><span>${t.avancement || 0}%</span></div>`; };
  V().innerHTML = `
  <div class="bar"><div><h1>Planning de chantier</h1><div class="sub">Tâches, jalons et avancement</div></div>
    <div style="display:flex;gap:8px"><select onchange="planChantier=this.value;renderPlanning()">${chs.map((c) => `<option value="${c.id}" ${String(c.id) === String(planChantier) ? "selected" : ""}>${c.code} — ${c.nom}</option>`).join("")}</select>
    <button class="btn sm" onclick="addTache()">+ Tâche</button></div></div>
  <div class="card">
    ${taches.length ? `<div class="gantt">${taches.map((t) => `
      <div class="grow"><div class="glabel">${t.libelle}<div class="muted" style="font-size:11px">${t.date_debut ? new Date(t.date_debut).toLocaleDateString("fr-FR") : "?"} → ${t.date_fin ? new Date(t.date_fin).toLocaleDateString("fr-FR") : "?"}${t.responsable ? " · " + t.responsable : ""}</div></div>
      <div class="gtrack">${bar(t)}</div>
      <div class="gact"><button class="btn sm ghost" onclick="editTache(${t.id})">✏️</button> <button class="btn sm danger" onclick="delTache(${t.id})">×</button></div></div>`).join("")}</div>`
    : `<div class="muted">Aucune tâche pour ce chantier. Cliquez « + Tâche » pour commencer le planning.</div>`}
  </div>`;
}
async function addTache() { if (!planChantier) { alert("Créez d'abord un chantier."); return; } const d = await modalForm("Nouvelle tâche", tacheFields()); if (!d) return; d.chantier_id = +planChantier; try { await api("/api/taches", { method: "POST", body: JSON.stringify(d) }); renderPlanning(); } catch (e) { alert(e.message); } }
async function editTache(id) { const all = await api("/api/taches"); const o = all.find((x) => x.id === id); if (o) editEntity("/api/taches", tacheFields(), o, () => renderPlanning()); }
async function delTache(id) { if (confirm("Supprimer cette tâche ?")) { await api("/api/taches/" + id, { method: "DELETE" }); renderPlanning(); } }

/* ===================== Trésorerie ===================== */
async function renderTresorerie() {
  const d = await api("/api/tresorerie/dashboard");
  const pays = await api("/api/paiements");
  V().innerHTML = `
  <div class="bar"><div><h1>Trésorerie</h1><div class="sub">Encaissements, créances clients et échéancier</div></div>
    <button class="btn sm" onclick="addPaiement()">+ Paiement</button></div>
  <div class="grid kpis">
    <div class="card kpi ok"><div class="lbl">Encaissements</div><div class="val mono">${fmt(d.encaissements)} <small>MAD</small></div></div>
    <div class="card kpi"><div class="lbl">Décaissements</div><div class="val mono">${fmt(d.decaissements)} <small>MAD</small></div></div>
    <div class="card kpi ${d.solde >= 0 ? "ok" : "alert"}"><div class="lbl">Solde</div><div class="val mono">${fmt(d.solde)} <small>MAD</small></div></div>
    <div class="card kpi ${d.creances_clients > 0 ? "warn" : "ok"}"><div class="lbl">Créances clients</div><div class="val mono">${fmt(d.creances_clients)} <small>MAD</small></div></div></div>
  <div class="card" style="margin-top:16px"><div class="colhead">Échéancier — factures à encaisser</div>
    <table><thead><tr><th>N°</th><th>Client</th><th class="r">Dû</th><th class="r">Réglé</th><th class="r">Reste</th><th class="r">Ancienneté</th><th></th></tr></thead><tbody>
    ${d.echeancier.length ? d.echeancier.map((e) => `<tr><td class="mono">${e.numero || e.id}</td><td>${e.client || ""}</td><td class="r mono">${fmt(e.du)}</td><td class="r mono">${fmt(e.regle)}</td><td class="r mono">${fmt(e.reste)}</td><td class="r">${e.jours_anciennete} j ${e.en_retard ? '<span class="pill" style="background:var(--rose-bg);color:var(--rose)">retard</span>' : ""}</td><td class="r"><button class="btn sm" onclick="encaisser(${e.id},${e.reste},'${(e.numero || "").replace(/'/g, "")}')">Encaisser</button></td></tr>`).join("") : `<tr><td colspan="7" class="muted">Aucune créance en attente. 👍</td></tr>`}
    </tbody></table></div>
  <div class="card" style="margin-top:16px"><div class="colhead">Mouvements récents</div>
    <table><thead><tr><th>Date</th><th>Sens</th><th>Tiers / Réf.</th><th>Mode</th><th class="r">Montant</th><th></th></tr></thead><tbody>
    ${pays.length ? pays.slice(0, 50).map((p) => `<tr><td>${new Date(p.date_paiement).toLocaleDateString("fr-FR")}</td><td><span class="pill">${p.sens === "encaissement" ? "Encaissé" : "Décaissé"}</span></td><td>${p.tiers || (p.facture_id ? "Facture #" + p.facture_id : "")}${p.reference ? " · " + p.reference : ""}</td><td>${p.mode || ""}</td><td class="r mono">${fmt(p.montant)}</td><td class="r"><button class="btn sm danger" onclick="delPaiement(${p.id})">×</button></td></tr>`).join("") : `<tr><td colspan="6" class="muted">Aucun mouvement.</td></tr>`}
    </tbody></table></div>`;
}
async function encaisser(factureId, reste, num) {
  const d = await modalForm("Encaisser la facture " + (num || ""), [{ key: "montant", label: "Montant", type: "number" }, { key: "date_paiement", label: "Date", type: "date" }, { key: "mode", label: "Mode", type: "select", options: opt(["virement", "cheque", "espece", "effet"]) }, { key: "reference", label: "Référence" }], { montant: reste, date_paiement: new Date().toISOString().slice(0, 10), mode: "virement" });
  if (!d) return; d.sens = "encaissement"; d.facture_id = factureId;
  try { await api("/api/paiements", { method: "POST", body: JSON.stringify(d) }); renderTresorerie(); } catch (e) { alert(e.message); }
}
async function addPaiement() {
  const d = await modalForm("Nouveau paiement", [{ key: "sens", label: "Sens", type: "select", options: opt(["encaissement", "decaissement"]) }, { key: "tiers", label: "Tiers" }, { key: "montant", label: "Montant", type: "number" }, { key: "date_paiement", label: "Date", type: "date" }, { key: "mode", label: "Mode", type: "select", options: opt(["virement", "cheque", "espece", "effet"]) }, { key: "reference", label: "Référence" }], { date_paiement: new Date().toISOString().slice(0, 10), sens: "encaissement", mode: "virement" });
  if (!d) return;
  try { await api("/api/paiements", { method: "POST", body: JSON.stringify(d) }); renderTresorerie(); } catch (e) { alert(e.message); }
}
async function delPaiement(id) { if (confirm("Supprimer ce mouvement ?")) { await api("/api/paiements/" + id, { method: "DELETE" }); renderTresorerie(); } }

/* ===================== Parc matériel ===================== */
const materielFields = () => [{ key: "code", label: "Code" }, { key: "designation", label: "Désignation" }, { key: "type", label: "Type", type: "select", options: opt(["engin", "outillage", "vehicule"]) }, { key: "etat", label: "État", type: "select", options: opt(["disponible", "en_service", "maintenance", "hs"]) }, { key: "valeur_acquisition", label: "Valeur (MAD)", type: "number" }, { key: "date_acquisition", label: "Date d'acquisition", type: "date" }];
async function renderMateriel() {
  await getCache("chantiers");
  const chs = caches.chantiers || [];
  const list = await api("/api/materiel"); caches.materiel = list;
  const chName = (id) => { const c = chs.find((x) => x.id == id); return c ? c.code : "—"; };
  const pill = (e) => `<span class="pill" style="${e === "hs" ? "background:var(--rose-bg);color:var(--rose)" : e === "maintenance" ? "background:var(--amber-bg);color:var(--amber)" : e === "disponible" ? "background:var(--green-bg);color:var(--green)" : ""}">${e}</span>`;
  const total = list.length, dispo = list.filter((m) => m.etat === "disponible").length, maint = list.filter((m) => ["maintenance", "hs"].includes(m.etat)).length;
  const valeur = list.reduce((s, m) => s + Number(m.valeur_acquisition || 0), 0);
  V().innerHTML = `<div class="bar"><div><h1>Parc matériel</h1><div class="sub">Engins, outillage et véhicules · affectation et maintenance</div></div>
    <button class="btn sm" onclick="addMateriel()">+ Matériel</button></div>
  <div class="grid kpis" style="margin-bottom:14px">
    <div class="card kpi flat"><div class="lbl">Matériels</div><div class="val mono">${total}</div></div>
    <div class="card kpi ok"><div class="lbl">Disponibles</div><div class="val mono">${dispo}</div></div>
    <div class="card kpi ${maint ? "warn" : "flat"}"><div class="lbl">Maintenance / HS</div><div class="val mono">${maint}</div></div>
    <div class="card kpi"><div class="lbl">Valeur du parc</div><div class="val mono">${fmt(valeur)} <small>MAD</small></div></div></div>
  <div class="card"><table><thead><tr><th>Code</th><th>Désignation</th><th>Type</th><th>État</th><th>Chantier</th><th class="r">Valeur</th><th></th></tr></thead><tbody>
  ${list.length ? list.map((m) => `<tr><td class="mono">${m.code || ""}</td><td>${m.designation}</td><td>${m.type || ""}</td><td>${pill(m.etat)}</td><td>${chName(m.chantier_id)}</td><td class="r mono">${fmt(m.valeur_acquisition)}</td>
    <td class="r"><button class="btn sm" onclick="affecterMateriel(${m.id})">Affecter</button> <button class="btn sm ghost" onclick="maintenanceMateriel(${m.id})">🔧</button> <button class="btn sm ghost" onclick="editMateriel(${m.id})">✏️</button> <button class="btn sm danger" onclick="delMateriel(${m.id})">×</button></td></tr>`).join("") : `<tr><td colspan="7" class="muted">Aucun matériel.</td></tr>`}
  </tbody></table></div>`;
}
async function addMateriel() { const d = await modalForm("Nouveau matériel", materielFields()); if (!d) return; await api("/api/materiel", { method: "POST", body: JSON.stringify(d) }); renderMateriel(); }
function editMateriel(id) { const o = (caches.materiel || []).find((x) => x.id === id); if (o) editEntity("/api/materiel", materielFields(), o, () => renderMateriel()); }
async function delMateriel(id) { if (confirm("Supprimer ce matériel ?")) { await api("/api/materiel/" + id, { method: "DELETE" }); renderMateriel(); } }
async function affecterMateriel(id) {
  await getCache("chantiers"); const chs = caches.chantiers || [];
  const d = await modalForm("Affecter le matériel", [{ key: "chantier_id", label: "Chantier", type: "select", options: [{ value: "", label: "— aucun —" }, ...chs.map((c) => ({ value: c.id, label: c.code + " — " + c.nom }))] }, { key: "etat", label: "État", type: "select", options: opt(["en_service", "disponible", "maintenance", "hs"]) }]);
  if (!d) return; await api("/api/materiel/" + id + "/affecter", { method: "POST", body: JSON.stringify(d) }); renderMateriel();
}
async function maintenanceMateriel(id) {
  const d = await modalForm("Intervention de maintenance", [{ key: "date_maintenance", label: "Date", type: "date" }, { key: "type", label: "Type" }, { key: "cout", label: "Coût (MAD)", type: "number" }, { key: "note", label: "Note" }], { date_maintenance: new Date().toISOString().slice(0, 10) });
  if (!d) return; await api("/api/materiel/" + id + "/maintenance", { method: "POST", body: JSON.stringify(d) }); renderMateriel();
}

/* ===================== Rapports de chantier (photos) ===================== */
let rapPhotos = [];
async function renderRapports() {
  await getCache("chantiers");
  const list = await api("/api/rapports");
  V().innerHTML = `<div class="bar"><div><h1>Rapports de chantier</h1><div class="sub">Visites terrain avec photos · export PDF</div></div>
    <button class="btn sm" onclick="newRapport()">+ Rapport</button></div>
  <div class="card"><table><thead><tr><th>Date</th><th>Chantier</th><th>Météo</th><th class="r">Effectif</th><th class="r">Photos</th><th></th></tr></thead><tbody>
  ${list.length ? list.map((r) => `<tr><td>${new Date(r.date_rapport).toLocaleDateString("fr-FR")}</td><td>${r.chantier_code ? r.chantier_code + " — " + (r.chantier_nom || "") : "—"}</td><td>${r.meteo || ""}</td><td class="r">${r.effectif || 0}</td><td class="r">${r.nb_photos || 0} 📷</td>
    <td class="r"><button class="btn sm ghost" onclick="viewRapport(${r.id})">Voir</button> <button class="btn sm ghost" onclick="downloadDoc('/api/rapports/${r.id}/pdf','rapport-${r.id}.pdf')">📄 PDF</button> <button class="btn sm danger" onclick="delRapport(${r.id})">×</button></td></tr>`).join("") : `<tr><td colspan="6" class="muted">Aucun rapport.</td></tr>`}
  </tbody></table></div>`;
}
function newRapport() {
  const chs = caches.chantiers || []; rapPhotos = [];
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>Nouveau rapport de chantier</h3>
    <div class="mform">
      <div class="field"><label>Chantier</label><select id="rp-ch">${chs.map((c) => `<option value="${c.id}">${c.code} — ${c.nom}</option>`).join("")}</select></div>
      <div class="field"><label>Date</label><input type="date" id="rp-date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>Météo</label><input id="rp-meteo" placeholder="Ensoleillé, pluie…"></div>
      <div class="field"><label>Effectif présent</label><input type="number" id="rp-eff" value="0"></div>
      <div class="field" style="grid-column:1/-1"><label>Avancement</label><input id="rp-av"></div>
      <div class="field" style="grid-column:1/-1"><label>Observations</label><input id="rp-obs"></div>
    </div>
    <div class="colhead" style="margin-top:10px">Photos (jusqu'à 12)</div>
    <input type="file" accept="image/*" multiple onchange="addRapPhotos(this)">
    <div id="rp-photos" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px"></div>
    <div class="mactions"><button class="btn ghost" onclick="el('modal-root').innerHTML=''">Annuler</button><button class="btn" onclick="saveRapport()">Enregistrer</button></div>
    </div></div>`;
}
function addRapPhotos(input) {
  [...input.files].slice(0, 12).forEach((file) => {
    const rd = new FileReader();
    rd.onload = () => { const img = new Image(); img.onload = () => { const max = 1000, sc = Math.min(1, max / img.width); const cv = document.createElement("canvas"); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc); cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); rapPhotos.push({ data: cv.toDataURL("image/jpeg", 0.7), legende: "" }); drawRapPhotos(); }; img.src = rd.result; };
    rd.readAsDataURL(file);
  });
  input.value = "";
}
function drawRapPhotos() { el("rp-photos").innerHTML = rapPhotos.map((p, i) => `<div style="position:relative"><img src="${p.data}" style="width:90px;height:70px;object-fit:cover;border-radius:8px;border:1px solid var(--line)"><button class="btn sm danger" style="position:absolute;top:-6px;right:-6px;padding:1px 6px" onclick="rapPhotos.splice(${i},1);drawRapPhotos()">×</button></div>`).join(""); }
async function saveRapport() {
  const body = { chantier_id: +el("rp-ch").value, date_rapport: el("rp-date").value, meteo: el("rp-meteo").value, effectif: +el("rp-eff").value || 0, avancement: el("rp-av").value, observations: el("rp-obs").value, photos: rapPhotos };
  try { await api("/api/rapports", { method: "POST", body: JSON.stringify(body) }); el("modal-root").innerHTML = ""; renderRapports(); } catch (e) { alert(e.message); }
}
async function viewRapport(id) {
  const r = await api("/api/rapports/" + id);
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>Rapport — ${new Date(r.date_rapport).toLocaleDateString("fr-FR")}</h3>
    <div class="muted" style="margin-bottom:8px">Météo : ${r.meteo || "—"} · Effectif : ${r.effectif || 0}</div>
    <div><b>Avancement :</b> ${r.avancement || "—"}</div><div style="margin:6px 0"><b>Observations :</b> ${r.observations || "—"}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">${(r.photos || []).map((p) => `<img src="${p.data}" style="width:150px;height:115px;object-fit:cover;border-radius:8px;border:1px solid var(--line)">`).join("") || '<span class="muted">Aucune photo.</span>'}</div>
    <div class="mactions"><button class="btn ghost" onclick="el('modal-root').innerHTML=''">Fermer</button><button class="btn" onclick="downloadDoc('/api/rapports/${id}/pdf','rapport-${id}.pdf')">📄 PDF</button></div>
    </div></div>`;
}
async function delRapport(id) { if (confirm("Supprimer ce rapport ?")) { await api("/api/rapports/" + id, { method: "DELETE" }); renderRapports(); } }

/* ===================== Centre d'alertes ===================== */
async function renderAlertes() {
  const d = await api("/api/alertes");
  const ic = { stock: "📦", securite: "⛑️", conges: "🌴", materiel: "🚜", planning: "📅", tresorerie: "💰" };
  V().innerHTML = `<div class="bar"><div><h1>Centre d'alertes</h1><div class="sub">${d.total ? d.total + " point(s) d'attention" : "Tout est à jour"}</div></div></div>
  ${d.alertes.length ? `<div class="grid" style="gap:12px">${d.alertes.map((a) => `<button class="card" style="display:flex;align-items:center;gap:14px;text-align:left;cursor:pointer;border-left:4px solid ${a.severite === "alerte" ? "var(--rose)" : "var(--amber)"}" onclick="show('${a.view}')">
    <span style="font-size:24px">${ic[a.type] || "🔔"}</span>
    <div><div style="font-weight:700">${a.message}</div><div class="muted" style="font-size:12px">Cliquez pour ouvrir le module</div></div>
    <span class="pill" style="margin-left:auto;${a.severite === "alerte" ? "background:var(--rose-bg);color:var(--rose)" : "background:var(--amber-bg);color:var(--amber)"}">${a.count}</span></button>`).join("")}</div>`
    : `<div class="card" style="text-align:center;padding:40px"><div style="font-size:40px">✅</div><div style="font-weight:700;margin-top:8px">Aucune alerte</div><div class="muted">Tout est sous contrôle.</div></div>`}`;
}
async function refreshAlertBadge() {
  try { const d = await api("/api/alertes"); const nav = document.querySelector('.nav[data-view="alertes"]'); if (nav) nav.innerHTML = "🔔 Alertes" + (d.total ? ` <span class="badge">${d.total}</span>` : ""); } catch { /* ignore */ }
}

/* ===================== Super Admin (SaaS) ===================== */
const PLAN_LABEL = { "48h": "Essai 48h", "30j": "30 jours", "1an": "1 an", "avie": "À vie" };
async function renderSuperAdmin() {
  const list = await api("/api/admin/overview");
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString("fr-FR") : "—";
  V().innerHTML = `<div class="bar"><div><h1>👑 Super Admin</h1><div class="sub">Gestion des clients, abonnements et utilisateurs</div></div>
    <button class="btn sm" onclick="show('onboarding')">+ Nouvel abonné</button></div>
  <div class="grid kpis" style="margin-bottom:16px">
    <div class="card kpi"><div class="lbl">30 jours</div><div class="val mono">99 <small>DH</small></div></div>
    <div class="card kpi"><div class="lbl">1 an</div><div class="val mono">990 <small>DH</small></div></div>
    <div class="card kpi ok"><div class="lbl">À vie</div><div class="val mono">3990 <small>DH</small></div></div>
    <div class="card kpi flat"><div class="lbl">Clients</div><div class="val mono">${list.length}</div></div></div>
  <div class="card"><div class="colhead">Sociétés clientes</div>
    <table><thead><tr><th>Société</th><th>Formule</th><th>Échéance</th><th>Statut</th><th class="r">Users</th><th></th></tr></thead><tbody>
    ${list.map((c) => `<tr>
      <td><b>${c.raison_sociale || ""}</b>${c.ville ? '<div class="muted" style="font-size:12px">' + c.ville + "</div>" : ""}</td>
      <td>${c.plan ? PLAN_LABEL[c.plan] || c.plan : "—"}</td>
      <td>${c.plan === "avie" ? "Illimité" : fmtDate(c.abonnement_fin)}</td>
      <td>${c.expire ? '<span class="pill" style="background:var(--rose-bg);color:var(--rose)">Expiré</span>' : '<span class="pill" style="background:var(--green-bg);color:var(--green)">Actif</span>'}</td>
      <td class="r">${c.nb_users}</td>
      <td class="r">
        <select class="stsel" onchange="setPlan(${c.id},this.value)"><option value="">Activer…</option><option value="48h">Essai 48h (gratuit)</option><option value="30j">30 jours (99)</option><option value="1an">1 an (990)</option><option value="avie">À vie (3990)</option></select>
        <button class="btn sm ${c.actif ? "danger" : ""}" onclick="toggleEtat(${c.id},${c.actif ? "false" : "true"})">${c.actif ? "Suspendre" : "Réactiver"}</button>
        <button class="btn sm ghost" onclick="adminUsers(${c.id},'${(c.raison_sociale || "").replace(/'/g, "")}')">👤 Utilisateurs</button>
        <button class="btn sm danger" onclick="delCompany(${c.id},'${(c.raison_sociale || "").replace(/'/g, "")}')">🗑 Supprimer</button>
      </td></tr>`).join("")}
    </tbody></table></div>
  <div class="card" style="margin-top:16px;max-width:600px">
    <div class="colhead">🔑 Réinitialiser un mot de passe</div>
    <div class="muted" style="font-size:12px;margin-bottom:10px">Un client a perdu son mot de passe ? Saisis son email et un nouveau mot de passe — il pourra se reconnecter immédiatement.</div>
    <div class="form" style="grid-template-columns:1fr 1fr">
      <div class="field"><label>Email du client</label><input id="rp-email" placeholder="client@exemple.ma"></div>
      <div class="field"><label>Nouveau mot de passe</label><input id="rp-newpwd" type="text" placeholder="ex : BtpPro2026"></div>
    </div>
    <div class="mactions" style="justify-content:flex-start"><button class="btn" onclick="resetPwdByEmail()">Réinitialiser le mot de passe</button></div>
    <div id="rp-msg" style="margin-top:10px;font-size:13px"></div>
  </div>
  <div class="muted" style="margin-top:12px;font-size:13px">💡 L'activation est manuelle : tu encaisses le paiement du client, puis tu choisis sa formule ici. Les mises à jour de l'application (suite aux retours des clients) se déploient en poussant le code sur GitHub.</div>`;
}
async function resetPwdByEmail() {
  const email = el("rp-email").value.trim(), pwd = el("rp-newpwd").value;
  const msg = el("rp-msg");
  if (!email || !pwd) { msg.innerHTML = '<span class="err">Email et nouveau mot de passe requis.</span>'; return; }
  try {
    const r = await api("/api/admin/reset-password", { method: "POST", body: JSON.stringify({ email, password: pwd }) });
    msg.innerHTML = `✅ Mot de passe réinitialisé pour <b>${r.email}</b>. Communique-lui : <b>${pwd}</b>`;
    el("rp-email").value = ""; el("rp-newpwd").value = "";
  } catch (e) { msg.innerHTML = '<span class="err">' + e.message + "</span>"; }
}
async function setPlan(id, plan) {
  if (!plan) return;
  if (!confirm("Activer la formule « " + (PLAN_LABEL[plan] || plan) + " » pour ce client ?")) { renderSuperAdmin(); return; }
  try { await api("/api/admin/companies/" + id + "/abonnement", { method: "POST", body: JSON.stringify({ plan }) }); renderSuperAdmin(); } catch (e) { alert(e.message); }
}
async function toggleEtat(id, actif) {
  try { await api("/api/admin/companies/" + id + "/etat", { method: "POST", body: JSON.stringify({ actif }) }); renderSuperAdmin(); } catch (e) { alert(e.message); }
}
async function delCompany(id, nom) {
  if (!confirm("⚠️ SUPPRIMER définitivement le client « " + nom + " » ?\n\nToutes ses données (chantiers, devis, factures, paie, utilisateurs…) seront EFFACÉES. Cette action est irréversible.")) return;
  if (!confirm("Dernière confirmation : supprimer « " + nom + " » et tout son contenu ?")) return;
  try { await api("/api/admin/companies/" + id, { method: "DELETE" }); alert("Client supprimé."); renderSuperAdmin(); } catch (e) { alert(e.message); }
}
async function adminUsers(companyId, nom) {
  const users = await api("/api/admin/users?company_id=" + companyId);
  el("modal-root").innerHTML = `<div class="overlay"><div class="modal wide"><h3>Utilisateurs — ${nom}</h3>
    <table><thead><tr><th>Email</th><th>Nom</th><th>Rôle</th><th></th></tr></thead><tbody>
    ${users.length ? users.map((u) => `<tr><td class="mono">${u.email}</td><td>${u.full_name || ""}</td><td>${u.role}</td>
      <td class="r"><button class="btn sm ghost" onclick="resetPwd(${u.id},'${u.email.replace(/'/g, "")}')">🔑 Mot de passe</button> <button class="btn sm danger" onclick="adminDelUser(${u.id},${companyId},'${nom.replace(/'/g, "")}')">×</button></td></tr>`).join("") : `<tr><td colspan="4" class="muted">Aucun utilisateur.</td></tr>`}
    </tbody></table>
    <div class="colhead" style="margin-top:14px">Créer un utilisateur</div>
    <div class="form" style="grid-template-columns:1fr 1fr">
      <div class="field"><label>Email</label><input id="nu-email"></div>
      <div class="field"><label>Nom complet</label><input id="nu-name"></div>
      <div class="field"><label>Mot de passe</label><input id="nu-pwd" type="text"></div>
      <div class="field"><label>Rôle</label><select id="nu-role"><option>DIRECTEUR</option><option>RH</option><option>COMPTABLE</option><option>CHEF_CHANTIER</option><option>OUVRIER</option></select></div>
    </div>
    <div class="mactions"><button class="btn ghost" onclick="el('modal-root').innerHTML=''">Fermer</button><button class="btn" onclick="adminCreateUser(${companyId},'${nom.replace(/'/g, "")}')">Créer</button></div>
    </div></div>`;
}
async function adminCreateUser(companyId, nom) {
  const body = { email: el("nu-email").value, full_name: el("nu-name").value, password: el("nu-pwd").value, role: el("nu-role").value, company_id: companyId };
  if (!body.email || !body.password) { alert("Email et mot de passe requis."); return; }
  try { await api("/api/admin/users", { method: "POST", body: JSON.stringify(body) }); adminUsers(companyId, nom); } catch (e) { alert(e.message); }
}
async function resetPwd(id, email) {
  const pwd = prompt("Nouveau mot de passe pour " + email + " :", "");
  if (!pwd) return;
  try { await api("/api/admin/users/" + id + "/password", { method: "POST", body: JSON.stringify({ password: pwd }) }); alert("Mot de passe réinitialisé pour " + email + "."); } catch (e) { alert(e.message); }
}
async function adminDelUser(id, companyId, nom) {
  if (!confirm("Supprimer cet utilisateur ?")) return;
  try { await api("/api/admin/users/" + id, { method: "DELETE" }); adminUsers(companyId, nom); } catch (e) { alert(e.message); }
}

/* ===================== Bordereau des prix (module de saisie) ===================== */
let bordEdit = null;
const bordEsc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const bordNewModel = () => ({ marche: "", maitre_ouvrage: "", objet: "", client: "", client_ice: "", chapitres: [{ titre: "", lignes: [{ num: "", designation: "", unite: "", quantite: "", pu: "" }] }] });
async function renderBordereaux() {
  const list = await api("/api/bordereaux");
  V().innerHTML = `<div class="bar"><div><h1>Bordereaux des prix</h1><div class="sub">Détail estimatif pour appels d'offres — saisie par chapitres et lignes, totaux automatiques</div></div>
    <button class="btn sm" onclick="editBordereau()">+ Nouveau bordereau</button></div>
  <div class="card"><table><thead><tr><th>N°</th><th>Objet</th><th>Client</th><th class="r">Total TTC</th><th></th></tr></thead><tbody>
  ${list.length ? list.map((b) => `<tr><td class="mono">${b.numero || b.id}</td><td>${b.objet || ""}</td><td>${b.client || ""}</td><td class="r mono">${fmt(b.total_ttc)}</td>
    <td class="r"><button class="btn sm" onclick="editBordereau(${b.id})">Éditer</button> <button class="btn sm ghost" onclick="downloadDoc('/api/bordereaux/${b.id}/excel','bordereau-${b.numero || b.id}.xlsx')">Excel</button> <button class="btn sm ghost" onclick="downloadDoc('/api/bordereaux/${b.id}/pdf','bordereau-${b.numero || b.id}.pdf')">PDF</button> <button class="btn sm danger" onclick="delBordereau(${b.id})">×</button></td></tr>`).join("") : `<tr><td colspan="5" class="muted">Aucun bordereau. Cliquez « + Nouveau bordereau ».</td></tr>`}
  </tbody></table></div>`;
}
async function editBordereau(id) {
  if (id) { const b = await api("/api/bordereaux/" + id); const c = Array.isArray(b.contenu) ? b.contenu : JSON.parse(b.contenu || "[]"); bordEdit = { id: b.id, numero: b.numero, marche: b.marche || "", maitre_ouvrage: b.maitre_ouvrage || "", objet: b.objet || "", client: b.client || "", client_ice: b.client_ice || "", chapitres: c.length ? c : bordNewModel().chapitres }; }
  else bordEdit = bordNewModel();
  renderBordEditor();
}
function renderBordEditor() {
  const b = bordEdit;
  V().innerHTML = `
  <div class="bar"><div><h1>${b.id ? "Bordereau " + (b.numero || "") : "Nouveau bordereau"}</h1><div class="sub">Ajoute tes chapitres et tes lignes — les totaux se calculent en direct</div></div>
    <div style="display:flex;gap:8px"><button class="btn ghost" onclick="show('bordereaux')">← Retour</button><button class="btn ghost" onclick="printBordereau()">🖨️ Imprimer (PDF)</button><button class="btn" onclick="saveBordereau()">💾 Enregistrer</button></div></div>
  <div class="card" style="margin-bottom:14px"><div class="form" style="grid-template-columns:1fr 1fr 1fr">
    <div class="field"><label>Marché n°</label><input data-h="marche" value="${bordEsc(b.marche)}" oninput="bordSync(this)"></div>
    <div class="field"><label>Maître d'ouvrage</label><input data-h="maitre_ouvrage" value="${bordEsc(b.maitre_ouvrage)}" oninput="bordSync(this)"></div>
    <div class="field"><label>Objet</label><input data-h="objet" value="${bordEsc(b.objet)}" oninput="bordSync(this)"></div>
    <div class="field"><label>Client</label><input data-h="client" value="${bordEsc(b.client)}" oninput="bordSync(this)"></div>
    <div class="field"><label>ICE client</label><input data-h="client_ice" value="${bordEsc(b.client_ice)}" oninput="bordSync(this)"></div>
  </div></div>
  ${b.chapitres.map((ch, ci) => bordChapterCard(ch, ci)).join("")}
  <button class="btn ghost" onclick="bordAddChapter()" style="margin:4px 0 14px">➕ Ajouter un chapitre</button>
  <div class="card" style="max-width:420px;margin-left:auto">
    <div class="trow"><span>Total HT</span><b class="mono" id="bd-ht">0,00</b></div>
    <div class="trow"><span>TVA 20 %</span><b class="mono" id="bd-tva">0,00</b></div>
    <div class="trow big"><span>Total TTC</span><b class="mono" id="bd-ttc">0,00</b></div>
  </div>`;
  bordRecalc();
}
function bordChapterCard(ch, ci) {
  return `<div class="card" style="margin-bottom:12px">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <span class="pill">Chap. ${ci + 1}</span>
      <input data-ci="${ci}" data-li="" data-f="titre" value="${bordEsc(ch.titre)}" oninput="bordSync(this)" placeholder="Titre du chapitre (ex : GROS ŒUVRE)" style="flex:1;font-weight:700">
      <button class="btn sm danger" onclick="bordDelChapter(${ci})">Suppr. chapitre</button>
    </div>
    <table class="bordtab"><thead><tr><th style="width:58px">N°</th><th>Désignation</th><th style="width:52px">U</th><th style="width:88px">Quantité</th><th style="width:104px">P.U. HT</th><th style="width:110px" class="r">Total</th><th style="width:34px"></th></tr></thead><tbody>
    ${ch.lignes.map((l, li) => `<tr>
      <td><input data-ci="${ci}" data-li="${li}" data-f="num" value="${bordEsc(l.num)}" oninput="bordSync(this)"></td>
      <td><input data-ci="${ci}" data-li="${li}" data-f="designation" value="${bordEsc(l.designation)}" oninput="bordSync(this)"></td>
      <td><input data-ci="${ci}" data-li="${li}" data-f="unite" value="${bordEsc(l.unite)}" oninput="bordSync(this)"></td>
      <td><input type="number" step="any" data-ci="${ci}" data-li="${li}" data-f="quantite" value="${bordEsc(l.quantite)}" oninput="bordSync(this)"></td>
      <td><input type="number" step="any" data-ci="${ci}" data-li="${li}" data-f="pu" value="${bordEsc(l.pu)}" oninput="bordSync(this)"></td>
      <td class="r mono" id="lt-${ci}-${li}">0,00</td>
      <td><button class="btn sm danger" onclick="bordDelLine(${ci},${li})">×</button></td></tr>`).join("")}
    </tbody></table>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
      <button class="btn sm" onclick="bordAddLine(${ci})">+ Ajouter une ligne</button>
      <div class="muted">Sous-total : <b class="mono" id="st-${ci}">0,00</b> MAD</div>
    </div>
  </div>`;
}
function bordSync(inp) {
  const d = inp.dataset;
  if (d.h) { bordEdit[d.h] = inp.value; return; }
  if (d.li !== undefined && d.li !== "") { bordEdit.chapitres[+d.ci].lignes[+d.li][d.f] = inp.value; if (d.f === "quantite" || d.f === "pu") bordRecalc(); return; }
  if (d.ci !== undefined && d.ci !== "") bordEdit.chapitres[+d.ci][d.f] = inp.value;
}
function bordAddChapter() { bordEdit.chapitres.push({ titre: "", lignes: [{ num: "", designation: "", unite: "", quantite: "", pu: "" }] }); renderBordEditor(); }
function bordDelChapter(ci) { if (confirm("Supprimer ce chapitre ?")) { bordEdit.chapitres.splice(ci, 1); if (!bordEdit.chapitres.length) bordEdit.chapitres = bordNewModel().chapitres; renderBordEditor(); } }
function bordAddLine(ci) { bordEdit.chapitres[ci].lignes.push({ num: "", designation: "", unite: "", quantite: "", pu: "" }); renderBordEditor(); }
function bordDelLine(ci, li) { bordEdit.chapitres[ci].lignes.splice(li, 1); if (!bordEdit.chapitres[ci].lignes.length) bordEdit.chapitres[ci].lignes.push({ num: "", designation: "", unite: "", quantite: "", pu: "" }); renderBordEditor(); }
function bordRecalc() {
  let ht = 0;
  bordEdit.chapitres.forEach((ch, ci) => { let st = 0; ch.lignes.forEach((l, li) => { const t = (Number(l.quantite) || 0) * (Number(l.pu) || 0); st += t; const c = el("lt-" + ci + "-" + li); if (c) c.textContent = fmt(t); }); const sc = el("st-" + ci); if (sc) sc.textContent = fmt(st); ht += st; });
  const tva = ht * 0.2; const e1 = el("bd-ht"), e2 = el("bd-tva"), e3 = el("bd-ttc");
  if (e1) e1.textContent = fmt(ht); if (e2) e2.textContent = fmt(tva); if (e3) e3.textContent = fmt(ht + tva);
}
async function saveBordereau() {
  const b = bordEdit;
  const payload = { marche: b.marche, maitre_ouvrage: b.maitre_ouvrage, objet: b.objet, client: b.client, client_ice: b.client_ice, contenu: b.chapitres };
  try {
    const saved = b.id ? await api("/api/bordereaux/" + b.id, { method: "PUT", body: JSON.stringify(payload) }) : await api("/api/bordereaux", { method: "POST", body: JSON.stringify(payload) });
    bordEdit.id = saved.id; bordEdit.numero = saved.numero;
    alert("Bordereau " + (saved.numero || "") + " enregistré. Tu peux l'exporter en Excel ou PDF depuis la liste.");
    renderBordEditor();
  } catch (e) { alert(e.message); }
}
async function printBordereau() {
  const b = bordEdit;
  const payload = { marche: b.marche, maitre_ouvrage: b.maitre_ouvrage, objet: b.objet, client: b.client, client_ice: b.client_ice, contenu: b.chapitres };
  try {
    const saved = b.id ? await api("/api/bordereaux/" + b.id, { method: "PUT", body: JSON.stringify(payload) }) : await api("/api/bordereaux", { method: "POST", body: JSON.stringify(payload) });
    bordEdit.id = saved.id; bordEdit.numero = saved.numero;
    await openDoc("/api/bordereaux/" + saved.id + "/pdf");
  } catch (e) { alert(e.message); }
}
async function delBordereau(id) { if (confirm("Supprimer ce bordereau ?")) { await api("/api/bordereaux/" + id, { method: "DELETE" }); renderBordereaux(); } }

/* ===================== Comptabilité / TVA ===================== */
let comptaPeriod = null;
async function renderCompta() {
  if (!comptaPeriod) comptaPeriod = { annee: period.annee, mois: period.mois };
  const d = await api(`/api/compta?annee=${comptaPeriod.annee}&mois=${comptaPeriod.mois}`);
  V().innerHTML = `
  <div class="bar"><div><h1>Comptabilité — TVA</h1><div class="sub">${MOIS[comptaPeriod.mois - 1]} ${comptaPeriod.annee} · régime ${d.regime} (CA annuel ${fmt(d.ca_annuel)} MAD)</div></div>
    <div style="display:flex;gap:6px"><button class="btn sm ghost" onclick="shiftCompta(-1)">← Mois</button><button class="btn sm ghost" onclick="shiftCompta(1)">Mois →</button></div></div>
  <div class="grid kpis">
    <div class="card kpi"><div class="lbl">TVA collectée (ventes)</div><div class="val mono">${fmt(d.tva_collectee)} <small>MAD</small></div></div>
    <div class="card kpi"><div class="lbl">TVA déductible (achats)</div><div class="val mono">${fmt(d.tva_deductible)} <small>MAD</small></div></div>
    <div class="card kpi ${d.tva_due >= 0 ? "alert" : "ok"}"><div class="lbl">${d.tva_due >= 0 ? "TVA à payer" : "Crédit de TVA"}</div><div class="val mono">${fmt(Math.abs(d.tva_due))} <small>MAD</small></div></div>
    <div class="card kpi flat"><div class="lbl">CA HT du mois</div><div class="val mono">${fmt(d.ca_ht)} <small>MAD</small></div></div></div>
  <div class="card" style="margin-top:6px"><div class="warn">ℹ️ <span>TVA déductible estimée à 20 % des achats. Télédéclaration obligatoire sur le portail SIMPL-TVA avant le 20 du mois suivant (régime <b>${d.regime}</b>).</span></div></div>
  <div class="card" style="margin-top:14px"><div class="colhead">Journal des ventes</div>
    <table><thead><tr><th>Date</th><th>Pièce</th><th>Client</th><th>Type</th><th class="r">HT</th><th class="r">TVA</th><th class="r">TTC</th></tr></thead><tbody>
    ${d.ventes.length ? d.ventes.map((v) => `<tr><td>${new Date(v.date).toLocaleDateString("fr-FR")}</td><td class="mono">${v.numero || ""}</td><td>${v.tiers || ""}</td><td>${v.type}</td><td class="r mono">${fmt(v.ht)}</td><td class="r mono">${fmt(v.tva)}</td><td class="r mono">${fmt(v.ttc)}</td></tr>`).join("") : `<tr><td colspan="7" class="muted">Aucune vente ce mois.</td></tr>`}
    </tbody></table></div>
  <div class="card" style="margin-top:14px"><div class="colhead">Journal des achats</div>
    <table><thead><tr><th>Date</th><th>Pièce</th><th>Fournisseur</th><th class="r">HT</th><th class="r">TVA</th><th class="r">TTC</th></tr></thead><tbody>
    ${d.achats.length ? d.achats.map((a) => `<tr><td>${new Date(a.date).toLocaleDateString("fr-FR")}</td><td class="mono">${a.numero || ""}</td><td>${a.tiers || ""}</td><td class="r mono">${fmt(a.ht)}</td><td class="r mono">${fmt(a.tva)}</td><td class="r mono">${fmt(a.ttc)}</td></tr>`).join("") : `<tr><td colspan="6" class="muted">Aucun achat ce mois.</td></tr>`}
    </tbody></table></div>`;
}
function shiftCompta(dlt) { let m = comptaPeriod.mois + dlt, y = comptaPeriod.annee; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } comptaPeriod = { annee: y, mois: m }; renderCompta(); }

/* ===================== Journal d'activité ===================== */
async function renderActivite() {
  const rows = await api("/api/activite?limit=200");
  const act = { POST: "Création", PUT: "Modification", PATCH: "Modification", DELETE: "Suppression" };
  V().innerHTML = `<div class="bar"><div><h1>Journal d'activité</h1><div class="sub">Traçabilité des opérations (200 dernières)</div></div></div>
  <div class="card"><table><thead><tr><th>Date & heure</th><th>Utilisateur</th><th>Action</th><th>Cible</th></tr></thead><tbody>
  ${rows.length ? rows.map((r) => `<tr><td>${new Date(r.created_at).toLocaleString("fr-FR")}</td><td>${r.user_email || ""}</td><td><span class="pill">${act[r.action] || r.action}</span></td><td class="mono" style="font-size:12px">${r.cible || ""}</td></tr>`).join("") : `<tr><td colspan="4" class="muted">Aucune activité enregistrée.</td></tr>`}
  </tbody></table></div>`;
}

/* ===================== Onboarding (nouveau client) ===================== */
function renderOnboarding() {
  V().innerHTML = `<div class="bar"><div><h1>Nouvel abonné</h1><div class="sub">Créer une société abonnée à BTP360 et son compte administrateur (réservé au super-administrateur)</div></div></div>
  <div class="card" style="max-width:700px">
    <div class="colhead">Société abonnée</div>
    <div class="form" style="grid-template-columns:1fr 1fr" autocomplete="off">
      <div class="field"><label>Raison sociale *</label><input id="ob-rs" autocomplete="off"></div>
      <div class="field"><label>ICE</label><input id="ob-ice" autocomplete="off"></div>
      <div class="field"><label>Ville</label><input id="ob-ville" autocomplete="off"></div>
      <div class="field"><label>Téléphone</label><input id="ob-tel" autocomplete="off"></div>
    </div>
    <div class="colhead" style="margin-top:16px">Compte administrateur (Directeur)</div>
    <div class="form" style="grid-template-columns:1fr 1fr">
      <div class="field"><label>Nom complet</label><input id="ob-name" autocomplete="off"></div>
      <div class="field"><label>Email de l'abonné *</label><input id="ob-email" type="text" inputmode="email" autocomplete="off" readonly onfocus="this.removeAttribute('readonly')" placeholder="email du nouveau client"></div>
      <div class="field" style="grid-column:1/-1"><label>Mot de passe *</label><input id="ob-pwd" type="password" autocomplete="new-password" readonly onfocus="this.removeAttribute('readonly')" placeholder="mot de passe pour ce client"></div>
    </div>
    <div class="mactions"><button class="btn" onclick="saveOnboarding()">Créer l'abonné</button></div>
    <div id="ob-msg" style="margin-top:10px;font-size:13px"></div>
  </div>`;
}
async function saveOnboarding() {
  const body = { company: { raison_sociale: el("ob-rs").value, ice: el("ob-ice").value, ville: el("ob-ville").value, telephone: el("ob-tel").value }, user: { full_name: el("ob-name").value, email: el("ob-email").value.trim(), password: el("ob-pwd").value } };
  if (!body.company.raison_sociale || !body.user.email || !body.user.password) { el("ob-msg").innerHTML = '<span class="err">Raison sociale, email et mot de passe sont requis.</span>'; return; }
  try { const r = await api("/api/onboarding", { method: "POST", body: JSON.stringify(body) }); el("ob-msg").innerHTML = `✅ Abonné « ${r.company.raison_sociale} » créé. L'administrateur se connecte avec <b>${r.user.email}</b> et verra uniquement sa société.`; }
  catch (e) { el("ob-msg").innerHTML = '<span class="err">Erreur : ' + e.message + "</span>"; }
}

/* ===================== Intégrations (adaptateurs cadrés) ===================== */
let intgPeriod = null;
function renderIntegrations() {
  if (!intgPeriod) intgPeriod = { annee: period.annee, mois: period.mois };
  const planned = [
    ["SIMPL-IR (DGI)", "Déclaration de l'IR sur salaires"],
    ["Google Maps", "Géolocalisation des chantiers"],
    ["WhatsApp / SMS", "Notifications aux équipes et clients"],
    ["Virement bancaire", "Exécution des virements de paie"],
  ];
  V().innerHTML = `<div class="bar"><div><h1>Intégrations & conformité</h1><div class="sub">Période ${MOIS[intgPeriod.mois - 1]} ${intgPeriod.annee}</div></div>
    <div style="display:flex;gap:6px"><button class="btn sm ghost" onclick="shiftIntg(-1)">← Mois</button><button class="btn sm ghost" onclick="shiftIntg(1)">Mois →</button></div></div>
  <div class="warn" style="margin-bottom:14px">⚠️ <span><b>Préparation, pas transmission.</b> La télédéclaration temps réel (DGI/SIMPL, CNSS/Damancom) exige un agrément officiel et des certificats. Ces exports te préparent le travail ; la transmission reste à faire sur les portails officiels (ou via ton comptable) jusqu'à activation des accès agréés.</span></div>
  <div class="grid" style="grid-template-columns:repeat(2,1fr)">
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><b>🟢 CNSS / Damancom</b><span class="pill" style="background:var(--green-bg);color:var(--green)">Préparation prête</span></div>
      <div class="muted" style="margin:8px 0">Génère le fichier de déclaration des salaires (matricules, jours, salaire réel et plafonné) à partir de la paie du mois — à importer/saisir dans Damancom.</div>
      <button class="btn sm" onclick="downloadDoc('/api/integrations/damancom?annee=${intgPeriod.annee}&mois=${intgPeriod.mois}','preparation-cnss-${intgPeriod.annee}-${intgPeriod.mois}.csv')">⬇️ Fichier déclaration CNSS</button></div>
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><b>🟢 DGI / E-facturation</b><span class="pill" style="background:var(--green-bg);color:var(--green)">Préparation prête</span></div>
      <div class="muted" style="margin:8px 0">Exporte les factures du mois en données structurées (ICE émetteur/client, TVA, totaux) conformes aux mentions de l'article 145 du CGI — base pour la future e-facturation.</div>
      <button class="btn sm" onclick="downloadDoc('/api/integrations/efacture?annee=${intgPeriod.annee}&mois=${intgPeriod.mois}','preparation-efacture-${intgPeriod.annee}-${intgPeriod.mois}.json')">⬇️ Données e-facture (JSON)</button></div>
  </div>
  <div class="colhead" style="margin-top:18px">Connecteurs prévus (à activer avec accès officiels)</div>
  <div class="grid" style="grid-template-columns:repeat(2,1fr)">
    ${planned.map(([n, d]) => `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><b>${n}</b><span class="pill">À configurer</span></div><div class="muted" style="margin-top:6px">${d}</div></div>`).join("")}
  </div>`;
}
function shiftIntg(dlt) { let m = intgPeriod.mois + dlt, y = intgPeriod.annee; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } intgPeriod = { annee: y, mois: m }; renderIntegrations(); }

/* ===================== Démarrage ===================== */
// Réapplique recherche + tri après chaque rendu (y compris re-rendus internes)
new MutationObserver(() => enhanceView()).observe(el("view"), { childList: true, subtree: true });
if (token && me) enterApp();

/* PWA : enregistrement du service worker (installation écran d'accueil + cache) */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
}
