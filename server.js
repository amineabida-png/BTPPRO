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
  if (p.startsWith("/api/articles") || p.startsWith("/api/stock")) return "stock";
  if (p.startsWith("/api/commandes") || p.startsWith("/api/demandes-achat") || p.startsWith("/api/bons-commande")) return "achats";
  if (p.startsWith("/api/fournisseur") || p.startsWith("/api/sous-traitants") || p.startsWith("/api/soustraitants") || p.startsWith("/api/st-")) return "tiers";
  if (p.startsWith("/api/dashboard/rentabilite")) return "rentabilite";
  if (p.startsWith("/api/dashboard")) return "dashboard";
  return null;
}
app.use("/api", (req, res, next) => {
  const full = req.baseUrl + req.path; // req.path est relatif au montage "/api"
  if (PUBLIC.has(full)) return next();
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non authentifié" });
  try { req.user = verify(token); } catch { return res.status(401).json({ error: "Session expirée ou invalide" }); }
  req.companyId = Number(req.headers["x-company-id"]) || null; // société active (multi-société)
  const dom = domainOf(full);
  if (!roleHasDomain(req.user.role, dom)) return res.status(403).json({ error: "Accès refusé pour votre rôle (" + req.user.role + ")" });
  next();
});

// ── Société active (multi-société) ──
let DEFAULT_COMPANY_ID = null;
async function defaultCompany() {
  if (DEFAULT_COMPANY_ID) return DEFAULT_COMPANY_ID;
  DEFAULT_COMPANY_ID = (await pool.query("SELECT id FROM company ORDER BY id LIMIT 1")).rows[0]?.id || null;
  return DEFAULT_COMPANY_ID;
}
const cid = async (req) => req.companyId || (await defaultCompany());

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
  res.json({ token: sign(user), user: { id: user.id, email: user.email, name: user.full_name, role: user.role, totp_enabled: user.totp_enabled } });
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
app.get("/api/companies", requireAuth, wrap(async (_req, res) =>
  res.json((await pool.query("SELECT id,raison_sociale,ice FROM company ORDER BY id")).rows)));
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
  const cols = ["raison_sociale","ice","adresse","ville","telephone","email","rc","if_fiscal","patente","cnss","rib","logo","tva_taux"]
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
  const { nom, poste, salaire_base, mois_anciennete, personnes_charge } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE employee SET nom=COALESCE($2,nom), poste=COALESCE($3,poste),
       salaire_base=COALESCE($4,salaire_base), mois_anciennete=COALESCE($5,mois_anciennete),
       personnes_charge=COALESCE($6,personnes_charge) WHERE id=$1 RETURNING *`,
    [req.params.id, nom, poste, salaire_base, mois_anciennete, personnes_charge]);
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
function moneyFR(n) { return (Number(n) || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " MAD"; }
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
  fournisseurs:   ["fournisseur", ["raison_sociale","ice","contact","telephone","email"]],
  "sous-traitants": ["sous_traitant", ["raison_sociale","specialite","contact","telephone"]],
  "situations-st":  ["soustraitant_situation", ["sous_traitant_id","chantier_id","montant","statut","date_situation"]],
  conges:         ["conge", ["employee_id","type","date_debut","date_fin","jours","statut","motif"]],
  affectations:   ["affectation", ["chantier_id","employee_id","role","date_debut","date_fin"]],
  evaluations:    ["evaluation", ["employee_id","date_eval","note","evaluateur","commentaire"]],
};
const SCOPED_ROUTES = new Set(["chantiers", "factures", "incidents", "documents", "controles", "epi", "conges", "demandes-achat", "fournisseurs", "sous-traitants", "articles"]);
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
app.post("/api/devis/deep", requireAuth, wrap(async (req, res) => {
  const { numero, client: cli, chantier_id, objet, lignes = [] } = req.body || {};
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
    const d = (await conn.query(
      `INSERT INTO devis (numero,client,chantier_id,objet,total_debourse,total_marge,total_ht,tva,total_ttc,company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [numero || null, cli || null, chantier_id || null, objet || null, debourse.toFixed(2), marge, ht.toFixed(2), tva, ttc, await cid(req)])).rows[0];
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
  const num = `SIT-${devis_id}-${Date.now().toString().slice(-4)}`;
  const f = (await pool.query(
    `INSERT INTO facture (numero,client,chantier_id,devis_id,type,avancement,cumul_anterieur,
       montant_ht,tva,montant_ttc,rg_taux,retenue_garantie,net_a_payer,statut,company_id)
     VALUES ($1,$2,$3,$4,'situation',$5,$6,$7,$8,$9,$10,$11,$12,'emise',$13) RETURNING *`,
    [num, d.client, d.chantier_id, devis_id, avancement, cumul, montant_ht, tva, ttc, rg_taux, rg, net, await cid(req)])).rows[0];
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
  // Coordonnées société
  doc.fillColor("#15171C").font("Helvetica-Bold").fontSize(15).text(co.raison_sociale || "Société", infoX, 42, { width: 320 });
  doc.font("Helvetica").fontSize(8.5).fillColor("#5A6473");
  const lines = [co.adresse, co.ville, [co.telephone, co.email].filter(Boolean).join(" · ")].filter(Boolean);
  doc.text(lines.join("\n"), infoX, 62, { width: 320 });
  // Cartouche document (droite)
  doc.roundedRect(M + W - 168, 40, 168, 64, 6).fill("#15171C");
  doc.fill("#F5B301").font("Helvetica-Bold").fontSize(15).text(title, M + W - 158, 50, { width: 148, align: "right" });
  doc.fill("#fff").font("Helvetica").fontSize(9).text("N° " + (numero || "—"), M + W - 158, 72, { width: 148, align: "right" });
  doc.fillColor("#cbd5e1").fontSize(8.5).text(dateStr, M + W - 158, 86, { width: 148, align: "right" });
  // Bande hazard
  doc.rect(M, 116, W, 4).fill("#F5B301");
  return 132;
}
function clientBlock(doc, y, client, extra) {
  const M = 40;
  doc.roundedRect(M, y, 250, 56, 6).fillAndStroke("#f7f8fa", "#e3e7ec");
  doc.fill("#5A6473").font("Helvetica-Bold").fontSize(8).text("CLIENT", M + 12, y + 9);
  doc.fill("#15171C").font("Helvetica-Bold").fontSize(11).text(client || "—", M + 12, y + 22, { width: 226 });
  if (extra) { doc.font("Helvetica").fontSize(8.5).fillColor("#5A6473").text(extra, M + 12, y + 38, { width: 226 }); }
  return y + 72;
}
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
  y = clientBlock(doc, y + 6, d.client, d.objet);
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
  const isSit = f.type === "situation";
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${isSit ? "situation" : "facture"}-${f.numero || f.id}.pdf"`);
  doc.pipe(res);
  let y = docLetterhead(doc, co, isSit ? "SITUATION" : "FACTURE", f.numero || f.id, new Date(f.date_emission || Date.now()).toLocaleDateString("fr-FR"));
  y = clientBlock(doc, y + 6, f.client, isSit && f.avancement ? `Avancement cumulé : ${f.avancement} %` : null);
  const ht = Number(f.montant_ht), tva = Number(f.tva), ttc = Number(f.montant_ttc), rg = Number(f.retenue_garantie) || 0, net = Number(f.net_a_payer) || ttc;
  const M = 40, W = 515;
  doc.rect(M, y, W, 22).fill("#15171C");
  doc.fill("#fff").font("Helvetica-Bold").fontSize(9).text("DÉSIGNATION", M + 8, y + 7).text("MONTANT HT", M + W - 130, y + 7, { width: 122, align: "right" });
  y += 22;
  doc.font("Helvetica").fontSize(9).fillColor("#15171C");
  const desc = isSit ? `Travaux exécutés — situation à ${f.avancement || 0} % (déduction des situations antérieures)` : "Prestations / travaux";
  doc.text(desc, M + 8, y + 6, { width: 340 }).text(moneyFR(ht).replace(" MAD", ""), M + W - 130, y + 6, { width: 122, align: "right" });
  y += 30; doc.rect(M, y, W, 0.6).fill("#e3e7ec"); y += 14;
  const rows = [["Montant HT", ht], ["TVA (20%)", tva], ["Montant TTC", ttc, true]];
  if (rg > 0) { rows.push(["Retenue de garantie", -rg]); rows.push(["NET À PAYER", net, true]); }
  y = docTotals(doc, y, rows);
  docFooter(doc, co, isSit ? `Net à payer : ${moneyFR(net)}. Retenue de garantie ${f.rg_taux || 0} % conservée.` : `Montant à régler : ${moneyFR(net)}.`);
  doc.end();
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
