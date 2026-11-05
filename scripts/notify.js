#!/usr/bin/env node
// Script autonome de notification — exécuté par GitHub Actions (workflows notify-ventes.yml,
// notify-locations.yml, notify-errors.yml) et utilisable en local pour du debug. Reprend la
// logique qui tournait dans src/app.js (/send-notifications-ventes, /send-notifications-
// locations, /send-error-report).
//
// Usage : node scripts/notify.js <ventes|locations|errors>
import 'dotenv/config';
import { initDb, closeDb } from '../src/db.js';
import { traiterNotificationsRecherches, envoyerRapportErreurs } from '../src/notifications.js';

const MODES = ['ventes', 'locations', 'errors'];
const mode = process.argv[2];

async function main() {
  if (!MODES.includes(mode)) {
    throw new Error(`Usage: node scripts/notify.js <${MODES.join('|')}>`);
  }

  await initDb();

  if (mode === 'ventes') {
    const r = await traiterNotificationsRecherches('vente');
    console.log(`✅ ${r.annoncesEnvoyees} vente(s) notifiée(s) sur ${r.recherchesNotifiees}/${r.recherches} recherche(s) active(s).`);
  } else if (mode === 'locations') {
    const r = await traiterNotificationsRecherches('location');
    console.log(`✅ ${r.annoncesEnvoyees} location(s) notifiée(s) sur ${r.recherchesNotifiees}/${r.recherches} recherche(s) active(s).`);
  } else {
    const r = await envoyerRapportErreurs();
    console.log(`✅ ${r.notifiees} erreur(s) notifiée(s), ${r.supprimees} ancienne(s) supprimée(s).`);
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error("❌ Erreur fatale:", err);
  try {
    await closeDb();
  } catch (_) {
    // rien à faire de plus
  }
  process.exitCode = 1;
});
