require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const PDFDocument = require("pdfkit");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const ExcelJS = require("exceljs");

const { pool, initDb } = require("./src/db");
const { calculatePayroll, SETTINGS } = require("./src/payroll");
const { sign, verify, requireAuth, roleHasDomain, domainsForRole, ROLES } = require("./src/auth");
const { makeCrud } = require("./src/crud");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err); res.status(500).json({ error: "Erreur serveur", detail: err.message });
});

// ── RBAC : contrôle d'accès global par domaine ──
const PUBLIC = new Set(["/api/health", "/api/auth/login"]);
function domainOf(p) {
  if (p.startsWith("/api/auth") || p === "/api/me" || p === "/api/health") return null;
  if (p.startsWith("/api/users")) return "admin";
  if (p.startsWith("/api/payroll") || p.startsWith("/api/payslips")) return "paie";
  if (p.startsWith("/api/conges")) return "conges";
  if (p.startsWith("/api/employees") || p.startsWith("/api/organigramme") || p.startsWith("/api/evaluations") || p.startsWith("/api/contrats")) return "rh";
  if (p.startsWith("/api/chantiers") || p.startsWith("/api/affectations")) return "chantiers";
  if (p.startsWith("/api/incidents") || p.startsWith("/api/controles") || p.startsWith("/api/epi") || p.startsWith("/api/securite")) return "securite";
  if (p.startsWith("/api/documents") || p.startsWith("/api/signatures")) return "ged";
  if (p.startsWith("/api/devis") || p.startsWith("/api/ouvrages") || p.startsWith("/api/composants")) return "devis";
  if (p.startsWith("/api/factures")) return "facturation";
  if (p.startsWith("/api/paiements") || p.startsWith("/api/tresorerie")) return "facturation";
  if (p.startsWith("/api/pointages") || p.startsWith("/api/taches")) return "chantiers";
  if (p.startsWith("/api/materiel") || p.startsWith("/api/rapports")) return "chantiers";
  if (p.startsWith("/api/alertes")) return null;
  if (p.startsWith("/api/compta")) return "rentabilite";
  if (p.startsWith("/api/bordereau")) return "devis";
  if (p.startsWith("/api/activite") || p.startsWith("/api/onboarding")) return "admin";
  if (p.startsWith("/api/admin")) return "admin";
  if (p.startsWith("/api/articles") || p.startsWith("/api/stock")) return "stock";
  if (p.startsWith("/api/commandes") || p.startsWith("/api/demandes-achat") || p.startsWith("/api/bons-commande")) return "achats";
  if (p.startsWith("/api/fournisseur") || p.startsWith("/api/sous-traitants") || p.startsWith("/api/soustraitants") || p.startsWith("/api/st-")) return "tiers";
  if (p.startsWith("/api/dashboard/rentabilite")) return "rentabilite";
  if (p.startsWith("/api/dashboard")) return "dashboard";
  return null;
}
app.use("/api", async (req, res, next) => {
  const full = req.baseUrl + req.path; // req.path est relatif au montage "/api"
  if (PUBLIC.has(full)) return next();
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non authentifié" });
  try { req.user = verify(token); } catch { return res.status(401).json({ error: "Session expirée ou invalide" }); }
  req.companyId = Number(req.headers["x-company-id"]) || null; // société active (multi-société)
  const dom = domainOf(full);
  if (!roleHasDomain(req.user.role, dom)) return res.status(403).json({ error: "Accès refusé pour votre rôle (" + req.user.role + ")" });
  // Abonnement : blocage des sociétés clientes expirées/suspendues (le super-admin n'est jamais bloqué)
  if (req.user.company_id && full !== "/api/me" && !full.startsWith("/api/auth")) {
    try { if (!(await companyActive(req.user.company_id))) return res.status(402).json({ error: "Abonnement expiré ou suspendu. Contactez votre fournisseur pour le réactiver." }); }
    catch { /* en cas d'erreur DB, ne pas bloquer */ }
  }
  // Journal d'activité : trace des opérations modifiantes (après réponse)
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !full.startsWith("/api/export") && !full.startsWith("/api/auth")) {
    const email = req.user.email, companyId = Number(req.headers["x-company-id"]) || req.user.company_id || null;
    res.on("finish", () => {
      if (res.statusCode < 400) {
        pool.query("INSERT INTO activite (user_email,action,cible,statut,company_id) VALUES ($1,$2,$3,$4,$5)",
          [email, req.method, full.replace(/^\/api\//, ""), res.statusCode, companyId]).catch(() => {});
      }
    });
  }
  next();
});

// ── Société active (multi-société) ──
let DEFAULT_COMPANY_ID = null;
async function defaultCompany() {
  if (DEFAULT_COMPANY_ID) return DEFAULT_COMPANY_ID;
  DEFAULT_COMPANY_ID = (await pool.query("SELECT id FROM company ORDER BY id LIMIT 1")).rows[0]?.id || null;
  return DEFAULT_COMPANY_ID;
}
const cid = async (req) => (req.user && req.user.company_id) || req.companyId || (await defaultCompany());

// ── Abonnement (SaaS) ──
const PLAN_DUREE = { "48h": 2, "30j": 30, "1an": 365, "avie": null };
const subActive = (co) => co && co.actif !== false && (!co.abonnement_fin || new Date(co.abonnement_fin) > new Date());
const subCache = new Map();
async function companyActive(id) {
  const c = subCache.get(id); const now = Date.now();
  if (c && c.exp > now) return c.ok;
  const co = (await pool.query("SELECT actif, abonnement_fin FROM company WHERE id=$1", [id])).rows[0];
  const ok = subActive(co);
  subCache.set(id, { ok, exp: now + 15000 });
  return ok;
}

// ── Santé / Auth ──
app.get("/api/health", (_req, res) => res.json({ ok: true, annee: SETTINGS.annee }));
app.post("/api/auth/login", wrap(async (req, res) => {
  const { email, password, code } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });
  const { rows } = await pool.query("SELECT * FROM app_user WHERE email = $1", [String(email).toLowerCase()]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: "Identifiants incorrects" });
  // 2FA
  if (user.totp_enabled) {
    if (!code) return res.json({ require_2fa: true });
    if (!authenticator.check(String(code), user.totp_secret || ""))
      return res.status(401).json({ error: "Code 2FA incorrect" });
  }
  let subscription = null, blocked = false;
  if (user.company_id) {
    const co = (await pool.query("SELECT plan, abonnement_fin, actif FROM company WHERE id=$1", [user.company_id])).rows[0];
    subscription = co ? { plan: co.plan, fin: co.abonnement_fin, actif: co.actif } : null;
    blocked = !subActive(co);
  }
  res.json({ token: sign(user), user: { id: user.id, email: user.email, name: user.full_name, role: user.role, company_id: user.company_id || null, totp_enabled: user.totp_enabled }, subscription, blocked });
}));
app.get("/api/me", requireAuth, (req, res) =>
  res.json({ user: req.user, permissions: domainsForRole(req.user.role), roles: ROLES }));

// ── 2FA (TOTP) ──
app.post("/api/2fa/setup", requireAuth, wrap(async (req, res) => {
  const u = (await pool.query("SELECT email FROM app_user WHERE id=$1", [req.user.sub])).rows[0];
  const secret = authenticator.generateSecret();
  await pool.query("UPDATE app_user SET totp_secret=$2, totp_enabled=false WHERE id=$1", [req.user.sub, secret]);
  const uri = authenticator.keyuri(u.email, "BTPPro Maroc", secret);
  const qr = await QRCode.toDataURL(uri);
  res.json({ qr, secret, uri });
}));
app.post("/api/2fa/activate", requireAuth, wrap(async (req, res) => {
  const u = (await pool.query("SELECT totp_secret FROM app_user WHERE id=$1", [req.user.sub])).rows[0];
  if (!u.totp_secret) return res.status(400).json({ error: "Lancez d'abord la configuration 2FA" });
  if (!authenticator.check(String(req.body?.code || ""), u.totp_secret))
    return res.status(400).json({ error: "Code incorrect" });
  await pool.query("UPDATE app_user SET totp_enabled=true WHERE id=$1", [req.user.sub]);
  res.json({ ok: true, totp_enabled: true });
}));
app.post("/api/2fa/disable", requireAuth, wrap(async (req, res) => {
  const u = (await pool.query("SELECT totp_secret FROM app_user WHERE id=$1", [req.user.sub])).rows[0];
  if (u.totp_secret && !authenticator.check(String(req.body?.code || ""), u.totp_secret))
    return res.status(400).json({ error: "Code incorrect" });
  await pool.query("UPDATE app_user SET totp_enabled=false, totp_secret=NULL WHERE id=$1", [req.user.sub]);
  res.json({ ok: true, totp_enabled: false });
}));
app.get("/api/2fa/status", requireAuth, wrap(async (req, res) =>
  res.json({ totp_enabled: (await pool.query("SELECT totp_enabled FROM app_user WHERE id=$1", [req.user.sub])).rows[0]?.totp_enabled || false })));

// ── Sociétés (multi-société) ──
app.get("/api/companies", requireAuth, wrap(async (req, res) => {
  if (req.user.company_id)
    return res.json((await pool.query("SELECT id,raison_sociale,ice FROM company WHERE id=$1", [req.user.company_id])).rows);
  res.json((await pool.query("SELECT id,raison_sociale,ice FROM company ORDER BY id")).rows);
}));
app.post("/api/companies", requireAuth, wrap(async (req, res) => {
  if (req.user.role !== "DIRECTEUR") return res.status(403).json({ error: "Réservé au Directeur" });
  const { raison_sociale, ice } = req.body || {};
  if (!raison_sociale) return res.status(400).json({ error: "raison_sociale requise" });
  const { rows } = await pool.query("INSERT INTO company (raison_sociale,ice) VALUES ($1,$2) RETURNING id,raison_sociale,ice", [raison_sociale, ice || null]);
  res.status(201).json(rows[0]);
}));
app.get("/api/companies/:id", requireAuth, wrap(async (req, res) => {
  const c = (await pool.query("SELECT * FROM company WHERE id=$1", [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: "Introuvable" });
  res.json(c);
}));
app.put("/api/companies/:id", requireAuth, wrap(async (req, res) => {
  if (req.user.role !== "DIRECTEUR") return res.status(403).json({ error: "Réservé au Directeur" });
  const cols = ["raison_sociale","ice","adresse","ville","telephone","email","rc","if_fiscal","patente","cnss","rib","logo","tva_taux","devis_format","facture_format","devis_compteur","facture_compteur"]
    .filter((k) => req.body[k] !== undefined);
  if (!cols.length) return res.status(400).json({ error: "Aucune donnée" });
  const set = cols.map((c, i) => `${c}=$${i + 2}`).join(",");
  const { rows } = await pool.query(`UPDATE company SET ${set} WHERE id=$1 RETURNING *`, [req.params.id, ...cols.map((c) => req.body[c])]);
  res.json(rows[0]);
}));

// ── Gestion des utilisateurs (DIRECTEUR uniquement) ──
app.get("/api/users", requireAuth, wrap(async (_req, res) =>
  res.json((await pool.query("SELECT id,email,full_name,role,created_at FROM app_user ORDER BY id")).rows)));
app.post("/api/users", requireAuth, wrap(async (req, res) => {
  const { email, password, full_name, role } = req.body || {};
  if (!email || !password || !role) return res.status(400).json({ error: "email, password et role requis" });
  if (!ROLES.includes(role)) return res.status(400).json({ error: "Rôle invalide" });
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      "INSERT INTO app_user (email,password_hash,full_name,role) VALUES ($1,$2,$3,$4) RETURNING id,email,full_name,role",
      [String(email).toLowerCase(), hash, full_name || null, role]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Email déjà utilisé" });
    throw e;
  }
}));
app.delete("/api/users/:id", requireAuth, wrap(async (req, res) => {
  if (Number(req.params.id) === Number(req.user.sub)) return res.status(400).json({ error: "Impossible de supprimer son propre compte" });
  await pool.query("DELETE FROM app_user WHERE id=$1", [req.params.id]); res.json({ ok: true });
}));


// ── Salariés (RH) avec paie calculée ──
app.get("/api/employees", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.*, COALESCE(c.salaire_base, e.salaire_base) AS salaire_effectif, c.type AS contrat_type
    FROM employee e
    LEFT JOIN LATERAL (SELECT salaire_base, type FROM contrat WHERE employee_id=e.id AND actif ORDER BY date_debut DESC LIMIT 1) c ON true
    WHERE e.actif AND e.company_id = $1 ORDER BY e.matricule`, [await cid(req)]);
  res.json(rows.map((e) => ({ ...e, paie: calculatePayroll({ salaireBase: Number(e.salaire_effectif), moisAnciennete: e.mois_anciennete, personnesCharge: e.personnes_charge }) })));
}));
app.post("/api/employees", requireAuth, wrap(async (req, res) => {
  const { matricule, nom, poste, salaire_base, mois_anciennete = 0, personnes_charge = 0 } = req.body || {};
  if (!matricule || !nom || !salaire_base) return res.status(400).json({ error: "matricule, nom et salaire_base requis" });
  const { rows } = await pool.query(
    `INSERT INTO employee (matricule,nom,poste,salaire_base,mois_anciennete,personnes_charge,company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [matricule, nom, poste || null, salaire_base, mois_anciennete, personnes_charge, await cid(req)]);
  res.status(201).json(rows[0]);
}));
app.put("/api/employees/:id", requireAuth, wrap(async (req, res) => {
  const { nom, poste, cin, salaire_base, mois_anciennete, personnes_charge } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE employee SET nom=COALESCE($2,nom), poste=COALESCE($3,poste), cin=COALESCE($4,cin),
       salaire_base=COALESCE($5,salaire_base), mois_anciennete=COALESCE($6,mois_anciennete),
       personnes_charge=COALESCE($7,personnes_charge) WHERE id=$1 RETURNING *`,
    [req.params.id, nom, poste, cin, salaire_base, mois_anciennete, personnes_charge]);
  if (!rows[0]) return res.status(404).json({ error: "Salarié introuvable" });
  res.json(rows[0]);
}));
app.delete("/api/employees/:id", requireAuth, wrap(async (req, res) => {
  await pool.query("UPDATE employee SET actif=false WHERE id=$1", [req.params.id]); res.json({ ok: true });
}));

// ── RH approfondi : fiche salarié, contrats (historique), organigramme ──
app.get("/api/employees/:id/contrats", requireAuth, wrap(async (req, res) =>
  res.json((await pool.query("SELECT * FROM contrat WHERE employee_id=$1 ORDER BY date_debut DESC, id DESC", [req.params.id])).rows)));

app.post("/api/employees/:id/contrats", requireAuth, wrap(async (req, res) => {
  const { type, poste, salaire_base, date_debut, date_fin } = req.body || {};
  if (!salaire_base) return res.status(400).json({ error: "salaire_base requis" });
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    // Clôturer le contrat actif précédent
    await conn.query("UPDATE contrat SET actif=false WHERE employee_id=$1 AND actif", [req.params.id]);
    const c = (await conn.query(
      `INSERT INTO contrat (employee_id,type,poste,salaire_base,date_debut,date_fin,actif)
       VALUES ($1,$2,$3,$4,COALESCE($5,now()),$6,true) RETURNING *`,
      [req.params.id, type || "CDI", poste || null, salaire_base, date_debut || null, date_fin || null])).rows[0];
    // Synchroniser la fiche salarié (le contrat actif fait foi pour la paie)
    await conn.query("UPDATE employee SET salaire_base=$2, poste=COALESCE($3,poste) WHERE id=$1",
      [req.params.id, salaire_base, poste || null]);
    await conn.query("COMMIT");
    res.status(201).json(c);
  } catch (e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
}));

app.get("/api/employees/:id/fiche", requireAuth, wrap(async (req, res) => {
  const id = req.params.id;
  const e = (await pool.query("SELECT * FROM employee WHERE id=$1", [id])).rows[0];
  if (!e) return res.status(404).json({ error: "Salarié introuvable" });
  if (e.manager_id) e.manager = (await pool.query("SELECT nom,poste FROM employee WHERE id=$1", [e.manager_id])).rows[0];
  e.contrats = (await pool.query("SELECT * FROM contrat WHERE employee_id=$1 ORDER BY date_debut DESC, id DESC", [id])).rows;
  e.contrat_actif = e.contrats.find((c) => c.actif) || null;
  e.affectations = (await pool.query(
    `SELECT a.*, c.code AS chantier_code, c.nom AS chantier_nom FROM affectation a
     JOIN chantier c ON c.id=a.chantier_id WHERE a.employee_id=$1 ORDER BY a.date_debut DESC`, [id])).rows;
  e.conges = (await pool.query("SELECT * FROM conge WHERE employee_id=$1 ORDER BY date_debut DESC", [id])).rows;
  e.evaluations = (await pool.query("SELECT * FROM evaluation WHERE employee_id=$1 ORDER BY date_eval DESC", [id])).rows;
  const sal = e.contrat_actif ? Number(e.contrat_actif.salaire_base) : Number(e.salaire_base);
  e.paie = calculatePayroll({ salaireBase: sal, moisAnciennete: e.mois_anciennete, personnesCharge: e.personnes_charge });
  res.json(e);
}));

app.get("/api/organigramme", requireAuth, wrap(async (_req, res) => {
  const emps = (await pool.query("SELECT id,matricule,nom,poste,manager_id FROM employee WHERE actif ORDER BY id")).rows;
  const byId = Object.fromEntries(emps.map((e) => [e.id, { ...e, equipe: [] }]));
  const racines = [];
  for (const e of emps) {
    if (e.manager_id && byId[e.manager_id]) byId[e.manager_id].equipe.push(byId[e.id]);
    else racines.push(byId[e.id]);
  }
  res.json(racines);
}));

// ── Paie : aperçu + génération persistée + historique ──
app.post("/api/payroll/preview", requireAuth, wrap(async (req, res) => res.json(calculatePayroll(req.body || {}))));
app.post("/api/payroll/runs", requireAuth, wrap(async (req, res) => {
  const mois = Number(req.body?.mois), annee = Number(req.body?.annee);
  if (!mois || !annee) return res.status(400).json({ error: "mois et annee requis" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM payroll_run WHERE periode_mois=$1 AND periode_annee=$2 AND company_id=$3", [mois, annee, await cid(req)]);
    const emps = (await client.query(`
      SELECT e.*, COALESCE(c.salaire_base, e.salaire_base) AS salaire_effectif
      FROM employee e
      LEFT JOIN LATERAL (SELECT salaire_base FROM contrat WHERE employee_id=e.id AND actif ORDER BY date_debut DESC LIMIT 1) c ON true
      WHERE e.actif AND e.company_id = $1`, [await cid(req)])).rows;
    const run = (await client.query("INSERT INTO payroll_run (periode_mois,periode_annee,company_id) VALUES ($1,$2,$3) RETURNING *", [mois, annee, await cid(req)])).rows[0];
    const periode = `${annee}-${String(mois).padStart(2, "0")}-01`;
    let tB = 0, tN = 0, tC = 0;
    for (const e of emps) {
      const c = calculatePayroll({ salaireBase: Number(e.salaire_effectif), moisAnciennete: e.mois_anciennete, personnesCharge: e.personnes_charge });
      tB += c.brutImposable; tN += c.netAPayer; tC += c.coutTotal;
      await client.query(
        `INSERT INTO payslip (run_id,employee_id,periode,brut,cnss,ir,net,cout_total,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [run.id, e.id, periode, c.brutImposable, c.cnssTotal, c.ir, c.netAPayer, c.coutTotal, JSON.stringify({ employe: e, ...c })]);
    }
    await client.query("UPDATE payroll_run SET total_brut=$2,total_net=$3,total_cout=$4 WHERE id=$1",
      [run.id, tB.toFixed(2), tN.toFixed(2), tC.toFixed(2)]);
    await client.query("COMMIT");
    res.status(201).json({ run: { ...run, total_brut: tB, total_net: tN, total_cout: tC }, bulletins: emps.length });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}));
