/**
 * Moteur de paie — règles légales marocaines 2026 (vérifiées).
 * SMIG décret 2.25.983 · CNSS/AMO · barème IR LF 2025 · frais pro Art.59
 * prime ancienneté Art.350 · charges famille LF 2026.
 */
const SETTINGS = {
  annee: 2026,
  smigMensuel: 3422.72,
  heures: 191,
  cnssPlafond: 6000,
  prestationsSal: 0.0448,
  amoSal: 0.0226,
  prestationsEmp: 0.0898,
  allocationsEmp: 0.064,
  amoEmp: 0.0411,
  tfpEmp: 0.016,
  fpSeuil: 6500, // 78 000 / 12
  fpTauxBas: 0.35,
  fpCapBas: 2500,
  fpTauxHaut: 0.25,
  fpCapHaut: 2916.67,
  deductionParPersonne: 50,
  maxPersonnes: 6,
  baremeIR: [
    { plafond: 3333.33, taux: 0, deduction: 0 },
    { plafond: 5000, taux: 0.1, deduction: 333.33 },
    { plafond: 6666.67, taux: 0.2, deduction: 833.33 },
    { plafond: 8333.33, taux: 0.3, deduction: 1500 },
    { plafond: 15000, taux: 0.34, deduction: 1833.33 },
    { plafond: Infinity, taux: 0.37, deduction: 2283.33 },
  ],
  baremeAnciennete: [
    { min: 0, taux: 0 }, { min: 24, taux: 0.05 }, { min: 60, taux: 0.1 },
    { min: 144, taux: 0.15 }, { min: 240, taux: 0.2 }, { min: 300, taux: 0.25 },
  ],
};

const r2 = (n) => Math.round((n + 1e-9) * 100) / 100;

function tauxAnciennete(mois) {
  return SETTINGS.baremeAnciennete.reduce((t, p) => (mois >= p.min ? p.taux : t), 0);
}

function calculatePayroll({ salaireBase, moisAnciennete = 0, personnesCharge = 0 }) {
  const s = SETTINGS;
  const warnings = [];
  const base = r2(Number(salaireBase) || 0);
  if (base <= 0) throw new Error("salaireBase doit être positif");
  if (base < s.smigMensuel) warnings.push(`Salaire sous le SMIG 2026 (${s.smigMensuel} MAD).`);

  let pers = Math.max(0, Math.min(Number(personnesCharge) || 0, s.maxPersonnes));
  const ta = tauxAnciennete(Number(moisAnciennete) || 0);
  const prime = r2(base * ta);
  const brut = r2(base + prime);

  const cnssPrestations = r2(Math.min(brut, s.cnssPlafond) * s.prestationsSal);
  const amo = r2(brut * s.amoSal);
  const cnss = r2(cnssPrestations + amo);

  const fpBas = brut <= s.fpSeuil;
  const baseFP = r2(brut - cnss); // base de calcul des frais pro : brut imposable après cotisations sociales
  const fraisPro = r2(Math.min(baseFP * (fpBas ? s.fpTauxBas : s.fpTauxHaut), fpBas ? s.fpCapBas : s.fpCapHaut));
  const rni = r2(baseFP - fraisPro);

  let irBrut = 0, tranche = 0;
  for (const t of s.baremeIR) {
    if (rni <= t.plafond) { irBrut = Math.max(0, rni * t.taux - t.deduction); tranche = t.taux; break; }
  }
  const deductionsFamiliales = r2(pers * s.deductionParPersonne);
  const ir = r2(Math.max(0, irBrut - deductionsFamiliales));
  const net = r2(brut - cnss - ir);

  const emp = {
    prestations: r2(Math.min(brut, s.cnssPlafond) * s.prestationsEmp),
    allocations: r2(brut * s.allocationsEmp),
    amo: r2(brut * s.amoEmp),
    tfp: r2(brut * s.tfpEmp),
  };
  emp.total = r2(emp.prestations + emp.allocations + emp.amo + emp.tfp);

  return {
    salaireBase: base, tauxAnciennete: ta, primeAnciennete: prime, brutImposable: brut,
    cnssPrestations, amo, cnssTotal: cnss, fraisPro, fraisProTaux: fpBas ? 0.35 : 0.25,
    revenuNetImposable: rni, trancheIR: tranche, deductionsFamiliales, ir,
    netAPayer: net, cotisationsEmployeur: emp, coutTotal: r2(brut + emp.total),
    personnesCharge: pers, warnings,
  };
}

module.exports = { calculatePayroll, tauxAnciennete, SETTINGS };
