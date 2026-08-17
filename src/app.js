import 'dotenv/config';
import express from 'express';
import { initDb, updateScanTable } from './db.js';
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

// Protège l'endpoint de scraping : appel réservé au workflow planifié (GitHub Actions)
// muni du secret partagé. Sans CRON_SECRET configuré (dev local), la vérification est ignorée.
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
      const { fn, displayName } = SCRAPERS[scraper];
      const startTime = Date.now();
      await fn();
      await updateScanTable(displayName, startTime);
      res.json({ status: "done", message: `Scraper ${scraper} terminé.` });
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