app.get("/api/payroll/runs", requireAuth, wrap(async (req, res) =>
  res.json((await pool.query("SELECT * FROM payroll_run WHERE company_id=$1 ORDER BY periode_annee DESC, periode_mois DESC", [await cid(req)])).rows)));
app.get("/api/payroll/runs/:id/payslips", requireAuth, wrap(async (req, res) =>
  res.json((await pool.query(
    `SELECT p.*, e.nom, e.matricule, e.poste FROM payslip p JOIN employee e ON e.id=p.employee_id
     WHERE p.run_id=$1 ORDER BY e.matricule`, [req.params.id])).rows)));

// ── PDF du bulletin de paie (PDFKit, pur JS) ──
function moneyFR(n) {
  const v = Number(n) || 0, neg = v < 0;
  const [int, dec] = Math.abs(v).toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return (neg ? "-" : "") + grouped + "," + dec + " MAD";
}
const MOIS_FR = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
function renderBulletin(doc, ps, d) {
  const emp = d.employe || {};
  const per = new Date(ps.periode);
  const M = 50, W = 495; // marge / largeur utile
  // Bandeau
  doc.rect(M, 45, W, 60).fill("#0f172a");
  doc.fill("#ffffff").fontSize(15).font("Helvetica-Bold").text("Atlas Constructions SARL", M + 15, 58);
  doc.fontSize(9).font("Helvetica").fill("#cbd5e1").text("Bulletin de paie — " + MOIS_FR[per.getUTCMonth()] + " " + per.getUTCFullYear(), M + 15, 78);
  doc.fontSize(10).font("Helvetica-Bold").fill("#ffffff").text(ps.nom || emp.nom || "", M + 250, 58, { width: 230, align: "right" });
  doc.fontSize(9).font("Helvetica").fill("#cbd5e1").text((ps.matricule || "") + " · " + (ps.poste || ""), M + 250, 76, { width: 230, align: "right" });

  let y = 130;
  doc.fill("#0f172a").fontSize(11).font("Helvetica-Bold").text("Éléments de paie", M, y); y += 8;
  doc.moveTo(M, y + 8).lineTo(M + W, y + 8).strokeColor("#e2e8f0").stroke(); y += 16;

  const row = (label, sub, amount, opts = {}) => {
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.bold ? 10 : 9.5).fill(opts.color || "#0f172a");
    doc.text(label, M + 6, y, { width: 300 });
    if (sub) { doc.font("Helvetica").fontSize(7.5).fill("#94a3b8").text(sub, M + 6, y + 11, { width: 300 }); }
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.bold ? 10 : 9.5).fill(opts.color || "#0f172a")
      .text((opts.neg ? "− " : "") + moneyFR(amount), M + 300, y, { width: W - 300, align: "right" });
    y += sub ? 24 : 17;
    if (opts.line) { doc.moveTo(M, y - 4).lineTo(M + W, y - 4).strokeColor("#e2e8f0").stroke(); }
  };

  row("Salaire de base", (moneyFR(d.salaireBase / 191).replace(" MAD", "")) + "/h · 191 h", d.salaireBase);
  row("Prime d'ancienneté", d.tauxAnciennete > 0 ? Math.round(d.tauxAnciennete * 100) + " % · Art. 350" : "—", d.primeAnciennete);
  row("Brut imposable", "", d.brutImposable, { bold: true, line: true });
  row("CNSS prestations", "4,48 % · plafond 6 000", d.cnssPrestations, { neg: true, color: "#be123c" });
  row("AMO", "2,26 % · sans plafond", d.amo, { neg: true, color: "#be123c" });
  row("Frais professionnels", (d.fraisProTaux === 0.35 ? "35 %" : "25 %") + " · abattement IR", d.fraisPro, { neg: true, color: "#be123c" });
  row("Revenu net imposable", "", d.revenuNetImposable, { bold: true, line: true });
  const trLbl = d.trancheIR === 0 ? "exonéré" : "tranche " + Math.round(d.trancheIR * 100) + " %";
  row("IR (" + trLbl + ")", d.deductionsFamiliales > 0 ? "− " + moneyFR(d.deductionsFamiliales).replace(" MAD", "") + " charges famille" : "barème 2026", d.ir, { neg: true, color: "#be123c" });

  // Net à payer
  y += 6;
  doc.rect(M, y, W, 40).fill("#ecfdf5");
  doc.fill("#047857").font("Helvetica-Bold").fontSize(10).text("NET À PAYER", M + 14, y + 8);
  doc.fontSize(16).text(moneyFR(d.netAPayer), M + 200, y + 11, { width: W - 214, align: "right" });
  y += 58;

  // Charges patronales
  doc.fill("#0f172a").font("Helvetica-Bold").fontSize(11).text("Charges patronales (≈ 21,09 %)", M, y); y += 18;
  const ce = d.cotisationsEmployeur || {};
  row("Prestations sociales", "8,98 %", ce.prestations);
  row("Allocations familiales", "6,40 %", ce.allocations);
  row("AMO employeur", "4,11 %", ce.amo);
  row("Taxe formation prof.", "1,60 %", ce.tfp);
  row("Coût total employeur", "", d.coutTotal, { bold: true, line: true });

  doc.font("Helvetica").fontSize(7.5).fill("#94a3b8")
    .text("Document indicatif généré par BTPPro — à faire valider par un expert-comptable avant émission officielle.", M, 760, { width: W, align: "center" });
}
app.get("/api/payslips/:id/pdf", requireAuth, wrap(async (req, res) => {
  const ps = (await pool.query(
    `SELECT p.*, e.nom, e.matricule, e.poste FROM payslip p JOIN employee e ON e.id=p.employee_id WHERE p.id=$1`,
    [req.params.id])).rows[0];
  if (!ps) return res.status(404).json({ error: "Bulletin introuvable" });
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="bulletin-${ps.matricule}.pdf"`);
  doc.pipe(res);
  renderBulletin(doc, ps, ps.payload || {});
  doc.end();
}));

// Route spécifique AVANT le CRUD générique (sinon /conges/:id capte "soldes")
app.get("/api/conges/soldes", requireAuth, wrap(async (_req, res) => {
  const emps = (await pool.query("SELECT id,matricule,nom,mois_anciennete FROM employee WHERE actif ORDER BY matricule")).rows;
  const out = [];
  for (const e of emps) {
    const acquis = +(e.mois_anciennete * 1.5).toFixed(1); // 1,5 j ouvrable / mois (Art. 231)
    const pris = Number((await pool.query(
      "SELECT COALESCE(SUM(jours),0)::numeric s FROM conge WHERE employee_id=$1 AND statut='valide' AND type='annuel'", [e.id])).rows[0].s);
    out.push({ id: e.id, matricule: e.matricule, nom: e.nom, acquis, pris, solde: +(acquis - pris).toFixed(1) });
  }
  res.json(out);
}));

// ── CRUD générique pour les modules ──
const RESOURCES = {
  chantiers:      ["chantier", ["code","nom","client","ville","statut","budget_prevu","date_debut","date_fin_prevue","latitude","longitude"]],
  contrats:       ["contrat", ["employee_id","type","poste","salaire_base","date_debut","date_fin","actif"]],
  factures:       ["facture", ["numero","client","chantier_id","type","montant_ht","tva","montant_ttc","statut","date_emission"]],
  incidents:      ["incident", ["chantier_id","type","gravite","description","date_incident","statut","employee_id","jours_arret","mesures"]],
  documents:      ["document", ["nom","type","categorie","chantier_id","url","version","statut"]],
  controles:      ["controle_securite", ["chantier_id","date_controle","type","conforme","observations","controleur"]],
  epi:            ["epi", ["employee_id","designation","type","date_remise","date_retour","etat"]],
  "fournisseur-evals": ["fournisseur_evaluation", ["fournisseur_id","date_eval","note_qualite","note_delai","note_prix","commentaire"]],
  "st-contrats":  ["soustraitant_contrat", ["sous_traitant_id","chantier_id","objet","montant_marche","rg_taux","date_debut","date_fin","statut"]],
  "st-evals":     ["soustraitant_evaluation", ["sous_traitant_id","date_eval","note","commentaire"]],
  articles:       ["article", ["reference","designation","unite","stock","seuil","prix_unitaire"]],
  "demandes-achat": ["demande_achat", ["objet","chantier_id","statut"]],
  "bons-commande":  ["bon_commande", ["numero","fournisseur_id","montant","statut","date_commande"]],
  fournisseurs:   ["fournisseur", ["raison_sociale","ice","contact","telephone","email","conditions_paiement","delai_livraison"]],
  "sous-traitants": ["sous_traitant", ["raison_sociale","specialite","contact","telephone"]],
  "situations-st":  ["soustraitant_situation", ["sous_traitant_id","chantier_id","montant","statut","date_situation"]],
  conges:         ["conge", ["employee_id","type","date_debut","date_fin","jours","statut","motif"]],
  affectations:   ["affectation", ["chantier_id","employee_id","role","date_debut","date_fin"]],
  evaluations:    ["evaluation", ["employee_id","date_eval","note","evaluateur","commentaire"]],
  pointages:      ["pointage", ["employee_id","chantier_id","date_jour","heures","heures_sup"]],
  taches:         ["tache", ["chantier_id","libelle","date_debut","date_fin","avancement","responsable","statut"]],
  paiements:      ["paiement", ["sens","facture_id","tiers","montant","date_paiement","mode","reference"]],
  materiel:       ["materiel", ["code","designation","type","etat","valeur_acquisition","date_acquisition","chantier_id"]],
};
const SCOPED_ROUTES = new Set(["chantiers", "factures", "incidents", "documents", "controles", "epi", "conges", "demandes-achat", "fournisseurs", "sous-traitants", "articles", "pointages", "taches", "paiements", "materiel"]);
for (const [route, [table, cols]] of Object.entries(RESOURCES)) {
  const c = makeCrud(table, cols, { company: SCOPED_ROUTES.has(route) });
  app.get(`/api/${route}`, requireAuth, wrap(c.list));
  app.get(`/api/${route}/:id`, requireAuth, wrap(c.get));
  app.post(`/api/${route}`, requireAuth, wrap(c.create));
  app.put(`/api/${route}/:id`, requireAuth, wrap(c.update));
  app.delete(`/api/${route}/:id`, requireAuth, wrap(c.remove));
}

// ── Spécifiques métier ──
// Devis avec lignes (calcul HT/TVA/TTC)
app.get("/api/devis", requireAuth, wrap(async (req, res) =>
  res.json((await pool.query("SELECT * FROM devis WHERE company_id=$1 ORDER BY id DESC", [await cid(req)])).rows)));
app.get("/api/devis/:id", requireAuth, wrap(async (req, res) => {
  const d = (await pool.query("SELECT * FROM devis WHERE id=$1", [req.params.id])).rows[0];
  if (!d) return res.status(404).json({ error: "Introuvable" });
  d.lignes = (await pool.query("SELECT * FROM devis_ligne WHERE devis_id=$1 ORDER BY id", [req.params.id])).rows;
  res.json(d);
}));
app.post("/api/devis", requireAuth, wrap(async (req, res) => {
  const { numero, client: cli, chantier_id, objet, lignes = [] } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ht = lignes.reduce((s, l) => s + (Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0), 0);
    const tva = ht * 0.2, ttc = ht + tva;
    const d = (await client.query(
      `INSERT INTO devis (numero,client,chantier_id,objet,total_ht,tva,total_ttc) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [numero || null, cli || null, chantier_id || null, objet || null, ht.toFixed(2), tva.toFixed(2), ttc.toFixed(2)])).rows[0];
    for (const l of lignes) {
      const tot = (Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0);
      await client.query(`INSERT INTO devis_ligne (devis_id,designation,quantite,prix_unitaire,total) VALUES ($1,$2,$3,$4,$5)`,
        [d.id, l.designation || "", l.quantite || 0, l.prix_unitaire || 0, tot.toFixed(2)]);
    }
    await client.query("COMMIT"); res.status(201).json(d);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}));
app.delete("/api/devis/:id", requireAuth, wrap(async (req, res) => {
  await pool.query("DELETE FROM devis WHERE id=$1", [req.params.id]); res.json({ ok: true });
}));
// Workflow devis : changement de statut
app.put("/api/devis/:id", requireAuth, wrap(async (req, res) => {
  const cols = ["statut", "client", "client_ice", "objet"].filter((k) => req.body[k] !== undefined);
  if (!cols.length) return res.status(400).json({ error: "Aucune donnée" });
  const set = cols.map((c, i) => `${c}=$${i + 2}`).join(",");
  const { rows } = await pool.query(`UPDATE devis SET ${set} WHERE id=$1 RETURNING *`, [req.params.id, ...cols.map((c) => req.body[c])]);
  if (!rows[0]) return res.status(404).json({ error: "Devis introuvable" });
  res.json(rows[0]);
}));
// Conversion devis → facture (en 1 clic)
app.post("/api/devis/:id/facturer", requireAuth, wrap(async (req, res) => {
  const d = (await pool.query("SELECT * FROM devis WHERE id=$1", [req.params.id])).rows[0];
  if (!d) return res.status(404).json({ error: "Devis introuvable" });
  const company = await cid(req);
  const num = await nextNumero(pool, company, "facture");
  const f = (await pool.query(
    `INSERT INTO facture (numero,client,client_ice,chantier_id,devis_id,type,montant_ht,tva,montant_ttc,net_a_payer,statut,company_id)
     VALUES ($1,$2,$3,$4,$5,'facture',$6,$7,$8,$8,'emise',$9) RETURNING *`,
    [num, d.client, d.client_ice, d.chantier_id, d.id, d.total_ht, d.tva, d.total_ttc, company])).rows[0];
  await pool.query("UPDATE devis SET statut='facture' WHERE id=$1", [d.id]);
  res.status(201).json(f);
}));

// Récap pointage par chantier (heures + coût main-d'œuvre réel)
app.get("/api/pointages-recap", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  const annee = Number(req.query.annee) || new Date().getFullYear();
  const mois = Number(req.query.mois) || (new Date().getMonth() + 1);
  const { rows } = await pool.query(
    `SELECT p.chantier_id, c.code, c.nom,
            SUM(p.heures)::numeric(10,2) AS heures,
            SUM(p.heures_sup)::numeric(10,2) AS heures_sup,
            SUM((p.heures + p.heures_sup) * (e.salaire_base/191.0))::numeric(12,2) AS cout
     FROM pointage p
     JOIN employee e ON e.id=p.employee_id
     LEFT JOIN chantier c ON c.id=p.chantier_id
     WHERE p.company_id=$1 AND EXTRACT(YEAR FROM p.date_jour)=$2 AND EXTRACT(MONTH FROM p.date_jour)=$3
     GROUP BY p.chantier_id, c.code, c.nom ORDER BY cout DESC NULLS LAST`,
    [company, annee, mois]);
  const total_heures = rows.reduce((s, r) => s + Number(r.heures || 0) + Number(r.heures_sup || 0), 0);
  const total_cout = rows.reduce((s, r) => s + Number(r.cout || 0), 0);
  res.json({ annee, mois, lignes: rows, total_heures: +total_heures.toFixed(2), total_cout: +total_cout.toFixed(2) });
}));

