const { pool } = require("./db");

let DEF = null;
async function defaultCompany() {
  if (DEF) return DEF;
  DEF = (await pool.query("SELECT id FROM company ORDER BY id LIMIT 1")).rows[0]?.id || null;
  return DEF;
}
const activeCompany = async (req) => req.companyId || (await defaultCompany());

/**
 * Fabrique CRUD. `table`/`columns` sont définis côté serveur (sûrs).
 * Si `company` est vrai, les listes sont filtrées par la société active
 * et les créations rattachées à cette société (multi-société).
 */
function makeCrud(table, columns, { orderBy = "id DESC", company = false } = {}) {
  const allow = (body) => columns.filter((c) => body && body[c] !== undefined && body[c] !== "");
  return {
    list: async (req, res) => {
      if (company) {
        const c = await activeCompany(req);
        const { rows } = await pool.query(`SELECT * FROM ${table} WHERE company_id = $1 ORDER BY ${orderBy}`, [c]);
        return res.json(rows);
      }
      const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
      res.json(rows);
    },
    get: async (req, res) => {
      const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: "Introuvable" });
      res.json(rows[0]);
    },
    create: async (req, res) => {
      const cols = allow(req.body);
      if (!cols.length) return res.status(400).json({ error: "Aucune donnée valide" });
      const vals = cols.map((c) => req.body[c]);
      if (company) { cols.push("company_id"); vals.push(await activeCompany(req)); }
      const ph = cols.map((_, i) => `$${i + 1}`);
      const { rows } = await pool.query(
        `INSERT INTO ${table} (${cols.join(",")}) VALUES (${ph.join(",")}) RETURNING *`, vals);
      res.status(201).json(rows[0]);
    },
    update: async (req, res) => {
      const cols = allow(req.body);
      if (!cols.length) return res.status(400).json({ error: "Aucune donnée valide" });
      const set = cols.map((c, i) => `${c} = $${i + 2}`);
      const { rows } = await pool.query(
        `UPDATE ${table} SET ${set.join(",")} WHERE id = $1 RETURNING *`,
        [req.params.id, ...cols.map((c) => req.body[c])]);
      if (!rows[0]) return res.status(404).json({ error: "Introuvable" });
      res.json(rows[0]);
    },
    remove: async (req, res) => {
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    },
  };
}

module.exports = { makeCrud, activeCompany, defaultCompany };
