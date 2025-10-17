import 'dotenv/config';
import express from 'express';
import { closeDb, initDb } from './db.js';
import { immonotScraper } from './sites/immonot.js';
import { kermarrecScraper } from './sites/kermarrec.js';
import { eraScraper } from './sites/era.js';
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
      } else {
        // Si aucun paramètre ou valeur inconnue, tu lances les deux
        await immonotScraper();
        await kermarrecScraper();
        await eraScraper();
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
