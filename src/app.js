import 'dotenv/config';
import express from 'express';
import { waitUntil } from '@vercel/functions';
import {
  initDb,
  updateScanTable,
  claimUnnotifiedErreurs,
  purgeOldErreurs,
  insertErreur,
  getRecherchesActives,
  getMaxAnnonceId,
  getAnnoncesCorrespondantes,
  mettreAJourCurseurRecherche,
  avecRafraichissementComplet,
} from './db.js';
import { sendRechercheAlerteEmail, sendErrorReportEmail } from './email.js';
import { immonotScraper } from './sites/immonot.js';
import { kermarrecScraper, kermarrecLocationScraper } from './sites/kermarrec.js';
import { eraScraper, eraLocationScraper } from './sites/era.js';
import { blotScraper } from './sites/blot.js';
import { carnotScraper, carnotLocationScraper } from './sites/carnot.js';
import { diardScraper, diardLocationScraper } from './sites/diard.js';
import { pennScraper } from './sites/penn.js';
import { centuryScraper } from './sites/century.js';
import { bretilimmoScraper, bretilimmoLocationScraper } from './sites/bretilimmo.js';
import { boyerScraper, boyerLocationScraper } from './sites/boyer.js';
import { notairesBretonsScraper, notairesBretonsLocationScraper } from './sites/notaires-bretons.js';
import { immobilierNotairesScraper } from './sites/immobilier-notaires.js';
import { acheterLouerScraper, acheterLouerLocationScraper } from './sites/acheter-louer.js';
import { bienIciScraper, bienIciLocationScraper } from './sites/bien-ici.js';
import { fnaimScraper } from './sites/fnaim.js';
import { laforetScraper } from './sites/laforet.js';
import { squareHabitatScraper } from './sites/square-habitat.js';
import { laFrancaiseImmobiliereScraper } from './sites/la-francaise-immobiliere.js';
import { nestennScraper } from './sites/nestenn.js';
import { cornierImmobilierScraper } from './sites/cornier-immobilier.js';
import { ajpImmobilierScraper } from './sites/ajp-immobilier.js';
import { alternativeImmobilierScraper } from './sites/alternative-immobilier.js';
import { iadFranceScraper } from './sites/iad-france.js';
import { efficityScraper } from './sites/efficity.js';
import { alcImmobilierScraper } from './sites/alc-immobilier.js';
import { myHomeImmobilierScraper } from './sites/my-home-immobilier.js';

// Figaro Immobilier, Logic-immo et Ouest-France Immo sont désactivés : ils nécessitent
// Playwright (protections anti-bot Cloudflare/DataDome/challenge maison), incompatible
// avec un déploiement serverless Vercel. Leurs fichiers restent dans src/sites/ pour
// référence mais ne sont plus importés ici.

const app = express();
app.use(express.json());

