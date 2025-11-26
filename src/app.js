import 'dotenv/config';
import express from 'express';
import { closeDb, initDb, updateScanTable } from './db.js';
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
import { bienIciScraper } from './sites/bien-ici.js';
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
      const startTime = Date.now();
      await initDb();

      if (scraper === "immonot") {
        await immonotScraper();
        await updateScanTable("Immonot", startTime);
      } else if (scraper === "kermarrec") {
        await kermarrecScraper();
        await updateScanTable("Kermarrec", startTime);
      } else if (scraper === "era") {
        await eraScraper();
        await updateScanTable("ERA", startTime);
      } else if (scraper === "blot") {
        await blotScraper();
        await updateScanTable("Blot", startTime);
      } else if (scraper === "carnot") {
        await carnotScraper();
        await updateScanTable("Carnot", startTime);
      } else if (scraper === "diard") {
        await diardScraper();
        await updateScanTable("Diard", startTime);
      } else if (scraper === "penn") {
        await pennScraper();
        await updateScanTable("Penn", startTime);
      } else if (scraper === "century") {
        await centuryScraper();
        await updateScanTable("Century 21", startTime);
      } else if (scraper === "bretilimmo") {
        await bretilimmoScraper();
        await updateScanTable("Bretil'Immo", startTime);
      } else if (scraper === "boyer") {
        await boyerScraper();
        await updateScanTable("Boyer Immobilier", startTime);
      } else if (scraper === "notaires-bretons") {
        await notairesBretonsScraper();
        await updateScanTable("Notaires et Bretons", startTime);
      } else if (scraper === "immobilier-notaires") {
        await immobilierNotairesScraper();
        await updateScanTable("Immobilier Notaires", startTime);
      } else if (scraper === "figaro-immobilier") {
        await figaroImmobilierScraper();
        await updateScanTable("Figaro Immobilier", startTime);
      } else if (scraper === "acheter-louer") {
        await acheterLouerScraper();
        await updateScanTable("Acheter-louer", startTime);
      } else if (scraper === "bien-ici") {
        await bienIciScraper();
        await updateScanTable("Bien-ici", startTime);
      } else {
        // Liste des scrapers avec leurs noms d'API
        const scrapers = [
          { name: "kermarrec", displayName: "Kermarrec" },
          { name: "era", displayName: "ERA" },
          { name: "blot", displayName: "Blot" },
          { name: "carnot", displayName: "Carnot" },
          { name: "penn", displayName: "Penn" },
          { name: "diard", displayName: "Diard" },
          { name: "century", displayName: "Century 21" },
          { name: "bretilimmo", displayName: "Bretil'Immo" },
          { name: "boyer", displayName: "Boyer Immobilier" },
          { name: "notaires-bretons", displayName: "Notaires et Bretons" },
          { name: "immobilier-notaires", displayName: "Immobilier Notaires" },
          { name: "figaro-immobilier", displayName: "Figaro Immobilier" },
          { name: "acheter-louer", displayName: "Acheter-louer" },
          { name: "immonot", displayName: "Immonot" }
        ];

        // Exécution séquentielle des appels HTTP pour chaque scraper
        for (const { name, displayName } of scrapers) {
          try {
            console.log(`🚀 Démarrage du scraper ${displayName}...`);
            const response = await fetch(`https://immo-scanner-scraper-guillaumerot6122-pcw8vwdygmnc2g.leapcell-async.dev/run-scrapers?scraper=${name}`);
            const data = await response.json();
            console.log(`✅ Réponse de l'API pour ${displayName}:`, data);
            await updateScanTable(displayName, startTime);
          } catch (error) {
            console.error(`❌ Erreur lors de l'appel à l'API pour ${displayName}:`, error);
            // On continue avec le scraper suivant même en cas d'erreur
          }
        }

        // Mise à jour pour le scan complet "all"
        await updateScanTable("All", startTime);
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
