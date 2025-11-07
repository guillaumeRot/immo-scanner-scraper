import 'dotenv/config';
import express from 'express';
import { closeDb, initDb } from './db.js';
import { immonotScraper } from './sites/immonot.js';
import { kermarrecScraper } from './sites/kermarrec.js';
import { eraScraper } from './sites/era.js';
import { blotScraper } from './sites/blot.js';
import { carnotScraper } from './sites/carnot.js';
import { diardScraper } from './sites/diard.js';
import { pennScraper } from './sites/penn.js';
import { centuryScraper } from './sites/century.js';
import { bretilimmoScraper } from './sites/bretilimmo.js';
import { boyerScraper } from './sites/boyer.js';
import { notairesBretonsScraper } from './sites/notaires-bretons.js';
import { immobilierNotairesScraper } from './sites/immobilier-notaires.js';
import { figaroImmobilierScraper } from './sites/immobilier-figaro.js';
import { acheterLouerScraper } from './sites/acheter-louer.js';
import { logicImmoScraper } from './sites/logic-immo.js';
const app = express();

// Évite les exécutions concurrentes
let isScrapeRunning = false;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Scraper API en ligne 🚀' });
});

app.get('/run-scrapers', async (req, res) => {
    // Récupération du paramètre de l’URL, ex: /run-scrapers?scraper=immonot
    const { scraper } = req.query;

    console.log(`📩 [Handler] Appel reçu pour le scraper ${scraper}!`);
    if (isScrapeRunning) {
        return res.status(409).json({
          status: "already_running",
          message: "Un scraping est déjà en cours. Réessayez plus tard.",
        });
    }

    try {
      isScrapeRunning = true;
      await initDb();

      if (scraper === "immonot") {
        await immonotScraper();
      } else if (scraper === "kermarrec") {
        await kermarrecScraper();
      } else if (scraper === "era") {
        await eraScraper();
      } else if (scraper === "blot") {
        await blotScraper();
      } else if (scraper === "carnot") {
        await carnotScraper();
      } else if (scraper === "diard") {
        await diardScraper();
      } else if (scraper === "penn") {
        await pennScraper();
      } else if (scraper === "century") {
        await centuryScraper();
      } else if (scraper === "bretilimmo") {
        await bretilimmoScraper();
      } else if (scraper === "boyer") {
        await boyerScraper();
      } else if (scraper === "notaires-bretons") {
        await notairesBretonsScraper();
      } else if (scraper === "immobilier-notaires") {
        await immobilierNotairesScraper();
      } else if (scraper === "figaro-immobilier") {
        await figaroImmobilierScraper();
      } else if (scraper === "acheter-louer") {
        await acheterLouerScraper();
      } else if (scraper === "logic-immo") {
        await logicImmoScraper();
      // } else if (scraper === "fnaim") {
      //   await fnaimScraper();
      } else {
        // Si aucun paramètre ou valeur inconnue, tu lances les deux
        await immonotScraper();
        await kermarrecScraper();
        await eraScraper();
        await blotScraper();
        await carnotScraper();
        await pennScraper();
        await diardScraper();
        await centuryScraper();
        await bretilimmoScraper();
        await boyerScraper();
        await notairesBretonsScraper();
        await immobilierNotairesScraper();
        await figaroImmobilierScraper();
        await acheterLouerScraper();
        await logicImmoScraper();
        // await fnaimScraper();
      }
      
      await closeDb();
      res.json({ status: "running", message: "Scrapers " + scraper + " démarrés." });
    } catch (e) {
      console.error("❌ Erreur dans /run-scrapers:", e);
      res.json({ status: "error", message: e.message });
    } finally {
      isScrapeRunning = false;
    }
  }
);

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`✅ API active sur port ${port}`));
