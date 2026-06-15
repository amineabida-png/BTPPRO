# BTPPro Maroc — ERP BTP (déployable)

Application **full-stack déployable** (Node + Express + PostgreSQL + frontend intégré) couvrant les 13 modules de la gestion d'une entreprise BTP marocaine, avec une paie conforme à la réglementation 2026. Testée de bout en bout contre une vraie base PostgreSQL.

## État réel des modules

Chaque module est **présent et fonctionnel** (table + API REST + écran + intégration), au niveau **MVP** — pas à la profondeur commerciale complète de chaque métier.

| # | Module | Niveau |
|---|---|---|
| 4 | **Paie marocaine** | Complet — moteur 2026 vérifié, génération + persistance + historique |
| 5 | **RH / Salariés** | **Approfondi** — fiche salarié, contrats avec historique (le contrat actif pilote la paie), organigramme, affectations, évaluations |
| 6 | **Congés** | **Approfondi** — acquisition 1,5 j/mois, soldes par salarié, validation |
| 1 | **Chantiers** | **Approfondi** — budget réel vs prévu (main d'œuvre + matériaux + sous-traitance + divers), % consommé |
| 7 | **Sécurité chantier** | **Approfondi** — registre incidents (arrêt/mesures/blessé), contrôles de conformité, EPI par salarié, indicateurs TF/TG |
| 8 | **Documents (GED)** | **Approfondi** — versioning avec historique, circuit de signature, catégories (pas d'OCR) |
| 2 | **Devis** | **Approfondi** — bibliothèque d'ouvrages, sous-détails de prix (déboursé sec), coefficient de marge → prix de vente |
| 3 | **Facturation** | **Approfondi** — situations de travaux (avancement %), cumuls, retenue de garantie, net à payer |
| 9 | **Stocks** | **Approfondi** — valorisation CMUP, mouvements valorisés, inventaire, valeur totale |
| 10 | **Achats** | **Approfondi** — bons de commande avec lignes, réception → entrée stock + CMUP recalculé |
| 11 | **Fournisseurs** | **Approfondi** — conditions, historique commandes + statistiques, évaluations (qualité/délai/prix) |
| 12 | **Sous-traitants** | **Approfondi** — contrats de marché, situations de paiement (avancement + retenue de garantie + cumul), évaluations |
| 13 | **Tableau de bord** | **Approfondi** — rentabilité par chantier (CA − coût réel), marge devis, masse salariale, valeur stock, graphiques |
| — | **Intégrations** (DAMANCOM, SIMPL-IR, Maps, Twilio, WhatsApp, banque) | **Cadrées mais non connectées** — nécessitent specs + identifiants officiels |

> Honnêteté : « MVP fonctionnel » ≠ « prêt pour la commercialisation ». C'est une base réelle, déployable, à approfondir module par module.

## Stack

Node 20 · Express · PostgreSQL (`pg`) · JWT · bcrypt · frontend HTML/CSS/JS **sans étape de build**.

---

## Déploiement Railway (≈ 5 min)

### 1. Pousser sur GitHub
```bash
cd btppro
git init && git add . && git commit -m "BTPPro - version initiale"
git branch -M main
git remote add origin https://github.com/<TON_COMPTE>/btppro.git
git push -u origin main
```

### 2. Projet Railway
[railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → `btppro`.

### 3. Base de données
Projet → **New** → **Database** → **Add PostgreSQL**. La variable `DATABASE_URL` se branche automatiquement.

### 4. Variables (service web → **Variables**)
| Variable | Valeur |
|---|---|
| `JWT_SECRET` | une longue chaîne aléatoire |
| `ADMIN_EMAIL` | ton email admin |
| `ADMIN_PASSWORD` | ton mot de passe admin |

`PORT` et `DATABASE_URL` sont fournis par Railway.

### 5. Domaine
Service web → **Settings** → **Networking** → **Generate Domain**. Ouvre l'URL : la base se crée et se remplit au premier lancement.

**Connexion** : `admin@btppro.ma` / `btppro2026` (ou tes variables). À changer.

---

## En local
```bash
npm install
cp .env.example .env     # renseigne DATABASE_URL et JWT_SECRET
npm start                # http://localhost:3000
```

## Structure
```
btppro/
├── server.js            # API Express + routes de tous les modules
├── src/
│   ├── db.js            # schéma + seed (auto au démarrage)
│   ├── payroll.js       # moteur de paie 2026 vérifié
│   ├── crud.js          # fabrique CRUD générique
│   └── auth.js          # JWT
├── public/              # frontend (index.html, app.js, styles.css)
├── railway.json · Procfile · .env.example
```

## Avant une vraie mise en production
- Confirmer tous les paramètres légaux 2026 (CNSS, DGI, BO) — centralisés dans `src/payroll.js`.
- Approfondir chaque module métier ; ajouter RBAC fin, 2FA, multi-société (RLS), chiffrement des champs sensibles (voir le schéma durci `btppro_schema_V001.sql` livré à part).
- Connecter réellement DAMANCOM / SIMPL-IR (specs officielles) et générer les bulletins PDF.

## Avertissement
Outil d'aide. Montants indicatifs — faire valider par un expert-comptable avant émission officielle.