// Liste des scrapers pilotables, tous fetch+cheerio (compatibles serverless)
const SCRAPERS = {
  "kermarrec": { fn: kermarrecScraper, displayName: "Kermarrec" },
  "era": { fn: eraScraper, displayName: "ERA" },
  "blot": { fn: blotScraper, displayName: "Blot" },
  "carnot": { fn: carnotScraper, displayName: "Carnot" },
  "penn": { fn: pennScraper, displayName: "Penn" },
  "diard": { fn: diardScraper, displayName: "Diard" },
  "century": { fn: centuryScraper, displayName: "Century 21" },
  "bretilimmo": { fn: bretilimmoScraper, displayName: "Bretil'Immo" },
  "boyer": { fn: boyerScraper, displayName: "Boyer Immobilier" },
  "notaires-bretons": { fn: notairesBretonsScraper, displayName: "Notaires et Bretons" },
  "immobilier-notaires": { fn: immobilierNotairesScraper, displayName: "Immobilier Notaires" },
  "acheter-louer": { fn: acheterLouerScraper, displayName: "Acheter-louer" },
  "bien-ici": { fn: bienIciScraper, displayName: "Bien-ici" },
  "immonot": { fn: immonotScraper, displayName: "Immonot" },
  "fnaim": { fn: fnaimScraper, displayName: "FNAIM" },
  "laforet": { fn: laforetScraper, displayName: "Laforêt" },
  "square-habitat": { fn: squareHabitatScraper, displayName: "Square Habitat" },
  "la-francaise-immobiliere": { fn: laFrancaiseImmobiliereScraper, displayName: "La Française Immobilière" },
  "nestenn": { fn: nestennScraper, displayName: "Nestenn" },
  "cornier-immobilier": { fn: cornierImmobilierScraper, displayName: "Cornier Immobilier" },
  "ajp-immobilier": { fn: ajpImmobilierScraper, displayName: "AJP Immobilier" },
  "alternative-immobilier": { fn: alternativeImmobilierScraper, displayName: "Alternative Immobilier" },
  "iad-france": { fn: iadFranceScraper, displayName: "iad France" },
  "efficity": { fn: efficityScraper, displayName: "Efficity" },
  "alc-immobilier": { fn: alcImmobilierScraper, displayName: "ALC Immobilier" },
  "my-home-immobilier": { fn: myHomeImmobilierScraper, displayName: "My Home Immobilier" },

  // Location (appartements) — mêmes agences, quand elles proposent de la location.
  // Century 21, Immobilier Notaires, Immonot, FNAIM et Penn n'ont pas de recherche
  // location exploitable trouvée (cf. DEPLOY.md) et n'ont donc pas d'équivalent ici.
  // Blot (location) existe dans src/sites/blot.js mais n'est pas branché ici : sans
  // filtre serveur fiable pour les biens déjà loués côté location (clean_vendus ne
  // fonctionne que pour la vente), la recherche remonte ~180 fiches "VENDU/LOUE" pour
  // 0 résultat utile en ~2min30 — cf. DEPLOY.md.
  "kermarrec-location": { fn: kermarrecLocationScraper, displayName: "Kermarrec (location)" },
  "era-location": { fn: eraLocationScraper, displayName: "ERA (location)" },
  "carnot-location": { fn: carnotLocationScraper, displayName: "Carnot (location)" },
  "diard-location": { fn: diardLocationScraper, displayName: "Diard (location)" },
  "bretilimmo-location": { fn: bretilimmoLocationScraper, displayName: "Bretil'Immo (location)" },
  "boyer-location": { fn: boyerLocationScraper, displayName: "Boyer Immobilier (location)" },
  "notaires-bretons-location": { fn: notairesBretonsLocationScraper, displayName: "Notaires et Bretons (location)" },
  "acheter-louer-location": { fn: acheterLouerLocationScraper, displayName: "Acheter-louer (location)" },
  "bien-ici-location": { fn: bienIciLocationScraper, displayName: "Bien-ici (location)" },
};

// Protège les endpoints : appel réservé au workflow planifié (cron-job.org) muni du
// secret partagé. Sans CRON_SECRET configuré (dev local), la vérification est ignorée.
function checkAuth(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const provided = req.get("x-cron-secret") || req.query.secret;
  if (provided !== secret) {
    res.status(401).json({ status: "error", message: "Non autorisé" });
    return false;
  }
  return true;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Scraper API en ligne 🚀' });
});

// Lance un scraper en arrière-plan et répond tout de suite (202). Partagé entre
// /run-scrapers (runs horaires, fiches déjà vues sautées) et /refresh-prix (1 fois par jour,
// toutes les fiches rechargées pour capter les changements de prix).
function lancerScraperAsync(scraper, res, { rafraichir = false } = {}) {
  const { fn, displayName } = SCRAPERS[scraper];
  const startTime = Date.now();

  // Exécution asynchrone : on répond tout de suite à cron-job.org (qui a un plafond
  // de 30s, plus strict que les 60s de maxDuration Vercel) et le scraping continue en
  // arrière-plan. waitUntil() maintient la fonction serverless vivante jusqu'à la fin
  // du scraping (borné par maxDuration) même après l'envoi de la réponse HTTP. La
  // détection d'échec ne passe plus par le code HTTP de cet appel (déjà envoyé avant
  // la fin du scraping) mais par /send-error-report, qui lit la table Erreur.
  const runInBackground = (async () => {
    try {
      await (rafraichir ? avecRafraichissementComplet(fn) : fn());
      await updateScanTable(displayName, startTime);
    } catch (err) {
      console.error(`❌ Erreur (async) scraper ${displayName}:`, err);
      try {
        await insertErreur(displayName, "RUN", String(err));
      } catch (_) {
        // rien à faire de plus si même l'enregistrement de l'erreur échoue
      }
    }
  })();

  if (process.env.VERCEL) {
    waitUntil(runInBackground);
  }

  const mode = rafraichir ? "rafraîchissement des prix" : "traitement asynchrone";
  res.status(202).json({ status: "started", message: `Scraper ${scraper} démarré (${mode}).` });
}

