const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL non défini. Sur Railway, ajoute un service PostgreSQL.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS company (
  id serial PRIMARY KEY, raison_sociale text NOT NULL, ice text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS app_user (
  id serial PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL,
  full_name text, role text NOT NULL DEFAULT 'DIRECTEUR', created_at timestamptz DEFAULT now());

-- RH
CREATE TABLE IF NOT EXISTS employee (
  id serial PRIMARY KEY, matricule text UNIQUE NOT NULL, nom text NOT NULL, poste text,
  salaire_base numeric(10,2) NOT NULL CHECK (salaire_base > 0),
  mois_anciennete int NOT NULL DEFAULT 0, personnes_charge int NOT NULL DEFAULT 0,
  actif boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS contrat (
  id serial PRIMARY KEY, employee_id int REFERENCES employee(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'CDI', poste text, salaire_base numeric(10,2),
  date_debut date, date_fin date, actif boolean DEFAULT true);

-- Paie
CREATE TABLE IF NOT EXISTS payroll_run (
  id serial PRIMARY KEY, periode_mois int NOT NULL CHECK (periode_mois BETWEEN 1 AND 12),
  periode_annee int NOT NULL, statut text NOT NULL DEFAULT 'valide',
  total_brut numeric(14,2), total_net numeric(14,2), total_cout numeric(14,2),
  created_at timestamptz DEFAULT now(), UNIQUE (periode_annee, periode_mois));
CREATE TABLE IF NOT EXISTS payslip (
  id serial PRIMARY KEY, run_id int NOT NULL REFERENCES payroll_run(id) ON DELETE CASCADE,
  employee_id int NOT NULL REFERENCES employee(id), periode date NOT NULL,
  brut numeric(12,2), cnss numeric(10,2), ir numeric(10,2), net numeric(12,2),
  cout_total numeric(12,2), payload jsonb, created_at timestamptz DEFAULT now());

-- Chantiers
CREATE TABLE IF NOT EXISTS chantier (
  id serial PRIMARY KEY, code text UNIQUE NOT NULL, nom text NOT NULL, client text, ville text,
  latitude numeric(9,6), longitude numeric(9,6), statut text NOT NULL DEFAULT 'en_cours',
  budget_prevu numeric(14,2), date_debut date, date_fin_prevue date, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS chantier_expense (
  id serial PRIMARY KEY, chantier_id int REFERENCES chantier(id) ON DELETE CASCADE,
  categorie text, libelle text, montant numeric(14,2) NOT NULL DEFAULT 0, date_depense date DEFAULT now());
CREATE TABLE IF NOT EXISTS affectation (
  id serial PRIMARY KEY, chantier_id int REFERENCES chantier(id) ON DELETE CASCADE,
  employee_id int REFERENCES employee(id), role text, date_debut date, date_fin date);

-- Devis
CREATE TABLE IF NOT EXISTS devis (
  id serial PRIMARY KEY, numero text, client text, chantier_id int REFERENCES chantier(id),
  objet text, statut text NOT NULL DEFAULT 'brouillon',
  total_ht numeric(14,2) DEFAULT 0, tva numeric(14,2) DEFAULT 0, total_ttc numeric(14,2) DEFAULT 0,
  created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS devis_ligne (
  id serial PRIMARY KEY, devis_id int REFERENCES devis(id) ON DELETE CASCADE,
  designation text, quantite numeric(12,2) DEFAULT 1, prix_unitaire numeric(12,2) DEFAULT 0,
  total numeric(14,2) DEFAULT 0);

-- Facturation
CREATE TABLE IF NOT EXISTS facture (
  id serial PRIMARY KEY, numero text, client text, chantier_id int REFERENCES chantier(id),
  type text NOT NULL DEFAULT 'facture', montant_ht numeric(14,2) DEFAULT 0,
  tva numeric(14,2) DEFAULT 0, montant_ttc numeric(14,2) DEFAULT 0,
  statut text NOT NULL DEFAULT 'brouillon', date_emission date DEFAULT now());

-- Congés
CREATE TABLE IF NOT EXISTS conge (
  id serial PRIMARY KEY, employee_id int REFERENCES employee(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'annuel', date_debut date, date_fin date,
  jours numeric(5,1) DEFAULT 0, statut text NOT NULL DEFAULT 'demande', motif text);

-- Sécurité chantier
CREATE TABLE IF NOT EXISTS incident (
  id serial PRIMARY KEY, chantier_id int REFERENCES chantier(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'incident', gravite text DEFAULT 'faible', description text,
  date_incident date DEFAULT now(), statut text NOT NULL DEFAULT 'ouvert');

-- GED
CREATE TABLE IF NOT EXISTS document (
  id serial PRIMARY KEY, nom text NOT NULL, type text, chantier_id int REFERENCES chantier(id),
  url text, version int DEFAULT 1, created_at timestamptz DEFAULT now());

-- Stocks
CREATE TABLE IF NOT EXISTS article (
  id serial PRIMARY KEY, reference text UNIQUE NOT NULL, designation text NOT NULL,
  unite text DEFAULT 'u', stock numeric(12,2) DEFAULT 0, seuil numeric(12,2) DEFAULT 0,
  prix_unitaire numeric(12,2) DEFAULT 0);
CREATE TABLE IF NOT EXISTS mouvement_stock (
  id serial PRIMARY KEY, article_id int REFERENCES article(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'entree', quantite numeric(12,2) NOT NULL DEFAULT 0,
  date_mouvement date DEFAULT now(), motif text);

-- Achats
CREATE TABLE IF NOT EXISTS demande_achat (
  id serial PRIMARY KEY, objet text NOT NULL, chantier_id int REFERENCES chantier(id),
  statut text NOT NULL DEFAULT 'demande', created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS bon_commande (
  id serial PRIMARY KEY, numero text, fournisseur_id int, montant numeric(14,2) DEFAULT 0,
  statut text NOT NULL DEFAULT 'brouillon', date_commande date DEFAULT now());

-- Fournisseurs
CREATE TABLE IF NOT EXISTS fournisseur (
  id serial PRIMARY KEY, raison_sociale text NOT NULL, ice text, contact text,
  telephone text, email text);
CREATE TABLE IF NOT EXISTS client (
  id serial PRIMARY KEY, raison_sociale text NOT NULL, ice text, contact text,
  telephone text, email text, adresse text, ville text,
  company_id int REFERENCES company(id), created_at timestamptz DEFAULT now());

-- Sous-traitants
CREATE TABLE IF NOT EXISTS sous_traitant (
  id serial PRIMARY KEY, raison_sociale text NOT NULL, specialite text, contact text, telephone text);
CREATE TABLE IF NOT EXISTS soustraitant_situation (
  id serial PRIMARY KEY, sous_traitant_id int REFERENCES sous_traitant(id) ON DELETE CASCADE,
  chantier_id int REFERENCES chantier(id), montant numeric(14,2) DEFAULT 0,
  statut text DEFAULT 'en_attente', date_situation date DEFAULT now());

-- ===== PROFONDEUR MÉTIER =====

-- Bibliothèque d'ouvrages + sous-détails de prix (déboursé sec)
CREATE TABLE IF NOT EXISTS ouvrage (
  id serial PRIMARY KEY, code text UNIQUE NOT NULL, designation text NOT NULL,
  unite text DEFAULT 'u', created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS ouvrage_composant (
  id serial PRIMARY KEY, ouvrage_id int REFERENCES ouvrage(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'materiau',           -- main_oeuvre | materiau | materiel
  designation text NOT NULL, unite text DEFAULT 'u',
  quantite numeric(12,3) NOT NULL DEFAULT 0, prix_unitaire numeric(12,2) NOT NULL DEFAULT 0);

-- Devis : déboursé / marge / prix de vente
ALTER TABLE devis ADD COLUMN IF NOT EXISTS total_debourse numeric(14,2) DEFAULT 0;
ALTER TABLE devis ADD COLUMN IF NOT EXISTS total_marge numeric(14,2) DEFAULT 0;
ALTER TABLE devis_ligne ADD COLUMN IF NOT EXISTS ouvrage_id int REFERENCES ouvrage(id);
ALTER TABLE devis_ligne ADD COLUMN IF NOT EXISTS debourse_unitaire numeric(12,2) DEFAULT 0;
ALTER TABLE devis_ligne ADD COLUMN IF NOT EXISTS coef_marge numeric(6,3) DEFAULT 1.2;
ALTER TABLE devis_ligne ADD COLUMN IF NOT EXISTS prix_vente numeric(12,2) DEFAULT 0;

-- Facturation : situations de travaux + retenue de garantie
ALTER TABLE facture ADD COLUMN IF NOT EXISTS devis_id int REFERENCES devis(id);
ALTER TABLE facture ADD COLUMN IF NOT EXISTS avancement numeric(6,2) DEFAULT 0;       -- % cumulé
ALTER TABLE facture ADD COLUMN IF NOT EXISTS cumul_anterieur numeric(14,2) DEFAULT 0; -- HT déjà facturé
ALTER TABLE facture ADD COLUMN IF NOT EXISTS retenue_garantie numeric(14,2) DEFAULT 0;
ALTER TABLE facture ADD COLUMN IF NOT EXISTS rg_taux numeric(5,2) DEFAULT 0;
ALTER TABLE facture ADD COLUMN IF NOT EXISTS net_a_payer numeric(14,2) DEFAULT 0;
ALTER TABLE facture ADD COLUMN IF NOT EXISTS objet text;
ALTER TABLE facture ADD COLUMN IF NOT EXISTS tva_taux numeric(5,2) DEFAULT 20;
ALTER TABLE facture ADD COLUMN IF NOT EXISTS contenu jsonb;
ALTER TABLE facture ADD COLUMN IF NOT EXISTS delai_paiement int DEFAULT 60;

-- Stock : valorisation au coût moyen unitaire pondéré (CMUP)
ALTER TABLE article ADD COLUMN IF NOT EXISTS cmup numeric(12,2) DEFAULT 0;
ALTER TABLE mouvement_stock ADD COLUMN IF NOT EXISTS prix_unitaire numeric(12,2) DEFAULT 0;
ALTER TABLE mouvement_stock ADD COLUMN IF NOT EXISTS valeur numeric(14,2) DEFAULT 0;

-- Achats : commandes avec lignes + réception + attribution chantier
ALTER TABLE bon_commande ADD COLUMN IF NOT EXISTS chantier_id int REFERENCES chantier(id);
ALTER TABLE bon_commande ADD COLUMN IF NOT EXISTS date_reception date;
CREATE TABLE IF NOT EXISTS bon_commande_ligne (
  id serial PRIMARY KEY, commande_id int REFERENCES bon_commande(id) ON DELETE CASCADE,
  article_id int REFERENCES article(id), designation text,
  quantite numeric(12,2) NOT NULL DEFAULT 0, prix_unitaire numeric(12,2) NOT NULL DEFAULT 0,
  recu numeric(12,2) NOT NULL DEFAULT 0);

-- RH approfondi : organigramme, état civil, évaluations
ALTER TABLE employee ADD COLUMN IF NOT EXISTS manager_id int REFERENCES employee(id);
ALTER TABLE employee ADD COLUMN IF NOT EXISTS cin text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS cnss text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS date_embauche date;
CREATE TABLE IF NOT EXISTS evaluation (
  id serial PRIMARY KEY, employee_id int REFERENCES employee(id) ON DELETE CASCADE,
  date_eval date DEFAULT now(), note int CHECK (note BETWEEN 1 AND 5),
  evaluateur text, commentaire text, created_at timestamptz DEFAULT now());

-- Sécurité chantier approfondie
ALTER TABLE incident ADD COLUMN IF NOT EXISTS employee_id int REFERENCES employee(id);
ALTER TABLE incident ADD COLUMN IF NOT EXISTS jours_arret int DEFAULT 0;
ALTER TABLE incident ADD COLUMN IF NOT EXISTS mesures text;
CREATE TABLE IF NOT EXISTS controle_securite (
  id serial PRIMARY KEY, chantier_id int REFERENCES chantier(id) ON DELETE CASCADE,
  date_controle date DEFAULT now(), type text, conforme boolean DEFAULT true,
  observations text, controleur text);
CREATE TABLE IF NOT EXISTS epi (
  id serial PRIMARY KEY, employee_id int REFERENCES employee(id) ON DELETE CASCADE,
  designation text NOT NULL, type text, date_remise date DEFAULT now(),
  date_retour date, etat text DEFAULT 'en_service');

-- GED approfondie : versioning + circuit de signature
ALTER TABLE document ADD COLUMN IF NOT EXISTS categorie text;
ALTER TABLE document ADD COLUMN IF NOT EXISTS statut text DEFAULT 'actif';
CREATE TABLE IF NOT EXISTS document_version (
  id serial PRIMARY KEY, document_id int REFERENCES document(id) ON DELETE CASCADE,
  version int NOT NULL, url text, auteur text, note text, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS document_signature (
  id serial PRIMARY KEY, document_id int REFERENCES document(id) ON DELETE CASCADE,
  signataire text NOT NULL, statut text DEFAULT 'en_attente', date_signature timestamptz);

-- Tiers : fournisseurs (conditions + évaluations)
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS conditions_paiement text;
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS delai_livraison int;
CREATE TABLE IF NOT EXISTS fournisseur_evaluation (
  id serial PRIMARY KEY, fournisseur_id int REFERENCES fournisseur(id) ON DELETE CASCADE,
  date_eval date DEFAULT now(), note_qualite int CHECK (note_qualite BETWEEN 1 AND 5),
  note_delai int CHECK (note_delai BETWEEN 1 AND 5), note_prix int CHECK (note_prix BETWEEN 1 AND 5),
  commentaire text);

-- Tiers : sous-traitants (contrats de marché + situations + évaluations)
CREATE TABLE IF NOT EXISTS soustraitant_contrat (
  id serial PRIMARY KEY, sous_traitant_id int REFERENCES sous_traitant(id) ON DELETE CASCADE,
  chantier_id int REFERENCES chantier(id), objet text, montant_marche numeric(14,2) DEFAULT 0,
  rg_taux numeric(5,2) DEFAULT 10, date_debut date, date_fin date, statut text DEFAULT 'en_cours');
ALTER TABLE soustraitant_situation ADD COLUMN IF NOT EXISTS contrat_id int REFERENCES soustraitant_contrat(id);
ALTER TABLE soustraitant_situation ADD COLUMN IF NOT EXISTS avancement numeric(6,2) DEFAULT 0;
ALTER TABLE soustraitant_situation ADD COLUMN IF NOT EXISTS cumul_anterieur numeric(14,2) DEFAULT 0;
ALTER TABLE soustraitant_situation ADD COLUMN IF NOT EXISTS retenue_garantie numeric(14,2) DEFAULT 0;
ALTER TABLE soustraitant_situation ADD COLUMN IF NOT EXISTS net_a_payer numeric(14,2) DEFAULT 0;
CREATE TABLE IF NOT EXISTS soustraitant_evaluation (
  id serial PRIMARY KEY, sous_traitant_id int REFERENCES sous_traitant(id) ON DELETE CASCADE,
  date_eval date DEFAULT now(), note int CHECK (note BETWEEN 1 AND 5), commentaire text);

-- 2FA (TOTP)
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_enabled boolean DEFAULT false;

-- Multi-société : rattachement des données à une société
ALTER TABLE employee ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS type_travaux text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS adresse text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS quartier text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS titre_foncier text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS superficie_terrain numeric(12,2);
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS surface_batie numeric(12,2);
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS nb_niveaux int;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS mo_representant text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS mo_telephone text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS mo_email text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS architecte text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS architecte_ordre text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS bet text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS laboratoire text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS topographe text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS maitre_oeuvre text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS conducteur_travaux text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS chef_chantier text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS permis_numero text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS permis_date date;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS permis_autorite text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS permis_dossier text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS permis_habiter text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS montant_marche numeric(14,2);
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS tva_taux numeric(5,2);
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS rg_taux numeric(5,2);
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS avance_taux numeric(5,2);
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS mode_passation text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS date_os date;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS delai_execution text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS date_reception_provisoire date;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS date_reception_definitive date;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS assurance_rcd_compagnie text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS assurance_rcd_police text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS assurance_trc_compagnie text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS assurance_trc_police text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS cnss_chantier text;
ALTER TABLE chantier ADD COLUMN IF NOT EXISTS decl_ouverture text;
ALTER TABLE devis ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE facture ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE article ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE sous_traitant ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE payroll_run ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE conge ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE incident ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE controle_securite ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE document ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE demande_achat ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE bon_commande ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE ouvrage ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE epi ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE evaluation ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);

-- Unicité de la paie : par société + période (et non plus globale)
ALTER TABLE payroll_run DROP CONSTRAINT IF EXISTS payroll_run_periode_annee_periode_mois_key;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_company_periode ON payroll_run (company_id, periode_annee, periode_mois);

-- Pointage des heures (main d'œuvre par chantier)
CREATE TABLE IF NOT EXISTS pointage (
  id serial PRIMARY KEY,
  employee_id int REFERENCES employee(id),
  chantier_id int REFERENCES chantier(id),
  date_jour date NOT NULL DEFAULT current_date,
  heures numeric(5,2) NOT NULL DEFAULT 0,
  heures_sup numeric(5,2) NOT NULL DEFAULT 0,
  company_id int REFERENCES company(id),
  created_at timestamptz DEFAULT now());

-- Planning : tâches de chantier
CREATE TABLE IF NOT EXISTS tache (
  id serial PRIMARY KEY,
  chantier_id int REFERENCES chantier(id),
  libelle text NOT NULL,
  date_debut date, date_fin date,
  avancement int NOT NULL DEFAULT 0,
  responsable text, statut text NOT NULL DEFAULT 'a_faire',
  company_id int REFERENCES company(id),
  created_at timestamptz DEFAULT now());

-- Trésorerie : paiements (encaissements / décaissements)
CREATE TABLE IF NOT EXISTS paiement (
  id serial PRIMARY KEY,
  sens text NOT NULL DEFAULT 'encaissement',
  facture_id int REFERENCES facture(id),
  tiers text,
  montant numeric(14,2) NOT NULL DEFAULT 0,
  date_paiement date NOT NULL DEFAULT current_date,
  mode text DEFAULT 'virement',
  reference text,
  company_id int REFERENCES company(id),
  created_at timestamptz DEFAULT now());

-- Parc matériel & engins
CREATE TABLE IF NOT EXISTS materiel (
  id serial PRIMARY KEY,
  code text, designation text NOT NULL, type text DEFAULT 'engin',
  etat text NOT NULL DEFAULT 'disponible',
  valeur_acquisition numeric(14,2) DEFAULT 0, date_acquisition date,
  chantier_id int REFERENCES chantier(id),
  company_id int REFERENCES company(id), created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS materiel_maintenance (
  id serial PRIMARY KEY,
  materiel_id int REFERENCES materiel(id) ON DELETE CASCADE,
  date_maintenance date NOT NULL DEFAULT current_date,
  type text, cout numeric(12,2) DEFAULT 0, note text,
  company_id int REFERENCES company(id), created_at timestamptz DEFAULT now());

-- Rapports de chantier (avec photos)
CREATE TABLE IF NOT EXISTS rapport_chantier (
  id serial PRIMARY KEY,
  chantier_id int REFERENCES chantier(id),
  date_rapport date NOT NULL DEFAULT current_date,
  meteo text, effectif int DEFAULT 0, avancement text, observations text,
  company_id int REFERENCES company(id), created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS rapport_photo (
  id serial PRIMARY KEY,
  rapport_id int REFERENCES rapport_chantier(id) ON DELETE CASCADE,
  data text, legende text, created_at timestamptz DEFAULT now());

-- PV / compte rendu de réunion de chantier
CREATE TABLE IF NOT EXISTS pv_reunion (
  id serial PRIMARY KEY,
  chantier_id int REFERENCES chantier(id),
  numero text,
  date_reunion date NOT NULL DEFAULT current_date,
  heure text, lieu text, objet text,
  maitre_ouvrage text, maitre_oeuvre text, redacteur text,
  participants text, absents text, diffusion text,
  avancement text, securite text, divers text,
  prochaine_date date, prochaine_heure text, prochaine_lieu text,
  delai_contestation int DEFAULT 8, observations text,
  company_id int REFERENCES company(id), created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS pv_point (
  id serial PRIMARY KEY,
  pv_id int REFERENCES pv_reunion(id) ON DELETE CASCADE,
  ordre int, description text, responsable text, echeance date, statut text);

-- Fiche d'entrée ouvrier de chantier (journaliers / qualifiés, déclarés ou non CNSS)
CREATE TABLE IF NOT EXISTS ouvrier_chantier (
  id serial PRIMARY KEY,
  nom text NOT NULL, cin text, date_naissance date, lieu_naissance text, sexe text,
  adresse text, telephone text, photo text,
  metier text, niveau_qualif text, experience_annees int,
  salaire_journalier numeric(10,2), mode_paiement text DEFAULT 'Journalier',
  date_entree date DEFAULT current_date, date_sortie date, chantier_id int REFERENCES chantier(id),
  cnss_declare boolean DEFAULT false, num_cnss text,
  assurance_compagnie text, assurance_police text,
  contact_urgence_nom text, contact_urgence_tel text,
  statut text DEFAULT 'actif', observations text,
  company_id int REFERENCES company(id), created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS ouvrier_doc (
  id serial PRIMARY KEY,
  ouvrier_id int REFERENCES ouvrier_chantier(id) ON DELETE CASCADE,
  type text, nom text, data text, created_at timestamptz DEFAULT now());

-- Caisse / dépenses de chantier (petty cash)
CREATE TABLE IF NOT EXISTS caisse_mouvement (
  id serial PRIMARY KEY,
  company_id int REFERENCES company(id),
  chantier_id int REFERENCES chantier(id),
  type text NOT NULL DEFAULT 'depense',
  date_mouvement date NOT NULL DEFAULT current_date,
  categorie text, description text, beneficiaire text,
  montant numeric(14,2) NOT NULL DEFAULT 0,
  mode_paiement text DEFAULT 'espèces',
  reference_piece text, tva_recuperable boolean DEFAULT false,
  created_at timestamptz DEFAULT now());

-- Encaissements clients (règlements de factures)
CREATE TABLE IF NOT EXISTS encaissement (
  id serial PRIMARY KEY,
  company_id int REFERENCES company(id),
  facture_id int REFERENCES facture(id) ON DELETE SET NULL,
  client text, date_encaissement date NOT NULL DEFAULT current_date,
  montant numeric(14,2) NOT NULL DEFAULT 0,
  mode_paiement text DEFAULT 'virement', reference text,
  created_at timestamptz DEFAULT now());

-- Cautions & retenues de garantie (marchés)
CREATE TABLE IF NOT EXISTS garantie (
  id serial PRIMARY KEY,
  company_id int REFERENCES company(id),
  chantier_id int REFERENCES chantier(id),
  type text NOT NULL DEFAULT 'definitif',
  marche text, beneficiaire text,
  montant_marche numeric(14,2), taux numeric(6,3), montant numeric(14,2),
  type_emetteur text DEFAULT 'banque', emetteur text, num_acte text,
  date_emission date, date_validite date,
  date_reception_provisoire date, date_reception_definitive date,
  date_mainlevee_prevue date, date_mainlevee_reelle date,
  statut text DEFAULT 'en_cours', observations text,
  created_at timestamptz DEFAULT now());

-- Gasoil / carburant
CREATE TABLE IF NOT EXISTS gasoil_bon (
  id serial PRIMARY KEY,
  company_id int REFERENCES company(id),
  date_bon date NOT NULL DEFAULT current_date,
  materiel_id int REFERENCES materiel(id), vehicule text, chauffeur text,
  chantier_id int REFERENCES chantier(id),
  quantite_litres numeric(10,2) NOT NULL DEFAULT 0, prix_litre numeric(8,3), montant numeric(12,2),
  compteur numeric(12,1), station text, num_bon text, plein boolean DEFAULT true,
  observations text, created_at timestamptz DEFAULT now());

-- Déclaration d'accident de travail (loi 18-12)
CREATE TABLE IF NOT EXISTS accident_travail (
  id serial PRIMARY KEY,
  company_id int REFERENCES company(id),
  ouvrier_id int REFERENCES ouvrier_chantier(id), employee_id int REFERENCES employee(id),
  victime_nom text, victime_cin text, victime_cnss text, victime_poste text,
  chantier_id int REFERENCES chantier(id),
  type_accident text DEFAULT 'travail',
  date_accident date, heure_accident text, lieu text,
  circonstances text, nature_lesion text, siege_lesion text, temoins text,
  date_info_employeur date, date_decl_assureur date, date_avis_travail date,
  assureur text, num_police text, certificat_medical boolean DEFAULT false,
  jours_arret int, gravite text, suites text, statut text DEFAULT 'declare',
  created_at timestamptz DEFAULT now());

-- Échéancier fiscal & social
CREATE TABLE IF NOT EXISTS echeance (
  id serial PRIMARY KEY,
  company_id int REFERENCES company(id),
  type text, libelle text, date_echeance date NOT NULL,
  statut text DEFAULT 'a_faire', date_fait date, montant numeric(14,2), notes text,
  auto boolean DEFAULT false, created_at timestamptz DEFAULT now());

-- Appels d'offres / soumissions
CREATE TABLE IF NOT EXISTS appel_offre (
  id serial PRIMARY KEY,
  company_id int REFERENCES company(id),
  objet text, reference text, maitre_ouvrage text,
  date_publication date, date_limite date, date_ouverture date,
  montant_estime numeric(14,2), caution_provisoire numeric(14,2),
  statut text DEFAULT 'a_etudier', date_resultat date, montant_adjuge numeric(14,2),
  chantier_id int REFERENCES chantier(id), observations text,
  created_at timestamptz DEFAULT now());

-- Maintenance du matériel
CREATE TABLE IF NOT EXISTS maintenance (
  id serial PRIMARY KEY,
  company_id int REFERENCES company(id),
  materiel_id int REFERENCES materiel(id),
  date_maintenance date NOT NULL DEFAULT current_date,
  type text DEFAULT 'preventive', description text,
  cout numeric(12,2), compteur numeric(12,1), prestataire text,
  prochaine_date date, prochain_compteur numeric(12,1), statut text DEFAULT 'fait',
  created_at timestamptz DEFAULT now());

-- Multi-tenant : rattachement d'un utilisateur à une société (NULL = super-admin)
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);

-- Abonnement (vente SaaS)
ALTER TABLE company ADD COLUMN IF NOT EXISTS plan text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS abonnement_fin timestamptz;
ALTER TABLE company ADD COLUMN IF NOT EXISTS actif boolean DEFAULT true;

-- Journal d'activité (audit trail)
CREATE TABLE IF NOT EXISTS activite (
  id serial PRIMARY KEY,
  user_email text, action text, cible text, statut int,
  company_id int, created_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS activite_company_idx ON activite (company_id, created_at DESC);

-- Bordereau des prix / détail estimatif (chapitres + lignes en JSON)
CREATE TABLE IF NOT EXISTS bordereau (
  id serial PRIMARY KEY,
  numero text, marche text, maitre_ouvrage text, objet text, client text, client_ice text,
  contenu jsonb NOT NULL DEFAULT '[]',
  total_ht numeric(14,2) DEFAULT 0, tva numeric(14,2) DEFAULT 0, total_ttc numeric(14,2) DEFAULT 0,
  company_id int REFERENCES company(id), created_at timestamptz DEFAULT now());

-- Société : coordonnées et identité pour les documents (devis, factures…)
ALTER TABLE company ADD COLUMN IF NOT EXISTS adresse text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS ville text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS telephone text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS rc text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS if_fiscal text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS patente text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS cnss text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS rib text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS logo text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS tva_taux numeric(5,2) DEFAULT 20;
ALTER TABLE company ADD COLUMN IF NOT EXISTS forme_juridique text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS capital text;
ALTER TABLE company ADD COLUMN IF NOT EXISTS devis_format text DEFAULT 'DEV-{AAAA}-{####}';
ALTER TABLE company ADD COLUMN IF NOT EXISTS facture_format text DEFAULT 'FAC-{AAAA}-{####}';
ALTER TABLE company ADD COLUMN IF NOT EXISTS devis_compteur int DEFAULT 0;
ALTER TABLE company ADD COLUMN IF NOT EXISTS facture_compteur int DEFAULT 0;
ALTER TABLE devis ADD COLUMN IF NOT EXISTS client_ice text;
ALTER TABLE facture ADD COLUMN IF NOT EXISTS client_ice text;
ALTER TABLE soustraitant_contrat ADD COLUMN IF NOT EXISTS numero text;
ALTER TABLE soustraitant_contrat ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE soustraitant_contrat ADD COLUMN IF NOT EXISTS tva_taux numeric(5,2) DEFAULT 20;
ALTER TABLE soustraitant_contrat ADD COLUMN IF NOT EXISTS delai_execution text;
ALTER TABLE soustraitant_contrat ADD COLUMN IF NOT EXISTS modalites_paiement text;
ALTER TABLE soustraitant_contrat ADD COLUMN IF NOT EXISTS penalites text;
ALTER TABLE soustraitant_contrat ADD COLUMN IF NOT EXISTS avance_taux numeric(5,2) DEFAULT 0;
ALTER TABLE soustraitant_contrat ADD COLUMN IF NOT EXISTS lieu_signature text;
ALTER TABLE soustraitant_contrat ADD COLUMN IF NOT EXISTS date_signature date;
ALTER TABLE soustraitant_contrat ADD COLUMN IF NOT EXISTS company_id int REFERENCES company(id);
ALTER TABLE facture ADD COLUMN IF NOT EXISTS ref_facture_id int;
ALTER TABLE facture ADD COLUMN IF NOT EXISTS motif text;
-- ===== Enrichissements modules (après création des tables) =====
-- Salarié (RH complet)
ALTER TABLE employee ADD COLUMN IF NOT EXISTS date_naissance date;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS lieu_naissance text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS sexe text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS situation_familiale text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS adresse text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS telephone text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS type_contrat text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS date_fin_contrat date;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS qualification text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS rib text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS banque text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS cimr text;
ALTER TABLE employee ADD COLUMN IF NOT EXISTS mutuelle text;
-- Parc matériel
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS marque text;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS modele text;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS immatriculation text;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS num_serie text;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS fournisseur text;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS date_mise_service date;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS compteur numeric(12,2);
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS unite_compteur text;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS assurance_compagnie text;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS assurance_police text;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS date_assurance date;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS prochaine_maintenance date;
ALTER TABLE materiel ADD COLUMN IF NOT EXISTS observations text;
-- Fournisseur
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS rc text;
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS if_fiscal text;
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS patente text;
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS adresse text;
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS ville text;
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS rib text;
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS banque text;
ALTER TABLE fournisseur ADD COLUMN IF NOT EXISTS famille text;
-- Client
ALTER TABLE client ADD COLUMN IF NOT EXISTS rc text;
ALTER TABLE client ADD COLUMN IF NOT EXISTS if_fiscal text;
ALTER TABLE client ADD COLUMN IF NOT EXISTS patente text;
ALTER TABLE client ADD COLUMN IF NOT EXISTS type text;
-- Article / Stock
ALTER TABLE article ADD COLUMN IF NOT EXISTS categorie text;
ALTER TABLE article ADD COLUMN IF NOT EXISTS emplacement text;
ALTER TABLE article ADD COLUMN IF NOT EXISTS fournisseur text;
ALTER TABLE article ADD COLUMN IF NOT EXISTS tva_taux numeric(5,2);
-- Demande d'achat
ALTER TABLE demande_achat ADD COLUMN IF NOT EXISTS demandeur text;
ALTER TABLE demande_achat ADD COLUMN IF NOT EXISTS date_demande date;
ALTER TABLE demande_achat ADD COLUMN IF NOT EXISTS date_besoin date;
ALTER TABLE demande_achat ADD COLUMN IF NOT EXISTS priorite text;
ALTER TABLE demande_achat ADD COLUMN IF NOT EXISTS quantite numeric(12,2);
ALTER TABLE demande_achat ADD COLUMN IF NOT EXISTS unite text;
ALTER TABLE demande_achat ADD COLUMN IF NOT EXISTS article text;
ALTER TABLE demande_achat ADD COLUMN IF NOT EXISTS observations text;
-- Incident sécurité
ALTER TABLE incident ADD COLUMN IF NOT EXISTS lieu text;
ALTER TABLE incident ADD COLUMN IF NOT EXISTS heure text;
ALTER TABLE incident ADD COLUMN IF NOT EXISTS victime text;
ALTER TABLE incident ADD COLUMN IF NOT EXISTS temoins text;
ALTER TABLE incident ADD COLUMN IF NOT EXISTS type_accident text;
-- Contrôle sécurité
ALTER TABLE controle_securite ADD COLUMN IF NOT EXISTS domaine text;
ALTER TABLE controle_securite ADD COLUMN IF NOT EXISTS actions_correctives text;
ALTER TABLE controle_securite ADD COLUMN IF NOT EXISTS echeance date;
-- Congés (droit marocain)
ALTER TABLE conge ADD COLUMN IF NOT EXISTS remplacant text;
ALTER TABLE conge ADD COLUMN IF NOT EXISTS justificatif text;
ALTER TABLE conge ADD COLUMN IF NOT EXISTS paye boolean DEFAULT true;
ALTER TABLE conge ADD COLUMN IF NOT EXISTS date_demande date;
-- Rapport journalier de chantier
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS numero text;
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS redige_par text;
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS temperature text;
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS heures_arret numeric(5,2);
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS effectif_st int DEFAULT 0;
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS materiel_present text;
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS travaux_realises text;
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS approvisionnements text;
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS incidents text;
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS visiteurs text;
ALTER TABLE rapport_chantier ADD COLUMN IF NOT EXISTS instructions text;
`;

async function seedIfEmpty(table, fn) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  if (rows[0].n === 0) await fn();
}

async function initDb() {
  await pool.query(SCHEMA);

  const DEMO = process.env.SEED_DEMO === "1"; // données de démo uniquement si explicitement demandé

  // Nettoyage unique des données de démonstration (conserve sociétés + comptes utilisateurs)
  await pool.query("CREATE TABLE IF NOT EXISTS app_meta (key text PRIMARY KEY, value text)");
  const dejaPurge = (await pool.query("SELECT 1 FROM app_meta WHERE key='demo_purge_v1'")).rowCount;
  if (!dejaPurge && !DEMO) {
    const BUSINESS = ["employee","chantier","devis","facture","article","fournisseur","sous_traitant",
      "payroll_run","ouvrage","bordereau","activite","paiement","pointage","tache","materiel",
      "rapport_chantier","document","incident","controle_securite","epi","evaluation","conge","contrat",
      "demande_achat","bon_commande","affectation","chantier_expense","mouvement_stock","client"];
    const exist = (await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)", [BUSINESS]
    )).rows.map((r) => r.table_name);
    if (exist.length) await pool.query(`TRUNCATE ${exist.join(",")} RESTART IDENTITY CASCADE`);
    await pool.query("INSERT INTO app_meta (key,value) VALUES ('demo_purge_v1', now()::text) ON CONFLICT (key) DO NOTHING");
    console.log("🧹 Données de démonstration purgées (sociétés et comptes conservés).");
  }

  if (DEMO) await seedIfEmpty("company", () =>
    pool.query(`INSERT INTO company (raison_sociale, ice, adresse, ville, telephone, email, rc, if_fiscal, patente, cnss, rib, tva_taux)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,20)`,
      ["Atlas Constructions SARL", "001234567000089", "12, Zone Industrielle Sidi Bernoussi", "Casablanca",
       "+212 522 00 00 00", "contact@atlas-constructions.ma", "123456", "45678901", "33445566", "7788990",
       "011 780 0000000000000000 12"]));

  // Remplissage unique et sûr des mentions légales de la société de production
  // (ne remplit que les champs vides — n'écrase jamais une saisie existante).
  try {
    await pool.query(
      `UPDATE company SET
         forme_juridique = COALESCE(NULLIF(forme_juridique,''), 'SARL'),
         ice       = COALESCE(NULLIF(ice,''),       '001835752000047'),
         rc        = COALESCE(NULLIF(rc,''),        '380851'),
         if_fiscal = COALESCE(NULLIF(if_fiscal,''), '24814243'),
         patente   = COALESCE(NULLIF(patente,''),   '34704631'),
         cnss      = COALESCE(NULLIF(cnss,''),      '5512729')
       WHERE raison_sociale = 'ARAB AGENCEMENT SARL'`);
  } catch (e) { /* champs absents : ignoré */ }

  // Nettoyage unique des échéances fiscales en double (suite au changement de date TVA)
  try {
    const done = (await pool.query("SELECT 1 FROM app_meta WHERE key='echeance_dedup_v1'")).rowCount;
    if (!done) {
      await pool.query(`DELETE FROM echeance e WHERE auto=true AND id NOT IN (
          SELECT DISTINCT ON (company_id, type, libelle) id FROM echeance WHERE auto=true
          ORDER BY company_id, type, libelle, (statut='fait') DESC, date_echeance DESC)`);
      await pool.query("INSERT INTO app_meta (key,value) VALUES ('echeance_dedup_v1', now()::text) ON CONFLICT (key) DO NOTHING");
    }
  } catch (e) { /* table absente au tout premier boot : ignoré */ }

  await seedIfEmpty("app_user", async () => {
    const email = process.env.ADMIN_EMAIL || "admin@btppro.ma";
    const pwd = process.env.ADMIN_PASSWORD || "btppro2026";
    const hash = await bcrypt.hash(pwd, 10);
    await pool.query("INSERT INTO app_user (email, password_hash, full_name, role) VALUES ($1,$2,$3,$4)",
      [email, hash, "Administrateur", "DIRECTEUR"]);
    console.log(`👤 Admin : ${email} / ${pwd}`);
  });

  if (DEMO) await seedIfEmpty("employee", async () => {
    for (const r of [
      ["BTP-0101", "Hamid Ouazzani", "Manœuvre", 3500, 6, 1],
      ["BTP-0142", "Karim El Idrissi", "Ouvrier qualifié", 5000, 30, 2],
      ["BTP-0177", "Saïd Benani", "Contremaître", 8000, 72, 3],
      ["BTP-0203", "Youssef Tahiri", "Chef de chantier", 14000, 156, 4],
    ]) await pool.query(
      "INSERT INTO employee (matricule,nom,poste,salaire_base,mois_anciennete,personnes_charge) VALUES ($1,$2,$3,$4,$5,$6)", r);
  });

  if (DEMO) await seedIfEmpty("contrat", async () => {
    // Organigramme : chef de chantier → contremaître → ouvrier/manœuvre
    const emps = (await pool.query("SELECT id,matricule,poste,salaire_base FROM employee ORDER BY id")).rows;
    const by = (m) => emps.find((e) => e.matricule === m);
    const chef = by("BTP-0203"), contre = by("BTP-0177");
    if (chef && contre) {
      await pool.query("UPDATE employee SET manager_id=$1 WHERE matricule IN ('BTP-0177')", [chef.id]);
      await pool.query("UPDATE employee SET manager_id=$1 WHERE matricule IN ('BTP-0101','BTP-0142')", [contre.id]);
    }
    // Un contrat actif par salarié (le contrat actif pilote la paie)
    for (const e of emps) {
      const type = e.salaire_base >= 8000 ? "CDI" : "CDD";
      await pool.query(
        "INSERT INTO contrat (employee_id,type,poste,salaire_base,date_debut,actif) VALUES ($1,$2,$3,$4,'2025-01-01',true)",
        [e.id, type, e.poste, e.salaire_base]);
    }
    // Quelques évaluations
    if (contre) await pool.query(
      "INSERT INTO evaluation (employee_id,note,evaluateur,commentaire) VALUES ($1,4,'Direction','Bon encadrement des équipes')", [contre.id]);
  });

  if (DEMO) await seedIfEmpty("chantier", async () => {
    for (const r of [
      ["CH-001", "Résidence Al Manar", "Groupe Addoha", "Casablanca", "en_cours", 4500000],
      ["CH-002", "Pont Oued Bouregreg", "Ministère Équipement", "Rabat", "en_cours", 12000000],
      ["CH-003", "Centre commercial Tanger", "Marjane Holding", "Tanger", "prospect", 8000000],
    ]) await pool.query(
      "INSERT INTO chantier (code,nom,client,ville,statut,budget_prevu) VALUES ($1,$2,$3,$4,$5,$6)", r);
  });

  if (DEMO) await seedIfEmpty("fournisseur", async () => {
    for (const r of [
      ["LafargeHolcim Maroc", "001100220033001", "Service commercial", "0522000000", "contact@lafarge.ma"],
      ["Sonasid", "001100220033002", "Ventes acier", "0523000000", "contact@sonasid.ma"],
    ]) await pool.query(
      "INSERT INTO fournisseur (raison_sociale,ice,contact,telephone,email) VALUES ($1,$2,$3,$4,$5)", r);
  });

  if (DEMO) await seedIfEmpty("article", async () => {
    for (const r of [
      ["CIM-CPJ45", "Ciment CPJ 45 (sac 50kg)", "sac", 320, 100, 78],
      ["ACI-FE500", "Acier à béton Fe500 (T)", "t", 12, 5, 9500],
      ["AGG-GRAV", "Gravette concassée (m3)", "m3", 85, 30, 180],
    ]) await pool.query(
      "INSERT INTO article (reference,designation,unite,stock,seuil,prix_unitaire) VALUES ($1,$2,$3,$4,$5,$6)", r);
  });
  // Initialiser le CMUP des articles neufs (au prix d'achat de référence)
  await pool.query("UPDATE article SET cmup = prix_unitaire WHERE cmup IS NULL OR cmup = 0");

  if (DEMO) await seedIfEmpty("ouvrage", async () => {
    // Ouvrage + sous-détail de prix (déboursé sec = somme des composants)
    const ouvrages = [
      { code: "BET-001", designation: "Béton dosé 350 kg/m³ pour fondations", unite: "m3", composants: [
        ["materiau", "Ciment CPJ 45", "kg", 350, 0.78],
        ["materiau", "Sable", "m3", 0.4, 180],
        ["materiau", "Gravette", "m3", 0.8, 180],
        ["main_oeuvre", "Maçon + aide (mise en œuvre)", "h", 3, 45],
        ["materiel", "Bétonnière (location)", "h", 1.5, 60],
      ] },
      { code: "MAC-001", designation: "Maçonnerie agglos 20×20×40", unite: "m2", composants: [
        ["materiau", "Agglos creux 20", "u", 12.5, 4.5],
        ["materiau", "Mortier de pose", "m3", 0.02, 900],
        ["main_oeuvre", "Maçon", "h", 1.2, 45],
      ] },
      { code: "ACI-001", designation: "Acier façonné HA pour béton armé", unite: "kg", composants: [
        ["materiau", "Acier HA Fe500", "kg", 1.05, 9.5],
        ["main_oeuvre", "Ferrailleur (façonnage/pose)", "h", 0.03, 50],
      ] },
    ];
    for (const o of ouvrages) {
      const { rows } = await pool.query(
        "INSERT INTO ouvrage (code,designation,unite) VALUES ($1,$2,$3) RETURNING id", [o.code, o.designation, o.unite]);
      for (const c of o.composants)
        await pool.query(
          "INSERT INTO ouvrage_composant (ouvrage_id,type,designation,unite,quantite,prix_unitaire) VALUES ($1,$2,$3,$4,$5,$6)",
          [rows[0].id, ...c]);
    }
  });

  if (DEMO) await seedIfEmpty("epi", async () => {
    const emps = (await pool.query("SELECT id FROM employee ORDER BY id")).rows;
    for (const e of emps) {
      await pool.query("INSERT INTO epi (employee_id,designation,type) VALUES ($1,'Casque de chantier','tete')", [e.id]);
      await pool.query("INSERT INTO epi (employee_id,designation,type) VALUES ($1,'Chaussures de sécurité S3','pieds')", [e.id]);
    }
    const ch = (await pool.query("SELECT id FROM chantier ORDER BY id LIMIT 1")).rows[0];
    if (ch) await pool.query(
      "INSERT INTO controle_securite (chantier_id,type,conforme,observations,controleur) VALUES ($1,'Inspection mensuelle',true,'Port des EPI conforme','HSE')", [ch.id]);
  });

  if (DEMO) await seedIfEmpty("document", async () => {
    const ch = (await pool.query("SELECT id FROM chantier ORDER BY id LIMIT 1")).rows[0];
    const doc = (await pool.query(
      "INSERT INTO document (nom,type,categorie,chantier_id,url,version) VALUES ('Plan de coffrage R+2','plan','technique',$1,'/docs/plan-r2-v1.pdf',1) RETURNING id",
      [ch ? ch.id : null])).rows[0];
    await pool.query("INSERT INTO document_version (document_id,version,url,auteur,note) VALUES ($1,1,'/docs/plan-r2-v1.pdf','BE','Version initiale')", [doc.id]);
  });

  if (DEMO) await seedIfEmpty("sous_traitant", async () => {
    const ch = (await pool.query("SELECT id FROM chantier ORDER BY id LIMIT 1")).rows[0];
    const sts = [
      ["Électricité Atlas SARL", "Électricité", "M. Alaoui", "0661000001"],
      ["Plomberie du Détroit", "Plomberie / sanitaire", "M. Bennis", "0661000002"],
    ];
    for (const r of sts) {
      const st = (await pool.query(
        "INSERT INTO sous_traitant (raison_sociale,specialite,contact,telephone) VALUES ($1,$2,$3,$4) RETURNING id", r)).rows[0];
      if (ch) await pool.query(
        "INSERT INTO soustraitant_contrat (sous_traitant_id,chantier_id,objet,montant_marche,rg_taux,date_debut,statut) VALUES ($1,$2,$3,$4,10,'2026-01-01','en_cours')",
        [st.id, ch.id, "Lot " + r[1], 800000]);
    }
  });

  console.log("✅ Base initialisée.");

  // Multi-société : 2e société de démonstration + rattachement des données existantes (mode démo uniquement)
  if (DEMO) {
    const c2 = await pool.query("SELECT count(*)::int AS n FROM company");
    if (c2.rows[0].n < 2) {
      await pool.query("INSERT INTO company (raison_sociale, ice) VALUES ($1,$2)", ["Détroit BTP SARL", "002345678000077"]);
    }
    const firstCompany = (await pool.query("SELECT id FROM company ORDER BY id LIMIT 1")).rows[0].id;
    for (const t of ["employee","chantier","devis","facture","article","fournisseur","sous_traitant",
      "payroll_run","conge","incident","controle_securite","document","demande_achat","bon_commande","ouvrage","epi","evaluation"]) {
      await pool.query(`UPDATE ${t} SET company_id=$1 WHERE company_id IS NULL`, [firstCompany]);
    }
  }
}

module.exports = { pool, initDb };
