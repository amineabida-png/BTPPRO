const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
if (!process.env.JWT_SECRET) console.warn("⚠️  JWT_SECRET non défini — à définir sur Railway.");

// ── RBAC : domaines accessibles par rôle ──
const PERMISSIONS = {
  DIRECTEUR:     ["*"],
  RH:            ["rh", "paie", "conges", "dashboard"],
  COMPTABLE:     ["devis", "facturation", "achats", "tiers", "stock", "dashboard", "rentabilite"],
  CHEF_CHANTIER: ["chantiers", "securite", "ged", "stock", "dashboard"],
  OUVRIER:       ["dashboard"],
};
const ROLES = Object.keys(PERMISSIONS);

function domainsForRole(role) {
  const p = PERMISSIONS[role] || [];
  return p.includes("*") ? ["*"] : p;
}
function roleHasDomain(role, domain) {
  if (!domain) return true; // route neutre (ex. /api/me)
  const p = PERMISSIONS[role] || [];
  return p.includes("*") || p.includes(domain);
}

function sign(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role, name: user.full_name }, SECRET, { expiresIn: "8h" });
}
function verify(token) { return jwt.verify(token, SECRET); }

function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non authentifié" });
  try { req.user = verify(token); next(); }
  catch { res.status(401).json({ error: "Session expirée ou invalide" }); }
}

module.exports = { sign, verify, requireAuth, roleHasDomain, domainsForRole, PERMISSIONS, ROLES };