// Tableau de bord trésorerie
app.get("/api/tresorerie/dashboard", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  const q = (sql, p = []) => pool.query(sql, [company, ...p]);
  const enc = Number((await q("SELECT COALESCE(SUM(montant),0) s FROM paiement WHERE company_id=$1 AND sens='encaissement'")).rows[0].s);
  const dec = Number((await q("SELECT COALESCE(SUM(montant),0) s FROM paiement WHERE company_id=$1 AND sens='decaissement'")).rows[0].s);
  // Créances = factures (hors avoir) net à payer - encaissements rattachés
  const fact = (await q(
    `SELECT f.id, f.numero, f.client, f.date_emission, f.type,
            COALESCE(f.net_a_payer, f.montant_ttc) AS du,
            COALESCE((SELECT SUM(montant) FROM paiement WHERE facture_id=f.id AND sens='encaissement'),0) AS regle
     FROM facture f WHERE f.company_id=$1 AND f.type<>'avoir' ORDER BY f.date_emission`)).rows;
  const echeancier = [];
  let creances = 0;
  const today = new Date();
  for (const f of fact) {
    const reste = +(Number(f.du) - Number(f.regle)).toFixed(2);
    if (reste > 0.01) {
      creances += reste;
      const jours = f.date_emission ? Math.floor((today - new Date(f.date_emission)) / 86400000) : 0;
      echeancier.push({ id: f.id, numero: f.numero, client: f.client, du: Number(f.du), regle: Number(f.regle), reste, jours_anciennete: jours, en_retard: jours > 60 });
    }
  }
  echeancier.sort((a, b) => b.jours_anciennete - a.jours_anciennete);
  res.json({
    encaissements: +enc.toFixed(2), decaissements: +dec.toFixed(2), solde: +(enc - dec).toFixed(2),
    creances_clients: +creances.toFixed(2), echeancier: echeancier.slice(0, 50),
  });
}));

// Validation de congé
app.post("/api/conges/:id/statut", requireAuth, wrap(async (req, res) => {
  const { statut } = req.body || {};
  const { rows } = await pool.query("UPDATE conge SET statut=$2 WHERE id=$1 RETURNING *", [req.params.id, statut]);
  if (!rows[0]) return res.status(404).json({ error: "Introuvable" });
  res.json(rows[0]);
}));

// Mouvement de stock avec valorisation CMUP (coût moyen unitaire pondéré)
async function applyMovement(client, { article_id, type, quantite, prix_unitaire, motif }) {
  const q = Number(quantite) || 0;
  const a = (await client.query("SELECT stock, cmup FROM article WHERE id=$1 FOR UPDATE", [article_id])).rows[0];
  if (!a) throw new Error("Article introuvable");
  const stock = Number(a.stock), cmup = Number(a.cmup);
  let newStock, newCmup, valeur, pu = Number(prix_unitaire) || 0;
  if (type === "sortie") {
    newStock = stock - q; newCmup = cmup; pu = cmup; valeur = +(q * cmup).toFixed(2);
  } else if (type === "inventaire") {
    // q = quantité physique comptée → ajustement
    const delta = q - stock; newStock = q; newCmup = cmup; valeur = +(delta * cmup).toFixed(2);
  } else { // entrée
    newStock = stock + q;
    newCmup = newStock > 0 ? +(((stock * cmup) + (q * pu)) / newStock).toFixed(2) : cmup;
    valeur = +(q * pu).toFixed(2);
  }
  await client.query(
    "INSERT INTO mouvement_stock (article_id,type,quantite,prix_unitaire,valeur,motif) VALUES ($1,$2,$3,$4,$5,$6)",
    [article_id, type, q, pu, valeur, motif || null]);
  await client.query("UPDATE article SET stock=$2, cmup=$3 WHERE id=$1", [article_id, newStock, newCmup]);
  return (await client.query("SELECT * FROM article WHERE id=$1", [article_id])).rows[0];
}
app.post("/api/stock/mouvements", requireAuth, wrap(async (req, res) => {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const a = await applyMovement(client, req.body || {}); await client.query("COMMIT"); res.status(201).json(a); }
  catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}));
app.post("/api/stock/inventaire", requireAuth, wrap(async (req, res) => {
  const client = await pool.connect();
  try { await client.query("BEGIN");
    const a = await applyMovement(client, { article_id: req.body.article_id, type: "inventaire", quantite: req.body.quantite_comptee, motif: "Inventaire" });
    await client.query("COMMIT"); res.status(201).json(a);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}));
app.get("/api/stock/mouvements", requireAuth, wrap(async (_req, res) =>
  res.json((await pool.query(
    `SELECT m.*, a.reference, a.designation FROM mouvement_stock m JOIN article a ON a.id=m.article_id
     ORDER BY m.id DESC LIMIT 100`)).rows)));
app.get("/api/stock/valorisation", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT id,reference,designation,unite,stock,seuil,cmup,(stock*cmup) AS valeur FROM article WHERE company_id=$1 ORDER BY reference", [await cid(req)]);
  const total = rows.reduce((s, a) => s + Number(a.valeur), 0);
  res.json({ articles: rows, total: +total.toFixed(2) });
}));

// ── Achats : commande avec lignes + réception (alimente le stock via CMUP) ──
app.get("/api/commandes", requireAuth, wrap(async (req, res) =>
  res.json((await pool.query(
    `SELECT bc.*, f.raison_sociale AS fournisseur, c.code AS chantier_code
     FROM bon_commande bc LEFT JOIN fournisseur f ON f.id=bc.fournisseur_id
     LEFT JOIN chantier c ON c.id=bc.chantier_id WHERE bc.company_id=$1 ORDER BY bc.id DESC`, [await cid(req)])).rows)));
app.get("/api/commandes/:id", requireAuth, wrap(async (req, res) => {
  const bc = (await pool.query("SELECT * FROM bon_commande WHERE id=$1", [req.params.id])).rows[0];
  if (!bc) return res.status(404).json({ error: "Introuvable" });
  bc.lignes = (await pool.query("SELECT * FROM bon_commande_ligne WHERE commande_id=$1 ORDER BY id", [req.params.id])).rows;
  res.json(bc);
}));
app.post("/api/commandes", requireAuth, wrap(async (req, res) => {
  const { numero, fournisseur_id, chantier_id, lignes = [] } = req.body || {};
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const montant = lignes.reduce((s, l) => s + (Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0), 0);
    const bc = (await conn.query(
      `INSERT INTO bon_commande (numero,fournisseur_id,chantier_id,montant,statut,company_id) VALUES ($1,$2,$3,$4,'envoyee',$5) RETURNING *`,
      [numero || `BC-${Date.now().toString().slice(-5)}`, fournisseur_id || null, chantier_id || null, montant.toFixed(2), await cid(req)])).rows[0];
    for (const l of lignes)
      await conn.query(
        "INSERT INTO bon_commande_ligne (commande_id,article_id,designation,quantite,prix_unitaire) VALUES ($1,$2,$3,$4,$5)",
        [bc.id, l.article_id || null, l.designation || "", l.quantite || 0, l.prix_unitaire || 0]);
    await conn.query("COMMIT"); res.status(201).json(bc);
  } catch (e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
}));
app.post("/api/commandes/:id/reception", requireAuth, wrap(async (req, res) => {
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const lignes = (await conn.query("SELECT * FROM bon_commande_ligne WHERE commande_id=$1", [req.params.id])).rows;
    for (const l of lignes) {
      const reste = Number(l.quantite) - Number(l.recu);
      if (l.article_id && reste > 0) {
        await applyMovement(conn, { article_id: l.article_id, type: "entree", quantite: reste, prix_unitaire: l.prix_unitaire, motif: "Réception commande #" + req.params.id });
        await conn.query("UPDATE bon_commande_ligne SET recu=quantite WHERE id=$1", [l.id]);
      }
    }
    const bc = (await conn.query("UPDATE bon_commande SET statut='recue', date_reception=now() WHERE id=$1 RETURNING *", [req.params.id])).rows[0];
    await conn.query("COMMIT"); res.json(bc);
  } catch (e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
}));
app.delete("/api/commandes/:id", requireAuth, wrap(async (req, res) => {
  await pool.query("DELETE FROM bon_commande WHERE id=$1", [req.params.id]); res.json({ ok: true });
}));

// ── Chantiers : coût réel (helper partagé) + synthèse budgétaire ──
async function chantierReel(id) {
  const ch = (await pool.query("SELECT * FROM chantier WHERE id=$1", [id])).rows[0];
  if (!ch) return null;
  const num = async (q) => Number((await pool.query(q, [id])).rows[0].n);
  const depenses_directes = await num("SELECT COALESCE(SUM(montant),0)::numeric n FROM chantier_expense WHERE chantier_id=$1");
  const materiaux = await num("SELECT COALESCE(SUM(montant),0)::numeric n FROM bon_commande WHERE chantier_id=$1 AND statut='recue'");
  const sous_traitance = await num("SELECT COALESCE(SUM(montant),0)::numeric n FROM soustraitant_situation WHERE chantier_id=$1");
  const affs = (await pool.query(
    `SELECT a.date_debut, a.date_fin, e.salaire_base, e.mois_anciennete, e.personnes_charge
     FROM affectation a JOIN employee e ON e.id=a.employee_id WHERE a.chantier_id=$1`, [id])).rows;
  let main_oeuvre = 0;
  for (const a of affs) {
    const fin = a.date_fin ? new Date(a.date_fin) : new Date();
    const deb = a.date_debut ? new Date(a.date_debut) : fin;
    const mois = Math.max(1, Math.round((fin - deb) / (1000 * 3600 * 24 * 30)) || 1);
    const c = calculatePayroll({ salaireBase: Number(a.salaire_base), moisAnciennete: a.mois_anciennete, personnesCharge: a.personnes_charge });
    main_oeuvre += c.coutTotal * mois;
  }
  main_oeuvre = +main_oeuvre.toFixed(2);
  const reel = +(depenses_directes + materiaux + sous_traitance + main_oeuvre).toFixed(2);
  const ca = Number((await pool.query(
    "SELECT COALESCE(SUM(montant_ht),0)::numeric n FROM facture WHERE chantier_id=$1", [id])).rows[0].n);
  return { ch, budget: Number(ch.budget_prevu) || 0, reel, ca_facture: +ca.toFixed(2),
    detail: { main_oeuvre, materiaux, sous_traitance, depenses_directes } };
}
app.get("/api/chantiers/:id/budget", requireAuth, wrap(async (req, res) => {
  const r = await chantierReel(req.params.id);
  if (!r) return res.status(404).json({ error: "Introuvable" });
  res.json({
    chantier: { id: r.ch.id, code: r.ch.code, nom: r.ch.nom, budget_prevu: r.budget },
    reel: r.reel, ecart: +(r.budget - r.reel).toFixed(2),
    pct_consomme: r.budget > 0 ? +(r.reel / r.budget * 100).toFixed(1) : null, detail: r.detail,
  });
}));

// ── Tableau de bord RENTABILITÉ (consolidation transversale) ──
app.get("/api/dashboard/rentabilite", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  // Coût employeur / masse salariale (contrat actif)
  const emps = (await pool.query(`
    SELECT e.mois_anciennete, e.personnes_charge, COALESCE(c.salaire_base, e.salaire_base) AS sal
    FROM employee e
    LEFT JOIN LATERAL (SELECT salaire_base FROM contrat WHERE employee_id=e.id AND actif ORDER BY date_debut DESC LIMIT 1) c ON true
    WHERE e.actif AND e.company_id = $1`, [company])).rows;
  let masse_brute = 0, cout_employeur = 0;
  for (const e of emps) {
    const c = calculatePayroll({ salaireBase: Number(e.sal), moisAnciennete: e.mois_anciennete, personnesCharge: e.personnes_charge });
    masse_brute += c.brutImposable; cout_employeur += c.coutTotal;
  }
  const one = async (q) => Number((await pool.query(q, [company])).rows[0].n);
  const ca_facture = await one("SELECT COALESCE(SUM(montant_ht),0)::numeric n FROM facture WHERE statut IN ('emise','payee') AND company_id=$1");
  const marge_devis = await one("SELECT COALESCE(SUM(total_marge),0)::numeric n FROM devis WHERE company_id=$1");
  const valeur_stock = await one("SELECT COALESCE(SUM(stock*cmup),0)::numeric n FROM article WHERE company_id=$1");

  // Rentabilité par chantier
  const ids = (await pool.query("SELECT id FROM chantier WHERE company_id=$1 ORDER BY code", [company])).rows;
  const chantiers = [];
  let total_budget = 0, total_reel = 0, total_ca = 0;
  for (const { id } of ids) {
    const r = await chantierReel(id);
    if (!r) continue;
    const marge = +(r.ca_facture - r.reel).toFixed(2);
    const taux = r.ca_facture > 0 ? +(marge / r.ca_facture * 100).toFixed(1) : null;
    total_budget += r.budget; total_reel += r.reel; total_ca += r.ca_facture;
    chantiers.push({ code: r.ch.code, nom: r.ch.nom, statut: r.ch.statut, budget_prevu: r.budget, cout_reel: r.reel, ca_facture: r.ca_facture, marge, taux_marge: taux, detail: r.detail });
  }
  res.json({
    global: {
      ca_facture, masse_brute: +masse_brute.toFixed(2), cout_employeur: +cout_employeur.toFixed(2),
      marge_devis, valeur_stock,
      total_budget_prevu: +total_budget.toFixed(2), total_cout_reel: +total_reel.toFixed(2),
      total_ca_chantiers: +total_ca.toFixed(2),
      marge_brute_chantiers: +(total_ca - total_reel).toFixed(2),
    },
    chantiers,
  });
}));

// Tableau de bord agrégé (transversal)
app.get("/api/dashboard", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  const emps = (await pool.query("SELECT salaire_base,mois_anciennete,personnes_charge FROM employee WHERE actif AND company_id=$1", [company])).rows;
  let brut = 0, net = 0, cout = 0;
  for (const e of emps) {
    const c = calculatePayroll({ salaireBase: Number(e.salaire_base), moisAnciennete: e.mois_anciennete, personnesCharge: e.personnes_charge });
    brut += c.brutImposable; net += c.netAPayer; cout += c.coutTotal;
  }
  const one = async (q) => Number((await pool.query(q, [company])).rows[0].n);
  res.json({
    effectif: emps.length, masse_brute: brut, net_total: net, cout_total: cout,
    chantiers_actifs: await one("SELECT count(*)::int n FROM chantier WHERE statut='en_cours' AND company_id=$1"),
    devis_en_cours: await one("SELECT count(*)::int n FROM devis WHERE statut <> 'refuse' AND company_id=$1"),
    ca_facture: await one("SELECT COALESCE(sum(montant_ttc),0)::numeric n FROM facture WHERE statut IN ('emise','payee') AND company_id=$1"),
    conges_attente: await one("SELECT count(*)::int n FROM conge WHERE statut='demande' AND company_id=$1"),
    stock_alertes: await one("SELECT count(*)::int n FROM article WHERE stock < seuil AND company_id=$1"),
    incidents_ouverts: await one("SELECT count(*)::int n FROM incident WHERE statut='ouvert' AND company_id=$1"),
  });
}));

// ══════════════ PROFONDEUR MÉTIER ══════════════