app.get('/run-scrapers', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { scraper } = req.query;
  console.log(`📩 [Handler] Appel reçu pour le scraper ${scraper}!`);

  try {
    await initDb();

    if (scraper && !SCRAPERS[scraper]) {
      res.status(400).json({ status: "error", message: `Scraper inconnu: ${scraper}` });
      return;
    }

    if (scraper) {
      lancerScraperAsync(scraper, res);
      return;
    }

    // Aucun scraper précisé : lance tout séquentiellement. Réservé à un usage local/manuel —
    // sur Vercel, préférer un appel par scraper (voir workflow GitHub Actions) pour rester
    // sous la limite de durée d'exécution d'une fonction serverless.
    for (const [name, { fn, displayName }] of Object.entries(SCRAPERS)) {
      try {
        console.log(`🚀 Démarrage du scraper ${displayName}...`);
        const startTime = Date.now();
        await fn();
        await updateScanTable(displayName, startTime);
      } catch (error) {
        console.error(`❌ Erreur lors du scraper ${displayName}:`, error);
      }
    }
    res.json({ status: "done", message: "Tous les scrapers ont été exécutés." });
  } catch (e) {
    console.error("❌ Erreur dans /run-scrapers:", e);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Déclenchés par deux tâches cron-job.org séparées (indépendantes du rythme des
// scrapers et l'une de l'autre) : pour chaque recherche sauvegardée active (comptes
// utilisateurs, cf. docs/comptes-alertes.md dans scraper-immo), regarde s'il y a de
// nouvelles annonces correspondant à ses critères depuis son dernier passage et, si oui,
// envoie un email récapitulatif à l'utilisateur propriétaire de cette recherche. Séparés en
// deux endpoints distincts pour pouvoir mettre en pause les notifications de location (ou de
// vente) indépendamment, en désactivant simplement la tâche cron-job.org correspondante.
// Prévoir un décalage dans le planning cron-job.org (ex: 15-20 min après le créneau de
// scraping) pour laisser le temps à tous les scrapers du lot de terminer avant l'envoi.
async function traiterNotificationsRecherches(typeTransaction) {
  const recherches = await getRecherchesActives(typeTransaction);
  const maxId = await getMaxAnnonceId(typeTransaction);

  let recherchesNotifiees = 0;
  let annoncesEnvoyees = 0;

  for (const recherche of recherches) {
    const annonces = await getAnnoncesCorrespondantes(recherche, typeTransaction);

    if (annonces.length > 0) {
      await sendRechercheAlerteEmail(recherche.email, recherche.nom, annonces, {
        estLocation: typeTransaction === "location",
      });
      recherchesNotifiees += 1;
      annoncesEnvoyees += annonces.length;
    }

    // Le curseur avance toujours jusqu'au dernier id scanné, même sans match : une annonce
    // qui ne correspond à aucun critère ne doit pas être réexaminée à chaque passage.
    await mettreAJourCurseurRecherche(recherche.id, typeTransaction, maxId);
  }

  return { recherches: recherches.length, recherchesNotifiees, annoncesEnvoyees };
}

// Scrapers dont les données viennent directement de la liste (pas de fiche détail, donc pas
// de cache LienVu) : déjà à jour à chaque run horaire, inutile de les rafraîchir.
const SANS_RAFRAICHISSEMENT = new Set(["bien-ici", "bien-ici-location", "immobilier-notaires"]);

// Déclenché 1 fois par jour par une seule tâche cron-job.org (cf. DEPLOY.md) : relance les
// scrapers en ignorant le cache LienVu, pour mettre à jour prix, description et photos des
// annonces déjà connues. Les runs horaires (/run-scrapers) ne rechargent, eux, que les
// nouvelles fiches.
// - avec ?scraper=<nom> : rafraîchit ce scraper (en arrière-plan, comme /run-scrapers) ;
// - sans paramètre : se rappelle lui-même une fois par scraper. Un rafraîchissement complet
//   de tous les scrapers dépasse largement les 60s de maxDuration : chaque scraper tourne
//   donc dans sa propre invocation Vercel, avec sa propre limite de durée.
app.get('/refresh-prix', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { scraper } = req.query;

  if (!scraper) {
    const noms = Object.keys(SCRAPERS).filter((nom) => !SANS_RAFRAICHISSEMENT.has(nom));
    // Derrière le proxy Vercel, req.protocol vaut "http" : forcer https en production.
    const baseUrl = `${process.env.VERCEL ? "https" : req.protocol}://${req.get("host")}`;
    const headers = process.env.CRON_SECRET ? { "x-cron-secret": process.env.CRON_SECRET } : {};
    console.log(`📩 [Handler] Rafraîchissement des prix : lancement de ${noms.length} scrapers`);

    // Chaque appel enfant répond 202 dès son scraper démarré : on n'attend que cette réponse,
    // pas la fin du scraping. Les échecs de lancement sont enregistrés dans Erreur
    // (remontés par /send-error-report).
    const dispatch = (async () => {
      const resultats = await Promise.allSettled(
        noms.map(async (nom) => {
          const r = await fetch(`${baseUrl}/refresh-prix?scraper=${encodeURIComponent(nom)}`, {
            headers,
            signal: AbortSignal.timeout(25000),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        })
      );
      const echecs = resultats
        .map((r, i) => ({ r, nom: noms[i] }))
        .filter(({ r }) => r.status === "rejected");
      if (echecs.length > 0) {
        await initDb();
        for (const { r, nom } of echecs) {
          console.error(`❌ Rafraîchissement ${nom} non lancé:`, r.reason);
          await insertErreur(SCRAPERS[nom].displayName, "REFRESH", `Lancement du rafraîchissement échoué : ${r.reason}`);
        }
      }
      console.log(`✅ Rafraîchissement des prix : ${noms.length - echecs.length}/${noms.length} scrapers lancés`);
    })();

    if (process.env.VERCEL) {
      waitUntil(dispatch);
    }

    res.status(202).json({ status: "started", message: `Rafraîchissement des prix lancé pour ${noms.length} scrapers.` });
    return;
  }

  console.log(`📩 [Handler] Rafraîchissement des prix demandé pour ${scraper}`);

  if (!SCRAPERS[scraper]) {
    res.status(400).json({ status: "error", message: `Scraper inconnu: ${scraper}` });
    return;
  }

  try {
    await initDb();
    lancerScraperAsync(scraper, res, { rafraichir: true });
  } catch (e) {
    console.error("❌ Erreur dans /refresh-prix:", e);
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.get('/send-notifications-ventes', async (req, res) => {
  if (!checkAuth(req, res)) return;

  try {
    await initDb();
    const resultat = await traiterNotificationsRecherches("vente");
    res.json({
      status: "done",
      message: `${resultat.annoncesEnvoyees} vente(s) notifiée(s) sur ${resultat.recherchesNotifiees}/${resultat.recherches} recherche(s) active(s).`,
    });
  } catch (e) {
    console.error("❌ Erreur dans /send-notifications-ventes:", e);
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.get('/send-notifications-locations', async (req, res) => {
  if (!checkAuth(req, res)) return;

  try {
    await initDb();
    const resultat = await traiterNotificationsRecherches("location");
    res.json({
      status: "done",
      message: `${resultat.annoncesEnvoyees} location(s) notifiée(s) sur ${resultat.recherchesNotifiees}/${resultat.recherches} recherche(s) active(s).`,
    });
  } catch (e) {
    console.error("❌ Erreur dans /send-notifications-locations:", e);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Déclenché par un cron-job.org séparé : les scrapers étant désormais asynchrones
// (réponse immédiate à /run-scrapers, cf. plus haut), c'est ce endpoint — et non plus le
// code HTTP de /run-scrapers — qui remonte les échecs de scraping. Regarde s'il y a des
// erreurs pas encore notifiées dans la table Erreur et, si oui, envoie un seul email
// récapitulatif. Prévoir un décalage après le créneau de scraping, comme les endpoints
// de notifications ci-dessus.
app.get('/send-error-report', async (req, res) => {
  if (!checkAuth(req, res)) return;

  try {
    await initDb();
    const erreurs = await claimUnnotifiedErreurs();
    await sendErrorReportEmail(erreurs);
    // Purge à chaque passage plutôt que sur une tâche cron dédiée : /send-error-report
    // tourne déjà régulièrement, pas besoin d'un déclencheur de plus pour ça.
    const supprimees = await purgeOldErreurs();
    res.json({
      status: "done",
      message: `${erreurs.length} erreur(s) notifiée(s), ${supprimees} ancienne(s) supprimée(s).`,
    });
  } catch (e) {
    console.error("❌ Erreur dans /send-error-report:", e);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// En local (npm start) on démarre un vrai serveur HTTP ; sur Vercel, l'app Express
// est utilisée directement comme handler de fonction serverless (voir api/index.js).
if (!process.env.VERCEL) {
  const port = process.env.PORT || 8080;
  app.listen(port, async () => {
    console.log(`✅ API active sur port ${port}`);
    await initDb();
  });
}

export default app;
