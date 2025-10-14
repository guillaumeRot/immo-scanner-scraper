import 'dotenv/config';
import express from 'express';
import { closeDb, initDb } from './db.js';
import { immonotScraper } from './sites/immonot.js';
import { kermarrecScraper } from './sites/kermarrec.js';
const app = express();

// Évite les exécutions concurrentes
let isScrapeRunning = false;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Scraper API en ligne 🚀' });
});

async function runScrapersSequentially() {
    console.log(`🚀 [Handler] Dans runScrapersSequentially`);
    if (isScrapeRunning) {
        console.log(`🚀 [Handler] Scrapers déjà en cours.`);
        return;
    }
    isScrapeRunning = true;
    try {
        console.log(`🚀 [Handler] Dans try`);
        initDb();
        immonotScraper();
        kermarrecScraper();
        closeDb();
    } catch (err) {
      console.error("Erreur lors de l'exécution des scrapers:", err);
    } finally {
      isScrapeRunning = false;
    }
  }

app.get('/run-scrapers', async (req, res) => {
    console.log(`📩 [Handler] Appel reçu !`);
    if (isScrapeRunning) {
        return res.status(409).json({
          status: "already_running",
          message: "Un scraping est déjà en cours. Réessayez plus tard.",
        });
    }

    try {
        setImmediate(() => {
            runScrapersSequentially();
        });
  
      res.json({ status: "started", message: "Scrapers démarrés en arrière-plan (séquentiel)." });
    } catch (e) {
      console.error("❌ Erreur dans /run-scrapers:", e);
      res.json({ status: "error", message: e.message });
    }
  });

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`✅ API active sur port ${port}`));
