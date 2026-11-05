#!/usr/bin/env node
// Script autonome de scraping — exécuté par GitHub Actions (workflows scrape-hourly.yml et
// scrape-full-daily.yml) et utilisable en local pour du debug. Reprend la logique qui
// tournait dans src/app.js (/run-scrapers et /refresh-prix), sans les contournements
// nécessaires côté Vercel (waitUntil, découpage en une requête HTTP par scraper) : un run
// GitHub Actions n'a pas de plafond de durée par requête, tout tourne en une seule fois
// dans le même process.
//
// Usage :
//   node scripts/scrape.js                      → run incrémental, tous les scrapers
//   node scripts/scrape.js --full                → rafraîchissement complet (ignore LienVu)
//   node scripts/scrape.js --only=era,kermarrec   → limite à une liste de scrapers (debug)
import 'dotenv/config';
import { initDb, closeDb, updateScanTable, insertErreur, avecRafraichissementComplet } from '../src/db.js';
import { SCRAPERS, SANS_RAFRAICHISSEMENT } from '../src/scrapers-registry.js';

const args = process.argv.slice(2);
const full = args.includes('--full');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg
  ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : null;

async function main() {
  await initDb();

  let noms = Object.keys(SCRAPERS);
  if (only) {
    const inconnus = only.filter((n) => !SCRAPERS[n]);
    if (inconnus.length > 0) {
      throw new Error(`Scraper(s) inconnu(s): ${inconnus.join(', ')}`);
    }
    noms = only;
  }
  // Même logique que /refresh-prix : ces scrapers n'ont pas de fiche détail à rafraîchir,
  // leurs données viennent directement de la page liste (déjà à jour à chaque run).
  if (full) {
    noms = noms.filter((n) => !SANS_RAFRAICHISSEMENT.has(n));
  }

  console.log(`🚀 Lancement de ${noms.length} scraper(s)${full ? " (rafraîchissement complet)" : ""}...`);

  for (const nom of noms) {
    const { fn, displayName } = SCRAPERS[nom];
    const startTime = Date.now();
    try {
      console.log(`\n🚀 Démarrage du scraper ${displayName}...`);
      await (full ? avecRafraichissementComplet(fn) : fn());
      await updateScanTable(displayName, startTime);
    } catch (err) {
      // Une erreur sur UN scraper ne doit jamais interrompre les autres — même
      // comportement que l'ancien /run-scrapers sans paramètre.
      console.error(`❌ Erreur lors du scraper ${displayName}:`, err);
      try {
        await insertErreur(displayName, "RUN", String(err));
      } catch (_) {
        // rien à faire de plus si même l'enregistrement de l'erreur échoue
      }
    }
  }

  console.log(`\n✅ Terminé : ${noms.length} scraper(s) traité(s).`);
  await closeDb();
}

main().catch(async (err) => {
  // Une erreur ici est fatale (ex: DB inaccessible au démarrage) — contrairement aux erreurs
  // par scraper ci-dessus, celle-ci doit faire échouer le run GitHub Actions.
  console.error("❌ Erreur fatale:", err);
  try {
    await closeDb();
  } catch (_) {
    // rien à faire de plus
  }
  process.exitCode = 1;
});