// ── Bibliothèque d'ouvrages + sous-détails de prix (déboursé sec) ──
async function ouvrageDebourse(id) {
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(quantite*prix_unitaire),0)::numeric AS d FROM ouvrage_composant WHERE ouvrage_id=$1", [id]);
  return Number(rows[0].d);
}
app.get("/api/ouvrages", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ouvrage WHERE company_id=$1 ORDER BY code", [await cid(req)]);
  for (const o of rows) o.debourse_sec = await ouvrageDebourse(o.id);
  res.json(rows);
}));
app.get("/api/ouvrages/:id", requireAuth, wrap(async (req, res) => {
  const o = (await pool.query("SELECT * FROM ouvrage WHERE id=$1", [req.params.id])).rows[0];
  if (!o) return res.status(404).json({ error: "Introuvable" });
  o.composants = (await pool.query("SELECT * FROM ouvrage_composant WHERE ouvrage_id=$1 ORDER BY id", [req.params.id])).rows;
  o.debourse_sec = o.composants.reduce((s, c) => s + Number(c.quantite) * Number(c.prix_unitaire), 0);
  res.json(o);
}));
app.post("/api/ouvrages", requireAuth, wrap(async (req, res) => {
  const { code, designation, unite, composants = [] } = req.body || {};
  if (!code || !designation) return res.status(400).json({ error: "code et désignation requis" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const o = (await client.query("INSERT INTO ouvrage (code,designation,unite,company_id) VALUES ($1,$2,$3,$4) RETURNING *",
      [code, designation, unite || "u", await cid(req)])).rows[0];
    for (const c of composants)
      await client.query("INSERT INTO ouvrage_composant (ouvrage_id,type,designation,unite,quantite,prix_unitaire) VALUES ($1,$2,$3,$4,$5,$6)",
        [o.id, c.type || "materiau", c.designation || "", c.unite || "u", c.quantite || 0, c.prix_unitaire || 0]);
    await client.query("COMMIT");
    res.status(201).json(o);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}));
app.post("/api/ouvrages/:id/composants", requireAuth, wrap(async (req, res) => {
  const { type, designation, unite, quantite, prix_unitaire } = req.body || {};
  const { rows } = await pool.query(
    "INSERT INTO ouvrage_composant (ouvrage_id,type,designation,unite,quantite,prix_unitaire) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [req.params.id, type || "materiau", designation || "", unite || "u", quantite || 0, prix_unitaire || 0]);
  res.status(201).json(rows[0]);
}));
app.delete("/api/ouvrages/:id", requireAuth, wrap(async (req, res) => {
  await pool.query("DELETE FROM ouvrage WHERE id=$1", [req.params.id]); res.json({ ok: true });
}));
app.delete("/api/composants/:id", requireAuth, wrap(async (req, res) => {
  await pool.query("DELETE FROM ouvrage_composant WHERE id=$1", [req.params.id]); res.json({ ok: true });
}));

// ── Devis approfondi : déboursé → marge → prix de vente ──
app.get("/api/devis/:id/full", requireAuth, wrap(async (req, res) => {
  const d = (await pool.query("SELECT * FROM devis WHERE id=$1", [req.params.id])).rows[0];
  if (!d) return res.status(404).json({ error: "Introuvable" });
  d.lignes = (await pool.query("SELECT * FROM devis_ligne WHERE devis_id=$1 ORDER BY id", [req.params.id])).rows;
  res.json(d);
}));
// Numérotation automatique par société (format paramétrable)
function formatNumero(fmt, seq, date) {
  const d = date || new Date();
  let s = String(fmt || "N-{####}")
    .replace(/\{AAAA\}/g, d.getFullYear())
    .replace(/\{AA\}/g, String(d.getFullYear()).slice(-2))
    .replace(/\{MM\}/g, String(d.getMonth() + 1).padStart(2, "0"));
  s = s.replace(/\{?#+\}?/g, (m) => { const len = (m.match(/#/g) || []).length; return String(seq).padStart(len, "0"); });
  return s || ("N-" + seq);
}
async function nextNumero(q, companyId, kind) {
  const col = kind === "devis" ? "devis_compteur" : "facture_compteur";
  const fcol = kind === "devis" ? "devis_format" : "facture_format";
  const r = (await q.query(`UPDATE company SET ${col}=COALESCE(${col},0)+1 WHERE id=$1 RETURNING ${col} AS seq, ${fcol} AS fmt`, [companyId])).rows[0];
  if (!r) return formatNumero(null, Date.now() % 10000);
  return formatNumero(r.fmt, r.seq, new Date());
}

app.post("/api/devis/deep", requireAuth, wrap(async (req, res) => {
  const { numero, client: cli, client_ice, chantier_id, objet, lignes = [] } = req.body || {};
  const company = await cid(req);
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    let debourse = 0, ht = 0;
    const calc = lignes.map((l) => {
      const du = Number(l.debourse_unitaire) || 0, coef = Number(l.coef_marge) || 1.2, q = Number(l.quantite) || 0;
      const pv = +(du * coef).toFixed(2), totHT = +(pv * q).toFixed(2), totDeb = +(du * q).toFixed(2);
      debourse += totDeb; ht += totHT;
      return { ...l, prix_vente: pv, total: totHT, totDeb };
    });
    const tva = +(ht * 0.2).toFixed(2), ttc = +(ht + tva).toFixed(2), marge = +(ht - debourse).toFixed(2);
    const numeroFinal = (numero || "").trim() || await nextNumero(conn, company, "devis");
    const d = (await conn.query(
      `INSERT INTO devis (numero,client,client_ice,chantier_id,objet,total_debourse,total_marge,total_ht,tva,total_ttc,company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [numeroFinal, cli || null, client_ice || null, chantier_id || null, objet || null, debourse.toFixed(2), marge, ht.toFixed(2), tva, ttc, company])).rows[0];
    for (const l of calc)
      await conn.query(
        `INSERT INTO devis_ligne (devis_id,ouvrage_id,designation,quantite,debourse_unitaire,coef_marge,prix_unitaire,prix_vente,total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [d.id, l.ouvrage_id || null, l.designation || "", l.quantite || 0, l.debourse_unitaire || 0, l.coef_marge || 1.2, l.prix_vente, l.prix_vente, l.total]);
    await conn.query("COMMIT");
    res.status(201).json(d);
  } catch (e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
}));

// ── Facturation : situation de travaux + retenue de garantie ──
app.post("/api/factures/situation", requireAuth, wrap(async (req, res) => {
  const devis_id = Number(req.body?.devis_id), avancement = Number(req.body?.avancement) || 0, rg_taux = Number(req.body?.rg_taux) || 0;
  const d = (await pool.query("SELECT * FROM devis WHERE id=$1", [devis_id])).rows[0];
  if (!d) return res.status(404).json({ error: "Devis introuvable" });
  const cumul = Number((await pool.query(
    "SELECT COALESCE(SUM(montant_ht),0)::numeric s FROM facture WHERE devis_id=$1 AND type='situation'", [devis_id])).rows[0].s);
  const htCumule = Number(d.total_ht) * avancement / 100;
  const montant_ht = +(htCumule - cumul).toFixed(2);
  if (montant_ht <= 0) return res.status(400).json({ error: "Avancement ≤ au déjà facturé" });
  const tva = +(montant_ht * 0.2).toFixed(2), ttc = +(montant_ht + tva).toFixed(2);
  const rg = +(montant_ht * rg_taux / 100).toFixed(2), net = +(ttc - rg).toFixed(2);
  const company = await cid(req);
  const num = await nextNumero(pool, company, "facture");
  const f = (await pool.query(
    `INSERT INTO facture (numero,client,client_ice,chantier_id,devis_id,type,avancement,cumul_anterieur,
       montant_ht,tva,montant_ttc,rg_taux,retenue_garantie,net_a_payer,statut,company_id)
     VALUES ($1,$2,$3,$4,$5,'situation',$6,$7,$8,$9,$10,$11,$12,$13,'emise',$14) RETURNING *`,
    [num, d.client, d.client_ice, d.chantier_id, devis_id, avancement, cumul, montant_ht, tva, ttc, rg_taux, rg, net, company])).rows[0];
  res.status(201).json(f);
}));

// ── Congés : acquisition automatique + soldes (route /api/conges/soldes définie plus haut) ──

// ══════════════ SÉCURITÉ (HSE) & GED ══════════════

// Indicateurs HSE : taux de fréquence (TF) et de gravité (TG)
app.get("/api/securite/stats", requireAuth, wrap(async (_req, res) => {
  const one = async (q) => Number((await pool.query(q)).rows[0].n);
  const effectif = await one("SELECT count(*)::int n FROM employee WHERE actif");
  const incidents = await one("SELECT count(*)::int n FROM incident");
  const accidents = await one("SELECT count(*)::int n FROM incident WHERE type='accident'");
  const accidents_arret = await one("SELECT count(*)::int n FROM incident WHERE type='accident' AND jours_arret>0");
  const jours_arret = await one("SELECT COALESCE(SUM(jours_arret),0)::int n FROM incident");
  const controles = await one("SELECT count(*)::int n FROM controle_securite");
  const conformes = await one("SELECT count(*)::int n FROM controle_securite WHERE conforme");
  // Heures travaillées estimées (annuel) : effectif × 191 h × 12 mois
  const heures = effectif * 191 * 12;
  const tf = heures > 0 ? +(accidents_arret * 1e6 / heures).toFixed(2) : 0; // accidents avec arrêt / M heures
  const tg = heures > 0 ? +(jours_arret * 1e3 / heures).toFixed(2) : 0;     // jours perdus / 1000 h
  res.json({
    effectif, incidents, accidents, accidents_arret, jours_arret,
    taux_frequence: tf, taux_gravite: tg,
    controles, conformes, taux_conformite: controles > 0 ? +(conformes / controles * 100).toFixed(1) : null,
  });
}));

// GED : document complet (versions + signatures)
app.get("/api/documents/:id/full", requireAuth, wrap(async (req, res) => {
  const d = (await pool.query("SELECT * FROM document WHERE id=$1", [req.params.id])).rows[0];
  if (!d) return res.status(404).json({ error: "Introuvable" });
  d.versions = (await pool.query("SELECT * FROM document_version WHERE document_id=$1 ORDER BY version DESC", [req.params.id])).rows;
  d.signatures = (await pool.query("SELECT * FROM document_signature WHERE document_id=$1 ORDER BY id", [req.params.id])).rows;
  res.json(d);
}));
app.post("/api/documents/:id/versions", requireAuth, wrap(async (req, res) => {
  const { url, auteur, note } = req.body || {};
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const v = Number((await conn.query("SELECT COALESCE(MAX(version),0)+1 AS v FROM document_version WHERE document_id=$1", [req.params.id])).rows[0].v);
    const row = (await conn.query(
      "INSERT INTO document_version (document_id,version,url,auteur,note) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [req.params.id, v, url || null, auteur || null, note || null])).rows[0];
    await conn.query("UPDATE document SET version=$2, url=COALESCE($3,url) WHERE id=$1", [req.params.id, v, url || null]);
    await conn.query("COMMIT");
    res.status(201).json(row);
  } catch (e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
}));
app.post("/api/documents/:id/signatures", requireAuth, wrap(async (req, res) => {
  const { signataire } = req.body || {};
  if (!signataire) return res.status(400).json({ error: "signataire requis" });
  const { rows } = await pool.query(
    "INSERT INTO document_signature (document_id,signataire,statut) VALUES ($1,$2,'en_attente') RETURNING *", [req.params.id, signataire]);
  res.status(201).json(rows[0]);
}));
app.post("/api/signatures/:id/sign", requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE document_signature SET statut='signe', date_signature=now() WHERE id=$1 RETURNING *", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Introuvable" });
  res.json(rows[0]);
}));

// ══════════════ TIERS (fournisseurs / sous-traitants) ══════════════

// Fiche fournisseur : commandes + statistiques + évaluations
app.get("/api/fournisseurs/:id/fiche", requireAuth, wrap(async (req, res) => {
  const id = req.params.id;
  const f = (await pool.query("SELECT * FROM fournisseur WHERE id=$1", [id])).rows[0];
  if (!f) return res.status(404).json({ error: "Introuvable" });
  f.commandes = (await pool.query("SELECT * FROM bon_commande WHERE fournisseur_id=$1 ORDER BY id DESC", [id])).rows;
  const stat = (await pool.query(
    `SELECT count(*)::int AS nb, COALESCE(SUM(montant),0)::numeric AS total,
            COALESCE(SUM(montant) FILTER (WHERE statut='recue'),0)::numeric AS recu
     FROM bon_commande WHERE fournisseur_id=$1`, [id])).rows[0];
  f.stats = { nb_commandes: stat.nb, total_commande: Number(stat.total), total_recu: Number(stat.recu) };
  f.evaluations = (await pool.query("SELECT * FROM fournisseur_evaluation WHERE fournisseur_id=$1 ORDER BY date_eval DESC", [id])).rows;
  const notes = f.evaluations.flatMap((e) => [e.note_qualite, e.note_delai, e.note_prix].filter((n) => n != null));
  f.note_moyenne = notes.length ? +(notes.reduce((a, b) => a + Number(b), 0) / notes.length).toFixed(1) : null;
  res.json(f);
}));

// Fiche sous-traitant : contrats + situations + évaluations + total payé
app.get("/api/sous-traitants/:id/fiche", requireAuth, wrap(async (req, res) => {
  const id = req.params.id;
  const st = (await pool.query("SELECT * FROM sous_traitant WHERE id=$1", [id])).rows[0];
  if (!st) return res.status(404).json({ error: "Introuvable" });
  st.contrats = (await pool.query(
    `SELECT sc.*, c.code AS chantier_code FROM soustraitant_contrat sc
     LEFT JOIN chantier c ON c.id=sc.chantier_id WHERE sc.sous_traitant_id=$1 ORDER BY sc.id DESC`, [id])).rows;
  st.situations = (await pool.query("SELECT * FROM soustraitant_situation WHERE sous_traitant_id=$1 ORDER BY id DESC", [id])).rows;
  st.evaluations = (await pool.query("SELECT * FROM soustraitant_evaluation WHERE sous_traitant_id=$1 ORDER BY date_eval DESC", [id])).rows;
  const totalMarche = st.contrats.reduce((s, c) => s + Number(c.montant_marche), 0);
  const totalPaye = st.situations.reduce((s, x) => s + Number(x.net_a_payer || 0), 0);
  const notes = st.evaluations.map((e) => Number(e.note)).filter((n) => n);
  st.synthese = { total_marche: +totalMarche.toFixed(2), total_paye: +totalPaye.toFixed(2), note_moyenne: notes.length ? +(notes.reduce((a, b) => a + b, 0) / notes.length).toFixed(1) : null };
  res.json(st);
}));

// Situation de sous-traitance (avancement + retenue de garantie, cumul)
app.post("/api/soustraitants/situation", requireAuth, wrap(async (req, res) => {
  const contrat_id = Number(req.body?.contrat_id), avancement = Number(req.body?.avancement) || 0;
  const sc = (await pool.query("SELECT * FROM soustraitant_contrat WHERE id=$1", [contrat_id])).rows[0];
  if (!sc) return res.status(404).json({ error: "Contrat introuvable" });
  const cumul = Number((await pool.query(
    "SELECT COALESCE(SUM(montant),0)::numeric s FROM soustraitant_situation WHERE contrat_id=$1", [contrat_id])).rows[0].s);
  const cumule = Number(sc.montant_marche) * avancement / 100;
  const montant = +(cumule - cumul).toFixed(2);
  if (montant <= 0) return res.status(400).json({ error: "Avancement ≤ au déjà payé" });
  const rg = +(montant * Number(sc.rg_taux) / 100).toFixed(2);
  const net = +(montant - rg).toFixed(2);
  const { rows } = await pool.query(
    `INSERT INTO soustraitant_situation (sous_traitant_id,chantier_id,contrat_id,montant,avancement,cumul_anterieur,retenue_garantie,net_a_payer,statut,date_situation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'a_payer',now()) RETURNING *`,
    [sc.sous_traitant_id, sc.chantier_id, contrat_id, montant, avancement, cumul, rg, net]);
  res.status(201).json(rows[0]);
}));

// ══════════════ DOCUMENTS PDF (devis, factures) ══════════════
function logoBuffer(logo) {
  if (!logo || typeof logo !== "string" || !logo.startsWith("data:")) return null;
  const b64 = logo.split(",")[1]; if (!b64) return null;
  try { return Buffer.from(b64, "base64"); } catch { return null; }
}
function docLetterhead(doc, co, title, numero, dateStr) {
  const M = 40, W = 515;
  // Logo
  const lb = logoBuffer(co.logo);
  let lx = M, infoX = M;
  if (lb) { try { doc.image(lb, M, 40, { fit: [120, 58] }); infoX = M + 134; } catch { /* format non géré */ } }
  // Coordonnées société (largeur bornée pour ne pas chevaucher le cartouche)
  const infoW = (M + W - 168) - infoX - 14;
  doc.fillColor("#15171C").font("Helvetica-Bold").fontSize(14).text(co.raison_sociale || "Société", infoX, 42, { width: infoW });
  doc.font("Helvetica").fontSize(8.5).fillColor("#5A6473");
  const lines = [co.adresse, co.ville, [co.telephone, co.email].filter(Boolean).join(" · ")].filter(Boolean);
  doc.text(lines.join("\n"), infoX, 64, { width: infoW });
  // Cartouche document (droite)
  doc.roundedRect(M + W - 168, 40, 168, 64, 6).fill("#15171C");
  doc.fill("#F5B301").font("Helvetica-Bold").fontSize(13).text(title, M + W - 158, 52, { width: 148, align: "right" });
  doc.fill("#fff").font("Helvetica").fontSize(9).text("N° " + (numero || "—"), M + W - 158, 72, { width: 148, align: "right" });
  doc.fillColor("#cbd5e1").fontSize(8.5).text(dateStr, M + W - 158, 86, { width: 148, align: "right" });
  // Bande hazard
  doc.rect(M, 116, W, 4).fill("#F5B301");
  return 132;
}
function clientBlock(doc, y, client, extra, ice, label) {
  const M = 40;
  const h = ice ? 66 : 56;
  doc.roundedRect(M, y, 250, h, 6).fillAndStroke("#f7f8fa", "#e3e7ec");
  doc.fill("#5A6473").font("Helvetica-Bold").fontSize(8).text(label || "CLIENT", M + 12, y + 9);
  doc.fill("#15171C").font("Helvetica-Bold").fontSize(11).text(client || "—", M + 12, y + 22, { width: 226 });
  let yy = y + 38;
  if (ice) { doc.font("Helvetica").fontSize(8.5).fillColor("#5A6473").text("ICE : " + ice, M + 12, yy, { width: 226 }); yy += 13; }
  if (extra) { doc.font("Helvetica").fontSize(8.5).fillColor("#5A6473").text(extra, M + 12, yy, { width: 226 }); }
  return y + h + 16;
}
// Bloc texte (attestations, PV, ordres de service…)
function docParagraphs(doc, y, paras) {
  const M = 40, W = 515;
  for (const p of paras) {
    if (!p) { y += 8; continue; }
    const opt = typeof p === "object" ? p : { text: p };
    doc.font(opt.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opt.size || 10.5).fillColor(opt.color || "#15171C");
    doc.text(opt.text, M, y, { width: W, align: opt.align || "left", lineGap: 3 });
    y = doc.y + (opt.gap != null ? opt.gap : 8);
  }
  return y;
}
// Tableau générique
function docTable(doc, y, cols, rows, opt = {}) {
  const M = 40, W = 515;
  const xs = []; let x = M; cols.forEach((c) => { xs.push(x); x += c.w; });
  doc.rect(M, y, W, 20).fill("#15171C");
  doc.fill("#fff").font("Helvetica-Bold").fontSize(8.5);
  cols.forEach((c, i) => doc.text(c.h, xs[i] + 5, y + 6, { width: c.w - 8, align: c.align || "left" }));
  y += 20;
  doc.font("Helvetica").fontSize(8.5);
  rows.forEach((r, ri) => {
    const rh = opt.rh || 18;
    if (ri % 2) { doc.rect(M, y, W, rh).fill("#f7f8fa"); }
    doc.fillColor("#15171C").font("Helvetica").fontSize(8.5);
    cols.forEach((c, i) => doc.text(r[i] == null ? "" : String(r[i]), xs[i] + 5, y + 5, { width: c.w - 8, align: c.align || "left" }));
    y += rh;
  });
  doc.rect(M, y, W, 0.6).fill("#e3e7ec");
  return y + 8;
}
function newDoc(res, filename) {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}
const getEmp = async (id) => (await pool.query("SELECT * FROM employee WHERE id=$1", [id])).rows[0];
function docTotals(doc, y, rows) {
  const M = 40, W = 515, bx = M + W - 230;
  for (const [lbl, val, strong] of rows) {
    if (strong) { doc.roundedRect(bx, y - 2, 230, 24, 5).fill("#15171C"); doc.fill("#F5B301"); }
    else doc.fill("#15171C");
    doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 11 : 10);
    doc.text(lbl, bx + 12, y + (strong ? 3 : 1), { width: 120 });
    doc.text(moneyFR(val), bx + 120, y + (strong ? 3 : 1), { width: 98, align: "right" });
    y += strong ? 28 : 18;
  }
  return y;
}
function docFooter(doc, co, mention) {
  const M = 40, W = 515;
  doc.fontSize(8).fillColor("#5A6473").font("Helvetica");
  if (mention) doc.text(mention, M, 700, { width: W });
  if (co.rib) doc.text("RIB : " + co.rib, M, 724, { width: W });
  const legal = ["ICE " + (co.ice || "—"), co.rc ? "RC " + co.rc : null, co.if_fiscal ? "IF " + co.if_fiscal : null, co.patente ? "Patente " + co.patente : null, co.cnss ? "CNSS " + co.cnss : null].filter(Boolean).join("  ·  ");
  doc.rect(M, 752, W, 0.6).fill("#e3e7ec");
  doc.fillColor("#8A93A2").fontSize(7.5).text(legal, M, 758, { width: W, align: "center" });
}
const getCompany = async (id) => (await pool.query("SELECT * FROM company WHERE id=$1", [id])).rows[0] || { raison_sociale: "Société" };

app.get("/api/devis/:id/pdf", requireAuth, wrap(async (req, res) => {
  const d = (await pool.query("SELECT * FROM devis WHERE id=$1", [req.params.id])).rows[0];
  if (!d) return res.status(404).json({ error: "Devis introuvable" });
  const lignes = (await pool.query("SELECT * FROM devis_ligne WHERE devis_id=$1 ORDER BY id", [d.id])).rows;
  const co = await getCompany(d.company_id || (await cid(req)));
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="devis-${d.numero || d.id}.pdf"`);
  doc.pipe(res);
  let y = docLetterhead(doc, co, "DEVIS", d.numero || d.id, new Date(d.created_at || Date.now()).toLocaleDateString("fr-FR"));
  y = clientBlock(doc, y + 6, d.client, d.objet, d.client_ice);
  // Tableau
  const M = 40, W = 515; const cols = [M + 8, M + 285, M + 350, M + 430];
  doc.rect(M, y, W, 22).fill("#15171C");
  doc.fill("#fff").font("Helvetica-Bold").fontSize(9);
  doc.text("DÉSIGNATION", cols[0], y + 7); doc.text("QTÉ", cols[1], y + 7, { width: 50, align: "right" });
  doc.text("P.U. HT", cols[2], y + 7, { width: 70, align: "right" }); doc.text("TOTAL HT", cols[3], y + 7, { width: 75, align: "right" });
  y += 22;
  doc.font("Helvetica").fontSize(9).fillColor("#15171C");
  lignes.forEach((l, i) => {
    const h = 20; if (i % 2) { doc.rect(M, y, W, h).fill("#f7f8fa"); doc.fillColor("#15171C"); }
    doc.text(l.designation || "", cols[0], y + 6, { width: 235 });
    doc.text(String(l.quantite), cols[1], y + 6, { width: 50, align: "right" });
    doc.text(moneyFR(l.prix_vente).replace(" MAD", ""), cols[2], y + 6, { width: 70, align: "right" });
    doc.text(moneyFR(l.total).replace(" MAD", ""), cols[3], y + 6, { width: 75, align: "right" });
    y += h;
  });
  doc.rect(M, y, W, 0.6).fill("#e3e7ec"); y += 14;
  const tva = Number(d.tva), ttc = Number(d.total_ttc);
  y = docTotals(doc, y, [["Total HT", d.total_ht], ["TVA (20%)", tva], ["TOTAL TTC", ttc, true]]);
  docFooter(doc, co, `Arrêté le présent devis à la somme de ${moneyFR(ttc)} TTC. Validité 30 jours. Conditions de règlement à convenir.`);
  doc.end();
}));

app.get("/api/factures/:id/pdf", requireAuth, wrap(async (req, res) => {
  const f = (await pool.query("SELECT * FROM facture WHERE id=$1", [req.params.id])).rows[0];
  if (!f) return res.status(404).json({ error: "Facture introuvable" });
  const co = await getCompany(f.company_id || (await cid(req)));
  const titles = { situation: "SITUATION", acompte: "FACTURE D'ACOMPTE", avoir: "AVOIR", facture: "FACTURE" };
  const title = titles[f.type] || "FACTURE";
  const isSit = f.type === "situation", isAvoir = f.type === "avoir";
  const doc = newDoc(res, `${(f.type || "facture")}-${f.numero || f.id}.pdf`);
  let y = docLetterhead(doc, co, title, f.numero || f.id, new Date(f.date_emission || Date.now()).toLocaleDateString("fr-FR"));
  const extra = isSit && f.avancement ? `Avancement cumulé : ${f.avancement} %` : (isAvoir && f.motif ? `Motif : ${f.motif}` : null);
  y = clientBlock(doc, y + 6, f.client, extra, f.client_ice);
  const sign = isAvoir ? -1 : 1;
  const ht = Math.abs(Number(f.montant_ht)), tva = Math.abs(Number(f.tva)), ttc = Math.abs(Number(f.montant_ttc)), rg = Number(f.retenue_garantie) || 0, net = Number(f.net_a_payer) || ttc;
  const M = 40, W = 515;
  doc.rect(M, y, W, 22).fill("#15171C");
  doc.fill("#fff").font("Helvetica-Bold").fontSize(9).text("DÉSIGNATION", M + 8, y + 7).text("MONTANT HT", M + W - 130, y + 7, { width: 122, align: "right" });
  y += 22;
  doc.font("Helvetica").fontSize(9).fillColor("#15171C");
  const desc = isSit ? `Travaux exécutés — situation à ${f.avancement || 0} % (déduction des situations antérieures)`
    : f.type === "acompte" ? "Acompte sur travaux à venir"
    : isAvoir ? (f.motif || "Avoir / note de crédit") : "Prestations / travaux";
  doc.text(desc, M + 8, y + 6, { width: 340 }).text((isAvoir ? "-" : "") + moneyFR(ht).replace(" MAD", ""), M + W - 130, y + 6, { width: 122, align: "right" });
  y += 30; doc.rect(M, y, W, 0.6).fill("#e3e7ec"); y += 14;
  const s = (v) => sign * v;
  const rows = [["Montant HT", s(ht)], ["TVA (20%)", s(tva)], [isAvoir ? "MONTANT TTC AVOIR" : "Montant TTC", s(ttc), true]];
  if (rg > 0) { rows.push(["Retenue de garantie", -rg]); rows.push(["NET À PAYER", net, true]); }
  y = docTotals(doc, y, rows);
  const mention = isSit ? `Net à payer : ${moneyFR(net)}. Retenue de garantie ${f.rg_taux || 0} % conservée jusqu'à réception définitive.`
    : isAvoir ? `Avoir de ${moneyFR(ttc)} TTC à imputer sur facture${f.ref_facture_id ? " n° réf. " + f.ref_facture_id : ""}.`
    : `Montant à régler : ${moneyFR(net)}. Paiement à réception. Tout retard expose à des pénalités (loi n° 69-21 sur les délais de paiement).`;
  docFooter(doc, co, mention);
  doc.end();
}));

// ══════════════ NOUVEAUX DOCUMENTS ══════════════

// ── Facture d'acompte (depuis un devis) ──
app.post("/api/factures/acompte", requireAuth, wrap(async (req, res) => {
  const devis_id = Number(req.body?.devis_id), pct = Number(req.body?.pct) || 30;
  const d = (await pool.query("SELECT * FROM devis WHERE id=$1", [devis_id])).rows[0];
  if (!d) return res.status(404).json({ error: "Devis introuvable" });
  const company = await cid(req);
  const ht = +(Number(d.total_ht) * pct / 100).toFixed(2), tva = +(ht * 0.2).toFixed(2), ttc = +(ht + tva).toFixed(2);
  const num = await nextNumero(pool, company, "facture");
  const f = (await pool.query(
    `INSERT INTO facture (numero,client,client_ice,chantier_id,devis_id,type,montant_ht,tva,montant_ttc,net_a_payer,statut,company_id)
     VALUES ($1,$2,$3,$4,$5,'acompte',$6,$7,$8,$8,'emise',$9) RETURNING *`,
    [num, d.client, d.client_ice, d.chantier_id, devis_id, ht, tva, ttc, company])).rows[0];
  res.status(201).json(f);
}));

// ── Avoir / note de crédit (depuis une facture) ──
app.post("/api/factures/avoir", requireAuth, wrap(async (req, res) => {
  const facture_id = Number(req.body?.facture_id), motif = (req.body?.motif || "").trim();
  const o = (await pool.query("SELECT * FROM facture WHERE id=$1", [facture_id])).rows[0];
  if (!o) return res.status(404).json({ error: "Facture introuvable" });
  const company = await cid(req);
  const num = await nextNumero(pool, company, "facture");
  const f = (await pool.query(
    `INSERT INTO facture (numero,client,client_ice,chantier_id,type,montant_ht,tva,montant_ttc,net_a_payer,ref_facture_id,motif,statut,company_id)
     VALUES ($1,$2,$3,$4,'avoir',$5,$6,$7,$7,$8,$9,'emise',$10) RETURNING *`,
    [num, o.client, o.client_ice, o.chantier_id, o.montant_ht, o.tva, o.montant_ttc, facture_id, motif || "Annulation / correction", company])).rows[0];
  res.status(201).json(f);
}));

// ── Bon de commande fournisseur (PDF) ──
app.get("/api/commandes/:id/pdf", requireAuth, wrap(async (req, res) => {
  const bc = (await pool.query("SELECT * FROM bon_commande WHERE id=$1", [req.params.id])).rows[0];
  if (!bc) return res.status(404).json({ error: "Introuvable" });
  const lignes = (await pool.query("SELECT * FROM bon_commande_ligne WHERE commande_id=$1 ORDER BY id", [bc.id])).rows;
  const four = bc.fournisseur_id ? (await pool.query("SELECT * FROM fournisseur WHERE id=$1", [bc.fournisseur_id])).rows[0] : null;
  const co = await getCompany(bc.company_id || (await cid(req)));
  const doc = newDoc(res, `bon-commande-${bc.numero || bc.id}.pdf`);
  let y = docLetterhead(doc, co, "COMMANDE", bc.numero || bc.id, new Date(bc.date_commande || bc.created_at || Date.now()).toLocaleDateString("fr-FR"));
  y = clientBlock(doc, y + 6, four ? four.raison_sociale : "Fournisseur", four && four.telephone ? "Tél : " + four.telephone : null, four ? four.ice : null, "FOURNISSEUR");
  let total = 0;
  const rows = lignes.map((l) => { const t = (Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0); total += t; return [l.designation || "", String(l.quantite), moneyFR(l.prix_unitaire).replace(" MAD", ""), moneyFR(t).replace(" MAD", "")]; });
  y = docTable(doc, y, [{ h: "DÉSIGNATION", w: 270 }, { h: "QTÉ", w: 60, align: "right" }, { h: "P.U.", w: 90, align: "right" }, { h: "TOTAL", w: 95, align: "right" }], rows);
  y = docTotals(doc, y + 6, [["TOTAL HT", total], ["TVA (20%)", +(total * 0.2).toFixed(2)], ["TOTAL TTC", +(total * 1.2).toFixed(2), true]]);
  docFooter(doc, co, "Bon de commande valant engagement. Merci d'accuser réception et de respecter les délais convenus.");
  doc.end();
}));

// ── Bon de réception (PDF, depuis une commande) ──
app.get("/api/commandes/:id/reception/pdf", requireAuth, wrap(async (req, res) => {
  const bc = (await pool.query("SELECT * FROM bon_commande WHERE id=$1", [req.params.id])).rows[0];
  if (!bc) return res.status(404).json({ error: "Introuvable" });
  const lignes = (await pool.query("SELECT * FROM bon_commande_ligne WHERE commande_id=$1 ORDER BY id", [bc.id])).rows;
  const four = bc.fournisseur_id ? (await pool.query("SELECT * FROM fournisseur WHERE id=$1", [bc.fournisseur_id])).rows[0] : null;
  const co = await getCompany(bc.company_id || (await cid(req)));
  const doc = newDoc(res, `bon-reception-${bc.numero || bc.id}.pdf`);
  let y = docLetterhead(doc, co, "RÉCEPTION", bc.numero || bc.id, new Date(bc.date_reception || Date.now()).toLocaleDateString("fr-FR"));
  y = clientBlock(doc, y + 6, four ? four.raison_sociale : "Fournisseur", "Réf. commande : " + (bc.numero || bc.id), four ? four.ice : null, "FOURNISSEUR");
  const rows = lignes.map((l) => [l.designation || "", String(l.quantite), "", ""]);
  y = docTable(doc, y, [{ h: "DÉSIGNATION", w: 270 }, { h: "QTÉ CMD", w: 75, align: "right" }, { h: "QTÉ REÇUE", w: 85, align: "right" }, { h: "OBSERV.", w: 85 }], rows, { rh: 22 });
  y = docParagraphs(doc, y + 16, [
    { text: "Conformité de la livraison : ☐ Conforme   ☐ Réserves (préciser ci-dessous)", size: 10 },
    { text: "Réserves / observations : ............................................................................................................", size: 10, gap: 24 },
    { text: "Réceptionné par : ...............................................     Signature : ...............................................", size: 10 },
  ]);
  docFooter(doc, co, "Document attestant la réception des fournitures sur chantier. À conserver pour le rapprochement avec la facture.");
  doc.end();
}));

// ── PV de réception de travaux (PDF, depuis un chantier) ──
app.get("/api/chantiers/:id/pv/pdf", requireAuth, wrap(async (req, res) => {
  const c = (await pool.query("SELECT * FROM chantier WHERE id=$1", [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: "Chantier introuvable" });
  const co = await getCompany(c.company_id || (await cid(req)));
  const doc = newDoc(res, `pv-reception-${c.code || c.id}.pdf`);
  let y = docLetterhead(doc, co, "PV TRAVAUX", c.code || c.id, new Date().toLocaleDateString("fr-FR"));
  y = clientBlock(doc, y + 6, c.client || "—", c.ville ? "Lieu : " + c.ville : null, null, "MAÎTRE D'OUVRAGE");
  y = docParagraphs(doc, y + 6, [
    { text: "PROCÈS-VERBAL DE RÉCEPTION DES TRAVAUX", bold: true, size: 13, align: "center", gap: 14 },
    { text: `Projet / chantier : ${c.nom || "—"} (réf. ${c.code || "—"}).`, size: 10.5 },
    { text: `Le maître d'ouvrage et l'entreprise ${co.raison_sociale}, après visite contradictoire des ouvrages exécutés, conviennent de ce qui suit :`, size: 10.5, gap: 12 },
    { text: "Décision de réception :", bold: true, size: 11 },
    { text: "☐ Réception prononcée SANS réserve", size: 10.5, gap: 2 },
    { text: "☐ Réception prononcée AVEC réserves (détaillées ci-dessous)", size: 10.5, gap: 2 },
    { text: "☐ Réception refusée", size: 10.5, gap: 14 },
    { text: "Réserves éventuelles :", bold: true, size: 11 },
    { text: ".................................................................................................................................................", size: 10.5, gap: 4 },
    { text: ".................................................................................................................................................", size: 10.5, gap: 4 },
    { text: ".................................................................................................................................................", size: 10.5, gap: 24 },
    { text: "Date de prise d'effet de la réception : ............................     Délai de levée des réserves : ............................", size: 10.5, gap: 30 },
  ]);
  docParagraphs(doc, y, [{ text: "Le Maître d'ouvrage                                                          L'Entreprise", bold: true, size: 10.5 }]);
  docFooter(doc, co, "La réception marque le point de départ des garanties légales et, le cas échéant, la libération de la retenue de garantie.");
  doc.end();
}));

// ── Ordre de service (PDF, depuis un chantier) ──
app.get("/api/chantiers/:id/os/pdf", requireAuth, wrap(async (req, res) => {
  const c = (await pool.query("SELECT * FROM chantier WHERE id=$1", [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: "Chantier introuvable" });
  const co = await getCompany(c.company_id || (await cid(req)));
  const doc = newDoc(res, `ordre-service-${c.code || c.id}.pdf`);
  let y = docLetterhead(doc, co, "ORDRE SERVICE", c.code || c.id, new Date().toLocaleDateString("fr-FR"));
  y = clientBlock(doc, y + 6, c.client || "—", "Chantier : " + (c.nom || "—"), null, "DESTINATAIRE");
  y = docParagraphs(doc, y + 6, [
    { text: "ORDRE DE SERVICE", bold: true, size: 13, align: "center", gap: 14 },
    { text: `Objet : ${c.nom || "—"} (réf. chantier ${c.code || "—"}).`, size: 10.5, gap: 12 },
    { text: "Par le présent ordre de service, il est prescrit :", size: 10.5, gap: 8 },
    { text: "☐ De DÉMARRER les travaux à compter du : ............................", size: 10.5, gap: 4 },
    { text: "☐ De SUSPENDRE les travaux à compter du : ............................", size: 10.5, gap: 4 },
    { text: "☐ De REPRENDRE les travaux à compter du : ............................", size: 10.5, gap: 14 },
    { text: "Instructions particulières :", bold: true, size: 11 },
    { text: ".................................................................................................................................................", size: 10.5, gap: 4 },
    { text: ".................................................................................................................................................", size: 10.5, gap: 30 },
    { text: "Fait à ........................, le ........................                                   Signature et cachet :", size: 10.5 },
  ]);
  docFooter(doc, co, "Document contractuel. Le délai d'exécution court à compter de la date indiquée dans le présent ordre.");
  doc.end();
}));

// ── Documents RH (attestations, solde de tout compte) ──
function rhHeader(doc, co, title) {
  return docLetterhead(doc, co, title, "", new Date().toLocaleDateString("fr-FR"));
}
app.get("/api/employees/:id/:doc(attestation-travail|attestation-salaire|solde-tout-compte)/pdf", requireAuth, wrap(async (req, res) => {
  const e = await getEmp(req.params.id);
  if (!e) return res.status(404).json({ error: "Salarié introuvable" });
  const co = await getCompany(e.company_id || (await cid(req)));
  const kind = req.params.doc;
  const dEmb = e.date_embauche ? new Date(e.date_embauche).toLocaleDateString("fr-FR") : "............";
  let title = "ATTESTATION", filename = kind, body = [];
  if (kind === "attestation-travail") {
    title = "ATTESTATION";
    body = [
      { text: "ATTESTATION DE TRAVAIL", bold: true, size: 14, align: "center", gap: 18 },
      { text: `Nous soussignés, ${co.raison_sociale}, attestons que :`, size: 11, gap: 12 },
      { text: `M./Mme ${e.nom}, titulaire de la CIN n° ${e.cin || "............"}, est employé(e) au sein de notre société en qualité de ${e.poste || "............"} depuis le ${dEmb}.`, size: 11, gap: 12 },
      { text: "La présente attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.", size: 11, gap: 40 },
    ];
  } else if (kind === "attestation-salaire") {
    const ps = (await pool.query("SELECT * FROM payslip WHERE employee_id=$1 ORDER BY periode DESC LIMIT 1", [e.id])).rows[0];
    const brut = ps ? Number(ps.brut) : Number(e.salaire_base), net = ps ? Number(ps.net) : null;
    title = "ATTESTATION";
    body = [
      { text: "ATTESTATION DE SALAIRE", bold: true, size: 14, align: "center", gap: 18 },
      { text: `Nous soussignés, ${co.raison_sociale}, attestons que M./Mme ${e.nom} (CIN ${e.cin || "............"}), ${e.poste || "............"}, perçoit la rémunération suivante :`, size: 11, gap: 12 },
      { text: `• Salaire brut mensuel : ${moneyFR(brut)}`, size: 11, gap: 4 },
      net != null ? { text: `• Salaire net mensuel : ${moneyFR(net)}`, size: 11, gap: 12 } : { text: "", gap: 4 },
      { text: "Attestation délivrée pour servir et valoir ce que de droit.", size: 11, gap: 40 },
    ];
  } else {
    title = "SOLDE STC";
    body = [
      { text: "REÇU POUR SOLDE DE TOUT COMPTE", bold: true, size: 14, align: "center", gap: 18 },
      { text: `Je soussigné(e) M./Mme ${e.nom} (CIN ${e.cin || "............"}), ${e.poste || "............"}, reconnais avoir reçu de ${co.raison_sociale} la somme de ............................ MAD,`, size: 11, gap: 8 },
      { text: "pour solde de tout compte, en règlement de l'ensemble des salaires, indemnités et accessoires de toute nature qui m'étaient dus au titre de l'exécution et de la cessation de mon contrat de travail.", size: 11, gap: 12 },
      { text: "Établi en double exemplaire. Le reçu pour solde de tout compte peut être dénoncé dans les 60 jours suivant sa signature.", size: 10, color: "#5A6473", gap: 40 },
    ];
  }
  const doc = newDoc(res, `${filename}-${e.matricule || e.id}.pdf`);
  let y = rhHeader(doc, co, title);
  y = clientBlock(doc, y + 6, e.nom, "Matricule : " + (e.matricule || "—"), null, "SALARIÉ");
  y = docParagraphs(doc, y + 10, body);
  docParagraphs(doc, Math.max(y, 600), [{ text: `Fait à ${co.ville || "............"}, le ${new Date().toLocaleDateString("fr-FR")}.`, size: 10.5, gap: 24 }, { text: "Signature et cachet :", bold: true, size: 10.5 }]);
  docFooter(doc, co, "");
  doc.end();
}));

// ── Documents de paie collective (depuis un run) ──
async function runData(req) {
  const run = (await pool.query("SELECT * FROM payroll_run WHERE id=$1", [req.params.id])).rows[0];
  if (!run) return null;
  const slips = (await pool.query(
    `SELECT p.*, e.matricule, e.nom, e.cin FROM payslip p JOIN employee e ON e.id=p.employee_id WHERE p.run_id=$1 ORDER BY e.matricule`, [run.id])).rows;
  const co = await getCompany((await cid(req)));
  return { run, slips, co };
}
const MOISFR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
app.get("/api/payroll/runs/:id/virement/pdf", requireAuth, wrap(async (req, res) => {
  const data = await runData(req); if (!data) return res.status(404).json({ error: "Période introuvable" });
  const { run, slips, co } = data;
  const doc = newDoc(res, `ordre-virement-${run.periode_annee}-${run.periode_mois}.pdf`);
  let y = docLetterhead(doc, co, "VIREMENT", `${run.periode_annee}-${String(run.periode_mois).padStart(2, "0")}`, new Date().toLocaleDateString("fr-FR"));
  y = docParagraphs(doc, y + 4, [{ text: `Ordre de virement des salaires — ${MOISFR[run.periode_mois - 1]} ${run.periode_annee}`, bold: true, size: 12, gap: 10 }]);
  let total = 0;
  const rows = slips.map((s) => { total += Number(s.net); return [s.matricule, s.nom, "", moneyFR(s.net).replace(" MAD", "")]; });
  y = docTable(doc, y, [{ h: "MATRICULE", w: 80 }, { h: "BÉNÉFICIAIRE", w: 200 }, { h: "RIB", w: 130 }, { h: "NET (MAD)", w: 105, align: "right" }], rows);
  y = docTotals(doc, y + 6, [["TOTAL À VIRER", total, true]]);
  docFooter(doc, co, `Veuillez procéder au virement de ${moneyFR(total)} au profit des bénéficiaires ci-dessus, par le débit de notre compte ${co.rib || "............"}.`);
  doc.end();
}));
app.get("/api/payroll/runs/:id/livre/pdf", requireAuth, wrap(async (req, res) => {
  const data = await runData(req); if (!data) return res.status(404).json({ error: "Période introuvable" });
  const { run, slips, co } = data;
  const doc = newDoc(res, `livre-paie-${run.periode_annee}-${run.periode_mois}.pdf`);
  let y = docLetterhead(doc, co, "LIVRE PAIE", `${run.periode_annee}-${String(run.periode_mois).padStart(2, "0")}`, new Date().toLocaleDateString("fr-FR"));
  y = docParagraphs(doc, y + 4, [{ text: `Livre de paie — ${MOISFR[run.periode_mois - 1]} ${run.periode_annee}`, bold: true, size: 12, gap: 10 }]);
  let tb = 0, tc = 0, ti = 0, tn = 0, tk = 0;
  const rows = slips.map((s) => {
    tb += +s.brut; tc += +s.cnss; ti += +s.ir; tn += +s.net; tk += +s.cout_total;
    return [s.matricule, s.nom, moneyFR(s.brut).replace(" MAD", ""), moneyFR(s.cnss).replace(" MAD", ""), moneyFR(s.ir).replace(" MAD", ""), moneyFR(s.net).replace(" MAD", "")];
  });
  rows.push(["", "TOTAUX", moneyFR(tb).replace(" MAD", ""), moneyFR(tc).replace(" MAD", ""), moneyFR(ti).replace(" MAD", ""), moneyFR(tn).replace(" MAD", "")]);
  y = docTable(doc, y, [{ h: "MAT.", w: 55 }, { h: "NOM", w: 150 }, { h: "BRUT", w: 78, align: "right" }, { h: "CNSS/AMO", w: 78, align: "right" }, { h: "IR", w: 70, align: "right" }, { h: "NET", w: 84, align: "right" }], rows);
  docFooter(doc, co, `Coût employeur total de la période : ${moneyFR(tk)}.`);
  doc.end();
}));
app.get("/api/payroll/runs/:id/bds/pdf", requireAuth, wrap(async (req, res) => {
  const data = await runData(req); if (!data) return res.status(404).json({ error: "Période introuvable" });
  const { run, slips, co } = data;
  const doc = newDoc(res, `bordereau-cnss-${run.periode_annee}-${run.periode_mois}.pdf`);
  let y = docLetterhead(doc, co, "BORDEREAU", `${run.periode_annee}-${String(run.periode_mois).padStart(2, "0")}`, new Date().toLocaleDateString("fr-FR"));
  y = docParagraphs(doc, y + 4, [{ text: `Bordereau de déclaration des salaires (CNSS) — ${MOISFR[run.periode_mois - 1]} ${run.periode_annee}`, bold: true, size: 11.5, gap: 2 }, { text: `Affiliation CNSS : ${co.cnss || "............"}`, size: 9.5, color: "#5A6473", gap: 10 }]);
  let tbrut = 0, tplaf = 0;
  const rows = slips.map((s) => {
    const brut = Number(s.brut), plaf = Math.min(brut, 6000); tbrut += brut; tplaf += plaf;
    return [s.matricule, s.nom, "26", moneyFR(brut).replace(" MAD", ""), moneyFR(plaf).replace(" MAD", "")];
  });
  rows.push(["", "TOTAUX", "", moneyFR(tbrut).replace(" MAD", ""), moneyFR(tplaf).replace(" MAD", "")]);
  y = docTable(doc, y, [{ h: "N° CNSS / MAT.", w: 95 }, { h: "NOM & PRÉNOM", w: 175 }, { h: "JOURS", w: 50, align: "right" }, { h: "SAL. RÉEL", w: 95, align: "right" }, { h: "SAL. PLAFONNÉ", w: 100, align: "right" }], rows);
  docFooter(doc, co, "Document préparatoire à la télédéclaration Damancom. Salaire plafonné à 6 000 MAD pour les prestations sociales. À déposer avant le 10 du mois suivant.");
  doc.end();
}));

// ══════════════ PARC MATÉRIEL ══════════════
app.post("/api/materiel/:id/affecter", requireAuth, wrap(async (req, res) => {
  const { chantier_id, etat } = req.body || {};
  const { rows } = await pool.query("UPDATE materiel SET chantier_id=$2, etat=COALESCE($3,etat) WHERE id=$1 RETURNING *", [req.params.id, chantier_id || null, etat || null]);
  if (!rows[0]) return res.status(404).json({ error: "Introuvable" });
  res.json(rows[0]);
}));
app.get("/api/materiel/:id/maintenance", requireAuth, wrap(async (req, res) =>
  res.json((await pool.query("SELECT * FROM materiel_maintenance WHERE materiel_id=$1 ORDER BY date_maintenance DESC", [req.params.id])).rows)));
app.post("/api/materiel/:id/maintenance", requireAuth, wrap(async (req, res) => {
  const { date_maintenance, type, cout, note } = req.body || {};
  const company = await cid(req);
  const m = (await pool.query("INSERT INTO materiel_maintenance (materiel_id,date_maintenance,type,cout,note,company_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [req.params.id, date_maintenance || new Date(), type || null, cout || 0, note || null, company])).rows[0];
  await pool.query("UPDATE materiel SET etat='maintenance' WHERE id=$1", [req.params.id]);
  res.status(201).json(m);
}));

// ══════════════ RAPPORTS DE CHANTIER (avec photos) ══════════════
app.get("/api/rapports", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  const where = req.query.chantier_id ? "AND r.chantier_id=$2" : "";
  const params = req.query.chantier_id ? [company, req.query.chantier_id] : [company];
  const rows = (await pool.query(
    `SELECT r.id, r.chantier_id, r.date_rapport, r.meteo, r.effectif, r.avancement, r.observations,
            c.code AS chantier_code, c.nom AS chantier_nom,
            (SELECT count(*)::int FROM rapport_photo WHERE rapport_id=r.id) AS nb_photos
     FROM rapport_chantier r LEFT JOIN chantier c ON c.id=r.chantier_id
     WHERE r.company_id=$1 ${where} ORDER BY r.date_rapport DESC, r.id DESC`, params)).rows;
  res.json(rows);
}));
app.get("/api/rapports/:id", requireAuth, wrap(async (req, res) => {
  const r = (await pool.query("SELECT * FROM rapport_chantier WHERE id=$1", [req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: "Introuvable" });
  r.photos = (await pool.query("SELECT id, legende, data FROM rapport_photo WHERE rapport_id=$1 ORDER BY id", [req.params.id])).rows;
  res.json(r);
}));
app.post("/api/rapports", requireAuth, wrap(async (req, res) => {
  const { chantier_id, date_rapport, meteo, effectif, avancement, observations, photos = [] } = req.body || {};
  const company = await cid(req);
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const r = (await conn.query(
      `INSERT INTO rapport_chantier (chantier_id,date_rapport,meteo,effectif,avancement,observations,company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [chantier_id || null, date_rapport || new Date(), meteo || null, effectif || 0, avancement || null, observations || null, company])).rows[0];
    for (const p of (photos || []).slice(0, 12))
      await conn.query("INSERT INTO rapport_photo (rapport_id,data,legende) VALUES ($1,$2,$3)", [r.id, p.data || null, p.legende || null]);
    await conn.query("COMMIT"); res.status(201).json(r);
  } catch (e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
}));
app.delete("/api/rapports/:id", requireAuth, wrap(async (req, res) => { await pool.query("DELETE FROM rapport_chantier WHERE id=$1", [req.params.id]); res.json({ ok: true }); }));
app.get("/api/rapports/:id/pdf", requireAuth, wrap(async (req, res) => {
  const r = (await pool.query("SELECT * FROM rapport_chantier WHERE id=$1", [req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: "Introuvable" });
  const ch = r.chantier_id ? (await pool.query("SELECT * FROM chantier WHERE id=$1", [r.chantier_id])).rows[0] : null;
  const photos = (await pool.query("SELECT * FROM rapport_photo WHERE rapport_id=$1 ORDER BY id", [req.params.id])).rows;
  const co = await getCompany(r.company_id || (await cid(req)));
  const doc = newDoc(res, `rapport-${ch ? ch.code : r.id}.pdf`);
  let y = docLetterhead(doc, co, "RAPPORT", ch ? ch.code : r.id, new Date(r.date_rapport).toLocaleDateString("fr-FR"));
  y = clientBlock(doc, y + 6, ch ? ch.nom : "Chantier", ch && ch.ville ? "Lieu : " + ch.ville : null, null, "CHANTIER");
  y = docParagraphs(doc, y + 4, [
    { text: `Météo : ${r.meteo || "—"}     ·     Effectif présent : ${r.effectif || 0}`, size: 10.5, gap: 10 },
    { text: "Avancement", bold: true, size: 11, gap: 2 }, { text: r.avancement || "—", size: 10.5, gap: 10 },
    { text: "Observations", bold: true, size: 11, gap: 2 }, { text: r.observations || "—", size: 10.5, gap: 12 },
  ]);
  if (photos.length) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#15171C").text("Photos", 40, y); y += 16;
    const M = 40, W = 515, gp = 10, cw = (W - gp) / 2, chh = 140; let i = 0;
    for (const p of photos) {
      const buf = logoBuffer(p.data); if (!buf) continue;
      const col = i % 2, x = M + col * (cw + gp);
      if (col === 0 && y + chh > 770) { doc.addPage(); y = 50; }
      try { doc.image(buf, x, y, { fit: [cw, chh - 16], align: "center" }); } catch { /* image illisible */ }
      if (p.legende) doc.font("Helvetica").fontSize(8).fillColor("#5A6473").text(p.legende, x, y + chh - 13, { width: cw });
      if (col === 1) y += chh;
      i++;
    }
  }
  docFooter(doc, co, "Rapport de visite de chantier — document interne.");
  doc.end();
}));

// ══════════════ CENTRE D'ALERTES ══════════════
app.get("/api/alertes", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  const one = async (sql) => Number((await pool.query(sql, [company])).rows[0].n);
  const out = [];
  const add = (n, type, sev, view, msg) => { if (n > 0) out.push({ type, severite: sev, view, message: msg(n), count: n }); };
  add(await one("SELECT count(*)::int n FROM article WHERE company_id=$1 AND stock < seuil"), "stock", "alerte", "articles", (n) => `${n} article(s) sous le seuil de stock`);
  add(await one("SELECT count(*)::int n FROM incident WHERE company_id=$1 AND statut<>'clos'"), "securite", "alerte", "incidents", (n) => `${n} incident(s) de sécurité ouvert(s)`);
  add(await one("SELECT count(*)::int n FROM conge WHERE company_id=$1 AND statut='en_attente'"), "conges", "info", "conges", (n) => `${n} demande(s) de congé en attente`);
  add(await one("SELECT count(*)::int n FROM materiel WHERE company_id=$1 AND etat IN ('maintenance','hs')"), "materiel", "info", "materiel", (n) => `${n} matériel(s) en maintenance ou hors service`);
  add(await one("SELECT count(*)::int n FROM tache WHERE company_id=$1 AND date_fin < current_date AND avancement < 100 AND statut<>'termine'"), "planning", "alerte", "planning", (n) => `${n} tâche(s) de planning en retard`);
  add(await one(`SELECT count(*)::int n FROM facture f WHERE f.company_id=$1 AND f.type<>'avoir'
       AND f.date_emission < current_date - interval '60 days'
       AND COALESCE(f.net_a_payer,f.montant_ttc) > COALESCE((SELECT SUM(montant) FROM paiement WHERE facture_id=f.id AND sens='encaissement'),0)`),
    "tresorerie", "alerte", "tresorerie", (n) => `${n} facture(s) en retard de paiement (> 60 j)`);
  res.json({ total: out.reduce((s, a) => s + a.count, 0), alertes: out });
}));

// ══════════════ COMPTABILITÉ / TVA ══════════════
app.get("/api/compta", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  const annee = Number(req.query.annee) || new Date().getFullYear();
  const mois = Number(req.query.mois) || (new Date().getMonth() + 1);
  const ventes = (await pool.query(
    `SELECT id,numero,client,date_emission,type,montant_ht,tva,montant_ttc FROM facture
     WHERE company_id=$1 AND EXTRACT(YEAR FROM date_emission)=$2 AND EXTRACT(MONTH FROM date_emission)=$3
     ORDER BY date_emission`, [company, annee, mois])).rows;
  const achats = (await pool.query(
    `SELECT bc.id,bc.numero,bc.date_commande,bc.montant, f.raison_sociale AS fournisseur FROM bon_commande bc
     LEFT JOIN fournisseur f ON f.id=bc.fournisseur_id
     WHERE bc.company_id=$1 AND EXTRACT(YEAR FROM bc.date_commande)=$2 AND EXTRACT(MONTH FROM bc.date_commande)=$3
     ORDER BY bc.date_commande`, [company, annee, mois])).rows;
  const sgn = (t) => t === "avoir" ? -1 : 1;
  const tva_collectee = +ventes.reduce((s, v) => s + sgn(v.type) * Number(v.tva || 0), 0).toFixed(2);
  const ca_ht = +ventes.reduce((s, v) => s + sgn(v.type) * Number(v.montant_ht || 0), 0).toFixed(2);
  const tva_deductible = +achats.reduce((s, a) => s + Number(a.montant || 0) * 0.2, 0).toFixed(2);
  const tva_due = +(tva_collectee - tva_deductible).toFixed(2);
  const caAnnee = Number((await pool.query(`SELECT COALESCE(SUM(montant_ht),0) s FROM facture WHERE company_id=$1 AND type<>'avoir' AND EXTRACT(YEAR FROM date_emission)=$2`, [company, annee])).rows[0].s);
  res.json({
    annee, mois, regime: caAnnee >= 1000000 ? "mensuel" : "trimestriel", ca_annuel: caAnnee, ca_ht,
    tva_collectee, tva_deductible, tva_due,
    ventes: ventes.map((v) => ({ date: v.date_emission, numero: v.numero, tiers: v.client, type: v.type, ht: Number(v.montant_ht), tva: Number(v.tva), ttc: Number(v.montant_ttc) })),
    achats: achats.map((a) => ({ date: a.date_commande, numero: a.numero, tiers: a.fournisseur, ht: Number(a.montant), tva: +(Number(a.montant) * 0.2).toFixed(2), ttc: +(Number(a.montant) * 1.2).toFixed(2) })),
  });
}));

// ══════════════ JOURNAL D'ACTIVITÉ ══════════════
app.get("/api/activite", requireAuth, wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const rows = req.user.company_id
    ? (await pool.query("SELECT * FROM activite WHERE company_id=$1 ORDER BY created_at DESC LIMIT $2", [req.user.company_id, limit])).rows
    : (await pool.query("SELECT * FROM activite ORDER BY created_at DESC LIMIT $1", [limit])).rows;
  res.json(rows);
}));

// ══════════════ ONBOARDING (nouveau client) ══════════════
app.post("/api/onboarding", requireAuth, wrap(async (req, res) => {
  if (req.user.role !== "DIRECTEUR" || req.user.company_id) return res.status(403).json({ error: "Réservé au super-administrateur" });
  const { company = {}, user = {} } = req.body || {};
  if (!company.raison_sociale) return res.status(400).json({ error: "Raison sociale requise" });
  if (!user.email || !user.password) return res.status(400).json({ error: "Email et mot de passe de l'administrateur requis" });
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    const co = (await conn.query(
      `INSERT INTO company (raison_sociale,ice,adresse,ville,telephone,email,rc,if_fiscal,patente,cnss,rib,plan,abonnement_fin,actif)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'48h',$12,true) RETURNING *`,
      [company.raison_sociale, company.ice || null, company.adresse || null, company.ville || null, company.telephone || null, company.email || null, company.rc || null, company.if_fiscal || null, company.patente || null, company.cnss || null, company.rib || null, new Date(Date.now() + 2 * 86400000)])).rows[0];
    const hash = await bcrypt.hash(user.password, 10);
    const u = (await conn.query(
      `INSERT INTO app_user (email,password_hash,full_name,role,company_id) VALUES ($1,$2,$3,'DIRECTEUR',$4) RETURNING id,email,full_name,role,company_id`,
      [String(user.email).toLowerCase(), hash, user.full_name || null, co.id])).rows[0];
    await conn.query("COMMIT");
    res.status(201).json({ company: co, user: u });
  } catch (e) { await conn.query("ROLLBACK"); if (e.code === "23505") return res.status(409).json({ error: "Email déjà utilisé" }); throw e; } finally { conn.release(); }
}));

// ══════════════ SAUVEGARDE / EXPORT COMPLET ══════════════
app.get("/api/export/backup", requireAuth, wrap(async (req, res) => {
  if (req.user.role !== "DIRECTEUR") return res.status(403).json({ error: "Réservé au Directeur" });
  const company = await cid(req);
  const T = async (sql) => (await pool.query(sql, [company])).rows;
  const data = {
    genere_le: new Date().toISOString(), company_id: company,
    societe: await T("SELECT * FROM company WHERE id=$1"),
    salaries: await T("SELECT * FROM employee WHERE company_id=$1"),
    chantiers: await T("SELECT * FROM chantier WHERE company_id=$1"),
    devis: await T("SELECT * FROM devis WHERE company_id=$1"),
    factures: await T("SELECT * FROM facture WHERE company_id=$1"),
    paiements: await T("SELECT * FROM paiement WHERE company_id=$1"),
    articles: await T("SELECT * FROM article WHERE company_id=$1"),
    commandes: await T("SELECT * FROM bon_commande WHERE company_id=$1"),
    fournisseurs: await T("SELECT * FROM fournisseur WHERE company_id=$1"),
    sous_traitants: await T("SELECT * FROM sous_traitant WHERE company_id=$1"),
    pointages: await T("SELECT * FROM pointage WHERE company_id=$1"),
    taches: await T("SELECT * FROM tache WHERE company_id=$1"),
    materiel: await T("SELECT * FROM materiel WHERE company_id=$1"),
    rapports: await T("SELECT id,chantier_id,date_rapport,meteo,effectif,avancement,observations FROM rapport_chantier WHERE company_id=$1"),
  };
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="sauvegarde-btppro-${new Date().toISOString().slice(0, 10)}.json"`);
  res.end(JSON.stringify(data, null, 2));
}));

// ══════════════ INTÉGRATIONS — préparation (non certifiée) ══════════════
// Déclaration CNSS (préparation Damancom) — fichier par période
app.get("/api/integrations/damancom", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  const annee = Number(req.query.annee) || new Date().getFullYear();
  const mois = Number(req.query.mois) || (new Date().getMonth() + 1);
  const co = await getCompany(company);
  const run = (await pool.query("SELECT * FROM payroll_run WHERE company_id=$1 AND periode_annee=$2 AND periode_mois=$3", [company, annee, mois])).rows[0];
  const slips = run ? (await pool.query("SELECT p.*, e.matricule, e.nom, e.cin FROM payslip p JOIN employee e ON e.id=p.employee_id WHERE p.run_id=$1 ORDER BY e.matricule", [run.id])).rows : [];
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const head = ["NumAffiliation", "MatriculeCNSS", "CIN", "NomPrenom", "JoursDeclares", "SalaireReel", "SalairePlafonne"];
  const lines = [head.map(esc).join(";")];
  for (const s of slips) { const brut = Number(s.brut); lines.push([co.cnss || "", "", s.cin || "", s.nom, "26", brut.toFixed(2), Math.min(brut, 6000).toFixed(2)].map(esc).join(";")); }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="preparation-cnss-${annee}-${String(mois).padStart(2, "0")}.csv"`);
  res.end("\ufeff" + lines.join("\r\n"));
}));
// Données de facture structurées (préparation e-facturation DGI) — par période
app.get("/api/integrations/efacture", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  const annee = Number(req.query.annee) || new Date().getFullYear();
  const mois = Number(req.query.mois) || (new Date().getMonth() + 1);
  const co = await getCompany(company);
  const facts = (await pool.query(
    `SELECT * FROM facture WHERE company_id=$1 AND EXTRACT(YEAR FROM date_emission)=$2 AND EXTRACT(MONTH FROM date_emission)=$3 ORDER BY date_emission`,
    [company, annee, mois])).rows;
  const out = {
    avertissement: "Préparation e-facturation — données structurées non transmises. La télétransmission à la DGI nécessite un agrément officiel.",
    emetteur: { raison_sociale: co.raison_sociale, ice: co.ice, identifiant_fiscal: co.if_fiscal, rc: co.rc, patente: co.patente, adresse: co.adresse, ville: co.ville },
    periode: `${annee}-${String(mois).padStart(2, "0")}`, nombre: facts.length,
    factures: facts.map((f) => ({
      numero: f.numero, date: f.date_emission, type: f.type,
      client: { nom: f.client, ice: f.client_ice || null },
      montant_ht: Number(f.montant_ht), tva: { taux: 20, montant: Number(f.tva) }, montant_ttc: Number(f.montant_ttc),
    })),
  };
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="preparation-efacture-${annee}-${String(mois).padStart(2, "0")}.json"`);
  res.end(JSON.stringify(out, null, 2));
}));

// ══════════════ SUPER ADMIN (gestion SaaS) ══════════════
function requireSuper(req, res) {
  if (req.user.role !== "DIRECTEUR" || req.user.company_id) { res.status(403).json({ error: "Réservé au super-administrateur" }); return false; }
  return true;
}
app.get("/api/admin/overview", requireAuth, wrap(async (req, res) => {
  if (!requireSuper(req, res)) return;
  const rows = (await pool.query(
    `SELECT c.id, c.raison_sociale, c.ice, c.ville, c.plan, c.abonnement_fin, c.actif,
            (SELECT count(*)::int FROM app_user u WHERE u.company_id=c.id) AS nb_users
     FROM company c ORDER BY c.id`)).rows;
  res.json(rows.map((c) => ({ ...c, expire: !subActive(c) })));
}));
app.post("/api/admin/companies/:id/abonnement", requireAuth, wrap(async (req, res) => {
  if (!requireSuper(req, res)) return;
  const { plan } = req.body || {};
  if (!(plan in PLAN_DUREE)) return res.status(400).json({ error: "Plan invalide (30j, 1an ou avie)" });
  const fin = PLAN_DUREE[plan] === null ? null : new Date(Date.now() + PLAN_DUREE[plan] * 86400000);
  const co = (await pool.query("UPDATE company SET plan=$2, abonnement_fin=$3, actif=true WHERE id=$1 RETURNING id,raison_sociale,plan,abonnement_fin,actif", [req.params.id, plan, fin])).rows[0];
  if (!co) return res.status(404).json({ error: "Société introuvable" });
  subCache.delete(Number(req.params.id));
  res.json(co);
}));
app.post("/api/admin/companies/:id/etat", requireAuth, wrap(async (req, res) => {
  if (!requireSuper(req, res)) return;
  const co = (await pool.query("UPDATE company SET actif=$2 WHERE id=$1 RETURNING id,raison_sociale,actif", [req.params.id, !!(req.body || {}).actif])).rows[0];
  if (!co) return res.status(404).json({ error: "Société introuvable" });
  subCache.delete(Number(req.params.id));
  res.json(co);
}));
app.get("/api/admin/users", requireAuth, wrap(async (req, res) => {
  if (!requireSuper(req, res)) return;
  const where = req.query.company_id ? "WHERE company_id=$1" : "";
  const params = req.query.company_id ? [req.query.company_id] : [];
  res.json((await pool.query(`SELECT id,email,full_name,role,company_id,totp_enabled FROM app_user ${where} ORDER BY id`, params)).rows);
}));
app.post("/api/admin/users", requireAuth, wrap(async (req, res) => {
  if (!requireSuper(req, res)) return;
  const { email, password, full_name, role, company_id } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });
  const hash = await bcrypt.hash(password, 10);
  try {
    const u = (await pool.query("INSERT INTO app_user (email,password_hash,full_name,role,company_id) VALUES ($1,$2,$3,$4,$5) RETURNING id,email,full_name,role,company_id",
      [String(email).toLowerCase(), hash, full_name || null, role || "DIRECTEUR", company_id || null])).rows[0];
    res.status(201).json(u);
  } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "Email déjà utilisé" }); throw e; }
}));
app.post("/api/admin/users/:id/password", requireAuth, wrap(async (req, res) => {
  if (!requireSuper(req, res)) return;
  const { password } = req.body || {};
  if (!password || String(password).length < 4) return res.status(400).json({ error: "Mot de passe trop court (4 caractères min.)" });
  const hash = await bcrypt.hash(String(password), 10);
  const u = (await pool.query("UPDATE app_user SET password_hash=$2 WHERE id=$1 RETURNING id,email", [req.params.id, hash])).rows[0];
  if (!u) return res.status(404).json({ error: "Utilisateur introuvable" });
  res.json({ ok: true, email: u.email });
}));
app.delete("/api/admin/users/:id", requireAuth, wrap(async (req, res) => {
  if (!requireSuper(req, res)) return;
  if (Number(req.params.id) === req.user.sub) return res.status(400).json({ error: "Impossible de supprimer votre propre compte" });
  await pool.query("DELETE FROM app_user WHERE id=$1", [req.params.id]); res.json({ ok: true });
}));
// Suppression complète d'un client (société + utilisateurs + toutes ses données)
app.delete("/api/admin/companies/:id", requireAuth, wrap(async (req, res) => {
  if (!requireSuper(req, res)) return;
  const id = Number(req.params.id);
  const total = Number((await pool.query("SELECT count(*)::int c FROM company")).rows[0].c);
  if (total <= 1) return res.status(400).json({ error: "Impossible de supprimer la dernière société." });
  const order = [
    "DELETE FROM paiement WHERE company_id=$1", "DELETE FROM facture WHERE company_id=$1", "DELETE FROM devis WHERE company_id=$1",
    "DELETE FROM payroll_run WHERE company_id=$1", "DELETE FROM bon_commande WHERE company_id=$1", "DELETE FROM demande_achat WHERE company_id=$1",
    "DELETE FROM pointage WHERE company_id=$1", "DELETE FROM tache WHERE company_id=$1", "DELETE FROM materiel WHERE company_id=$1",
    "DELETE FROM rapport_chantier WHERE company_id=$1", "DELETE FROM bordereau WHERE company_id=$1", "DELETE FROM document WHERE company_id=$1",
    "DELETE FROM controle_securite WHERE company_id=$1", "DELETE FROM incident WHERE company_id=$1", "DELETE FROM epi WHERE company_id=$1",
    "DELETE FROM evaluation WHERE company_id=$1", "DELETE FROM conge WHERE company_id=$1", "DELETE FROM sous_traitant WHERE company_id=$1",
    "DELETE FROM fournisseur WHERE company_id=$1", "DELETE FROM ouvrage WHERE company_id=$1", "DELETE FROM article WHERE company_id=$1",
    "DELETE FROM chantier WHERE company_id=$1", "DELETE FROM employee WHERE company_id=$1", "DELETE FROM activite WHERE company_id=$1",
    "DELETE FROM app_user WHERE company_id=$1",
  ];
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    for (const sql of order) {
      await conn.query("SAVEPOINT sp");
      try { await conn.query(sql, [id]); await conn.query("RELEASE SAVEPOINT sp"); }
      catch { await conn.query("ROLLBACK TO SAVEPOINT sp"); await conn.query("RELEASE SAVEPOINT sp"); }
    }
    const del = await conn.query("DELETE FROM company WHERE id=$1 RETURNING id", [id]);
    if (!del.rowCount) { await conn.query("ROLLBACK"); return res.status(404).json({ error: "Société introuvable" }); }
    await conn.query("COMMIT");
    subCache.delete(id); DEFAULT_COMPANY_ID = null;
    res.json({ ok: true });
  } catch (e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
}));

