import 'dotenv/config';
import express from 'express';
import { waitUntil } from '@vercel/functions';
import { initDb, updateScanTable, insertErreur, avecRafraichissementComplet } from './db.js';
import { traiterNotificationsRecherches, envoyerRapportErreurs } from './notifications.js';
import { SCRAPERS, SANS_RAFRAICHISSEMENT } from './scrapers-registry.js';

const app = express();
app.use(express.json());

// Protège les endpoints : appel réservé à un déclenchement manuel/de secours muni du secret
// partagé (le déclenchement planifié normal passe par GitHub Actions, pas par ces routes —
// cf. DEPLOY.md). Sans CRON_SECRET configuré (dev local), la vérification est ignorée.
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
// /run-scrapers et /refresh-prix. Ces routes ne sont plus appelées par un déclencheur planifié
// (passé à GitHub Actions, cf. scripts/scrape.js et DEPLOY.md) — elles restent comme filet de
// secours pour un déclenchement manuel ponctuel.
function lancerScraperAsync(scraper, res, { rafraichir = false } = {}) {
  const { fn, displayName } = SCRAPERS[scraper];
  const startTime = Date.now();

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
    // sur Vercel, cette requête finirait par dépasser la limite de durée d'une fonction
    // serverless si la liste de scrapers grossit encore (cf. scripts/scrape.js pour
    // l'exécution planifiée normale, sans cette contrainte).
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

// Relance les scrapers en ignorant le cache LienVu, pour mettre à jour prix, description et
// photos des annonces déjà connues (cf. scripts/scrape.js --full pour l'exécution planifiée
// normale). Conservé comme filet de secours manuel.
// - avec ?scraper=<nom> : rafraîchit ce scraper (en arrière-plan, comme /run-scrapers) ;
// - sans paramètre : se rappelle lui-même une fois par scraper, pour rester sous la limite de
//   durée d'une fonction serverless si ce filet de secours est utilisé sur Vercel.
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
    // (remontés par le rapport d'erreurs).
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

// Ces 3 routes ne sont plus appelées par un déclencheur planifié (passé à GitHub Actions, cf.
// scripts/notify.js et DEPLOY.md) — conservées comme filet de secours manuel.
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

app.get('/send-error-report', async (req, res) => {
  if (!checkAuth(req, res)) return;

  try {
    await initDb();
    const resultat = await envoyerRapportErreurs();
    res.json({
      status: "done",
      message: `${resultat.notifiees} erreur(s) notifiée(s), ${resultat.supprimees} ancienne(s) supprimée(s).`,
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