// ══════════════ BORDEREAU — module de saisie (chapitres + lignes) ══════════════
function bordTotaux(contenu) {
  let ht = 0;
  for (const ch of contenu || []) for (const l of (ch.lignes || [])) ht += (Number(l.quantite) || 0) * (Number(l.pu) || 0);
  ht = +ht.toFixed(2); const tva = +(ht * 0.2).toFixed(2); return { ht, tva, ttc: +(ht + tva).toFixed(2) };
}
async function bordNumero(company) {
  const y = new Date().getFullYear();
  const n = Number((await pool.query("SELECT count(*)::int c FROM bordereau WHERE company_id=$1 AND EXTRACT(YEAR FROM created_at)=$2", [company, y])).rows[0].c) + 1;
  return `BORD-${y}-${String(n).padStart(4, "0")}`;
}
app.get("/api/bordereaux", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  res.json((await pool.query("SELECT id,numero,marche,objet,client,total_ttc,created_at FROM bordereau WHERE company_id=$1 ORDER BY id DESC", [company])).rows);
}));
app.get("/api/bordereaux/:id", requireAuth, wrap(async (req, res) => {
  const b = (await pool.query("SELECT * FROM bordereau WHERE id=$1", [req.params.id])).rows[0];
  if (!b) return res.status(404).json({ error: "Introuvable" });
  res.json(b);
}));
app.post("/api/bordereaux", requireAuth, wrap(async (req, res) => {
  const company = await cid(req);
  const { marche, maitre_ouvrage, objet, client, client_ice, contenu = [] } = req.body || {};
  const t = bordTotaux(contenu);
  const numero = req.body.numero || await bordNumero(company);
  const b = (await pool.query(
    `INSERT INTO bordereau (numero,marche,maitre_ouvrage,objet,client,client_ice,contenu,total_ht,tva,total_ttc,company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [numero, marche || null, maitre_ouvrage || null, objet || null, client || null, client_ice || null, JSON.stringify(contenu), t.ht, t.tva, t.ttc, company])).rows[0];
  res.status(201).json(b);
}));
app.put("/api/bordereaux/:id", requireAuth, wrap(async (req, res) => {
  const { marche, maitre_ouvrage, objet, client, client_ice, contenu = [] } = req.body || {};
  const t = bordTotaux(contenu);
  const b = (await pool.query(
    `UPDATE bordereau SET marche=$2,maitre_ouvrage=$3,objet=$4,client=$5,client_ice=$6,contenu=$7,total_ht=$8,tva=$9,total_ttc=$10 WHERE id=$1 RETURNING *`,
    [req.params.id, marche || null, maitre_ouvrage || null, objet || null, client || null, client_ice || null, JSON.stringify(contenu), t.ht, t.tva, t.ttc])).rows[0];
  if (!b) return res.status(404).json({ error: "Introuvable" });
  res.json(b);
}));
app.delete("/api/bordereaux/:id", requireAuth, wrap(async (req, res) => { await pool.query("DELETE FROM bordereau WHERE id=$1", [req.params.id]); res.json({ ok: true }); }));

app.get("/api/bordereaux/:id/excel", requireAuth, wrap(async (req, res) => {
  const b = (await pool.query("SELECT * FROM bordereau WHERE id=$1", [req.params.id])).rows[0];
  if (!b) return res.status(404).json({ error: "Introuvable" });
  const co = await getCompany(b.company_id || (await cid(req)));
  const contenu = Array.isArray(b.contenu) ? b.contenu : JSON.parse(b.contenu || "[]");
  const wb = new ExcelJS.Workbook(); wb.creator = "BTPPro";
  const ws = wb.addWorksheet("Bordereau des prix", { views: [{ state: "frozen", ySplit: 5, showGridLines: false }], pageSetup: { fitToWidth: 1, orientation: "portrait", margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } } });
  ws.columns = [{ width: 10 }, { width: 58 }, { width: 8 }, { width: 12 }, { width: 16 }, { width: 18 }];
  const thin = { style: "thin", color: { argb: "FFBFBFBF" } }; const border = { top: thin, left: thin, bottom: thin, right: thin };
  ws.mergeCells("A1:F1"); const t = ws.getCell("A1"); t.value = co.raison_sociale || "Société"; t.font = { bold: true, size: 14 }; t.alignment = { horizontal: "center" };
  ws.mergeCells("A2:F2"); const s = ws.getCell("A2"); s.value = "BORDEREAU DES PRIX — DÉTAIL ESTIMATIF" + (b.numero ? "  (" + b.numero + ")" : ""); s.font = { bold: true, size: 12, color: { argb: "FF1A1300" } }; s.alignment = { horizontal: "center" }; s.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5B301" } };
  ws.mergeCells("A3:F3"); ws.getCell("A3").value = `Marché n° : ${b.marche || "—"}     Maître d'ouvrage : ${b.maitre_ouvrage || "—"}     Objet : ${b.objet || "—"}`; ws.getRow(3).height = 18;
  ws.getRow(4).height = 6;
  const head = ["N° Prix", "Désignation des prestations", "U", "Quantité", "P.U. HT", "Prix total HT"];
  const hr = ws.getRow(5); head.forEach((h, i) => { const c = hr.getCell(i + 1); c.value = h; c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF15171C" } }; c.alignment = { horizontal: i === 1 ? "left" : "center", vertical: "middle", wrapText: true }; c.border = border; }); hr.height = 26;
  let r = 6; const subRows = [];
  const roman = (n) => ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"][n - 1] || String(n);
  contenu.forEach((ch, ci) => {
    ws.mergeCells(`A${r}:F${r}`); const sc = ws.getCell(`A${r}`); sc.value = `CHAPITRE ${roman(ci + 1)} — ${ch.titre || ""}`; sc.font = { bold: true }; sc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEFF2" } }; for (let k = 1; k <= 6; k++) ws.getRow(r).getCell(k).border = border; r++;
    const cStart = r;
    for (const l of (ch.lignes || [])) {
      const row = ws.getRow(r);
      row.getCell(1).value = l.num || ""; row.getCell(1).alignment = { horizontal: "center" };
      row.getCell(2).value = l.designation || ""; row.getCell(2).alignment = { wrapText: true };
      row.getCell(3).value = l.unite || ""; row.getCell(3).alignment = { horizontal: "center" };
      row.getCell(4).value = l.quantite != null && l.quantite !== "" ? Number(l.quantite) : null; row.getCell(4).numFmt = "#,##0.00"; row.getCell(4).alignment = { horizontal: "center" };
      row.getCell(5).value = l.pu != null && l.pu !== "" ? Number(l.pu) : null; row.getCell(5).numFmt = "#,##0.00";
      row.getCell(6).value = { formula: `IF(OR(D${r}="",E${r}=""),"",D${r}*E${r})` }; row.getCell(6).numFmt = "#,##0.00";
      for (let c = 1; c <= 6; c++) row.getCell(c).border = border; r++;
    }
    if (r === cStart) { for (let c = 1; c <= 6; c++) ws.getRow(r).getCell(c).border = border; r++; }
    ws.mergeCells(`A${r}:E${r}`); const sl = ws.getCell(`A${r}`); sl.value = `Sous-total Chapitre ${roman(ci + 1)}`; sl.alignment = { horizontal: "right" }; sl.font = { bold: true, italic: true }; sl.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F3E3" } };
    const sv = ws.getCell(`F${r}`); sv.value = { formula: `SUM(F${cStart}:F${r - 1})` }; sv.numFmt = "#,##0.00"; sv.font = { bold: true }; sv.fill = sl.fill; for (let c = 1; c <= 6; c++) ws.getRow(r).getCell(c).border = border; subRows.push(r); r++;
  });
  r++;
  const totalRow = (label, formula, strong) => { ws.mergeCells(`A${r}:E${r}`); const l = ws.getCell(`A${r}`); l.value = label; l.alignment = { horizontal: "right" }; l.font = { bold: !!strong, size: strong ? 12 : 11 }; const v = ws.getCell(`F${r}`); v.value = { formula }; v.numFmt = "#,##0.00"; v.font = { bold: !!strong, size: strong ? 12 : 11 }; if (strong) { l.fill = v.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5B301" } }; } for (let c = 1; c <= 6; c++) ws.getRow(r).getCell(c).border = border; r++; };
  const htRow = r; totalRow("TOTAL GÉNÉRAL HORS T.V.A.", subRows.length ? subRows.map((rr) => `F${rr}`).join("+") : "0");
  const tvaRow = r; totalRow("T.V.A. 20 %", `F${htRow}*0.2`);
  totalRow("TOTAL GÉNÉRAL T.T.C.", `F${htRow}+F${tvaRow}`, true);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="bordereau-${b.numero || b.id}.xlsx"`);
  await wb.xlsx.write(res); res.end();
}));

app.get("/api/bordereaux/:id/pdf", requireAuth, wrap(async (req, res) => {
  const b = (await pool.query("SELECT * FROM bordereau WHERE id=$1", [req.params.id])).rows[0];
  if (!b) return res.status(404).json({ error: "Introuvable" });
  const co = await getCompany(b.company_id || (await cid(req)));
  const contenu = Array.isArray(b.contenu) ? b.contenu : JSON.parse(b.contenu || "[]");
  const roman = (n) => ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"][n - 1] || String(n);
  const doc = newDoc(res, `bordereau-${b.numero || b.id}.pdf`);
  let y = docLetterhead(doc, co, "BORDEREAU DES PRIX", b.numero || b.id, new Date(b.created_at).toLocaleDateString("fr-FR"));
  y = clientBlock(doc, y + 6, b.client || "—", b.objet ? "Objet : " + b.objet : null, b.client_ice, "MAÎTRE D'OUVRAGE");
  if (b.marche) { doc.font("Helvetica").fontSize(9).fillColor("#5A6473").text("Marché n° : " + b.marche, 40, y); y += 14; }
  const cols = [[40, 34], [74, 250], [324, 34], [358, 52], [410, 70], [480, 75]];
  const header = () => {
    doc.rect(40, y, 515, 18).fill("#15171C");
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#FFFFFF");
    ["N°", "Désignation", "U", "Qté", "P.U. HT", "Total HT"].forEach((h, i) => doc.text(h, cols[i][0] + 2, y + 5, { width: cols[i][1] - 4, align: i >= 3 ? "right" : "left" }));
    y += 18;
  };
  header();
  let grand = 0;
  doc.fillColor("#15171C");
  contenu.forEach((ch, ci) => {
    if (y > 720) { doc.addPage(); y = 50; header(); }
    doc.rect(40, y, 515, 16).fill("#EDEFF2"); doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#15171C").text(`CHAPITRE ${roman(ci + 1)} — ${ch.titre || ""}`, 44, y + 4, { width: 505 }); y += 16;
    let sous = 0;
    for (const l of (ch.lignes || [])) {
      const tot = (Number(l.quantite) || 0) * (Number(l.pu) || 0); sous += tot;
      const dh = Math.max(14, Math.ceil(doc.heightOfString(l.designation || "", { width: cols[1][1] - 4, fontSize: 8 }) ) + 4);
      if (y + dh > 760) { doc.addPage(); y = 50; header(); }
      doc.font("Helvetica").fontSize(8).fillColor("#15171C");
      doc.text(l.num || "", cols[0][0] + 2, y + 3, { width: cols[0][1] - 4 });
      doc.text(l.designation || "", cols[1][0] + 2, y + 3, { width: cols[1][1] - 4 });
      doc.text(l.unite || "", cols[2][0] + 2, y + 3, { width: cols[2][1] - 4, align: "center" });
      doc.text(l.quantite != null ? String(l.quantite) : "", cols[3][0] + 2, y + 3, { width: cols[3][1] - 4, align: "right" });
      doc.text(l.pu != null ? moneyFR(Number(l.pu)).replace(" MAD", "") : "", cols[4][0] + 2, y + 3, { width: cols[4][1] - 4, align: "right" });
      doc.text(tot ? moneyFR(tot).replace(" MAD", "") : "", cols[5][0] + 2, y + 3, { width: cols[5][1] - 4, align: "right" });
      doc.moveTo(40, y + dh).lineTo(555, y + dh).strokeColor("#E5E8EC").stroke();
      y += dh;
    }
    grand += sous;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#15171C").text(`Sous-total Chapitre ${roman(ci + 1)} : ${moneyFR(sous)}`, 40, y + 3, { width: 515, align: "right" }); y += 18;
  });
  const tva = grand * 0.2;
  y += 6;
  const tline = (label, val, strong) => { if (strong) { doc.rect(330, y - 2, 225, 18).fill("#F5B301"); doc.fillColor("#15171C"); } doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 10 : 9).fillColor("#15171C").text(label + " : " + moneyFR(val), 335, y + 2, { width: 215, align: "right" }); y += 18; };
  tline("TOTAL HORS T.V.A.", grand);
  tline("T.V.A. 20 %", tva);
  tline("TOTAL T.T.C.", grand + tva, true);
  docFooter(doc, co, "Bordereau des prix / détail estimatif.");
  doc.end();
}));

// ══════════════ BORDEREAU DES PRIX (modèle vierge, Excel) ══════════════
app.get("/api/bordereau/template", requireAuth, wrap(async (req, res) => {
  const co = await getCompany(await cid(req));
  const wb = new ExcelJS.Workbook(); wb.creator = "BTPPro";
  const ws = wb.addWorksheet("Bordereau des prix", { views: [{ state: "frozen", ySplit: 5, showGridLines: false }], pageSetup: { fitToWidth: 1, orientation: "portrait", margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } } });
  ws.columns = [{ width: 10 }, { width: 58 }, { width: 8 }, { width: 12 }, { width: 16 }, { width: 18 }];
  const thin = { style: "thin", color: { argb: "FFBFBFBF" } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  ws.mergeCells("A1:F1"); const t = ws.getCell("A1"); t.value = co.raison_sociale || "Société"; t.font = { bold: true, size: 14 }; t.alignment = { horizontal: "center" };
  ws.mergeCells("A2:F2"); const s = ws.getCell("A2"); s.value = "BORDEREAU DES PRIX — DÉTAIL ESTIMATIF"; s.font = { bold: true, size: 12, color: { argb: "FF1A1300" } }; s.alignment = { horizontal: "center" }; s.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5B301" } };
  ws.mergeCells("A3:F3"); ws.getCell("A3").value = "Marché n° : ____________          Maître d'ouvrage : ____________________          Objet : ____________________________"; ws.getRow(3).height = 18;
  ws.getRow(4).height = 6;
  const head = ["N° Prix", "Désignation des prestations", "U", "Quantité", "P.U. HT", "Prix total HT"];
  const hr = ws.getRow(5);
  head.forEach((h, i) => { const c = hr.getCell(i + 1); c.value = h; c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF15171C" } }; c.alignment = { horizontal: i === 1 ? "left" : "center", vertical: "middle", wrapText: true }; c.border = border; });
  hr.height = 26;
  let r = 6;
  const nbChap = Math.min(Math.max(parseInt(req.query.chapitres, 10) || 2, 1), 20);
  const nbLignes = Math.min(Math.max(parseInt(req.query.lignes, 10) || 14, 1), 50);
  const roman = (n) => ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"][n - 1] || String(n);
  const sectionRow = (label) => { ws.mergeCells(`A${r}:F${r}`); const c = ws.getCell(`A${r}`); c.value = label; c.font = { bold: true }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEFF2" } }; for (let k = 1; k <= 6; k++) ws.getRow(r).getCell(k).border = border; r++; };
  const emptyRows = (n) => { for (let k = 0; k < n; k++) { const row = ws.getRow(r); row.getCell(1).alignment = { horizontal: "center" }; row.getCell(3).alignment = { horizontal: "center" }; row.getCell(4).alignment = { horizontal: "center" }; row.getCell(4).numFmt = "#,##0.00"; row.getCell(5).numFmt = "#,##0.00"; row.getCell(6).numFmt = "#,##0.00"; row.getCell(6).value = { formula: `IF(OR(D${r}="",E${r}=""),"",D${r}*E${r})` }; row.getCell(2).alignment = { wrapText: true }; for (let c = 1; c <= 6; c++) row.getCell(c).border = border; r++; } };
  const subRows = [];
  const subtotalRow = (label, formula) => { ws.mergeCells(`A${r}:E${r}`); const l = ws.getCell(`A${r}`); l.value = label; l.alignment = { horizontal: "right" }; l.font = { bold: true, italic: true }; l.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F3E3" } }; const v = ws.getCell(`F${r}`); v.value = { formula }; v.numFmt = "#,##0.00"; v.font = { bold: true }; v.fill = l.fill; for (let c = 1; c <= 6; c++) ws.getRow(r).getCell(c).border = border; subRows.push(r); r++; };
  for (let i = 1; i <= nbChap; i++) {
    sectionRow(`CHAPITRE ${roman(i)} — (à renommer)`);
    const cStart = r; emptyRows(nbLignes); const cEnd = r - 1;
    subtotalRow(`Sous-total Chapitre ${roman(i)}`, `SUM(F${cStart}:F${cEnd})`);
  }
  r++;
  const totalRow = (label, formula, strong) => { ws.mergeCells(`A${r}:E${r}`); const l = ws.getCell(`A${r}`); l.value = label; l.alignment = { horizontal: "right" }; l.font = { bold: !!strong, size: strong ? 12 : 11 }; const v = ws.getCell(`F${r}`); v.value = { formula }; v.numFmt = "#,##0.00"; v.font = { bold: !!strong, size: strong ? 12 : 11 }; if (strong) { l.fill = v.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5B301" } }; } for (let c = 1; c <= 6; c++) ws.getRow(r).getCell(c).border = border; r++; };
  const htRow = r; totalRow("TOTAL GÉNÉRAL HORS T.V.A.", subRows.map((rr) => `F${rr}`).join("+"));
  const tvaRow = r; totalRow("T.V.A. 20 %", `F${htRow}*0.2`);
  totalRow("TOTAL GÉNÉRAL T.T.C.", `F${htRow}+F${tvaRow}`, true);
  r++;
  ws.mergeCells(`A${r}:F${r}`); const m = ws.getCell(`A${r}`); m.value = "Arrêté le présent bordereau à la somme T.T.C. de (en toutes lettres) : ............................................................................................................"; m.font = { italic: true }; m.alignment = { wrapText: true }; ws.getRow(r).height = 28;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="bordereau-prix-vierge.xlsx"`);
  await wb.xlsx.write(res); res.end();
}));

// ══════════════ EXPORT EXCEL (générique) ══════════════
app.post("/api/export/xlsx", requireAuth, wrap(async (req, res) => {
  const { title = "Export", headers = [], rows = [] } = req.body || {};
  const wb = new ExcelJS.Workbook();
  wb.creator = "BTPPro"; wb.created = new Date();
  const ws = wb.addWorksheet((title || "Export").replace(/[\\\/\?\*\[\]:]/g, " ").slice(0, 30) || "Export");
  ws.addRow(headers);
  const hr = ws.getRow(1);
  hr.font = { bold: true, color: { argb: "FF1A1300" } };
  hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5B301" } };
  hr.alignment = { vertical: "middle" }; hr.height = 20;
  const isNum = (s) => { const t = String(s).replace(/\s/g, "").replace(/(MAD|%)/g, "").replace(",", "."); return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null; };
  for (const r of rows) {
    ws.addRow((r || []).map((c) => { const n = isNum(c); return n !== null ? n : (c == null ? "" : String(c)); }));
  }
  (ws.columns || []).forEach((col, i) => {
    let max = String(headers[i] || "").length;
    rows.forEach((r) => { const v = r && r[i] != null ? String(r[i]) : ""; if (v.length > max) max = v.length; });
    col.width = Math.min(46, Math.max(10, max + 2));
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  if (headers.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${(title || "export").replace(/[^\w-]+/g, "_")}.xlsx"`);
  await wb.xlsx.write(res); res.end();
}));

// ── SPA fallback ──
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`🚀 BTPPro sur le port ${PORT}`)))
  .catch((err) => { console.error("Échec init base:", err); process.exit(1); });
