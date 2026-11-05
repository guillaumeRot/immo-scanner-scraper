// Logique des notifications email, partagée entre src/app.js (routes HTTP, filet de secours
// manuel) et scripts/notify.js (exécution planifiée via GitHub Actions).
import {
  claimUnnotifiedErreurs,
  purgeOldErreurs,
  getRecherchesActives,
  getMaxAnnonceId,
  getAnnoncesCorrespondantes,
  mettreAJourCurseurRecherche,
} from './db.js';
import { sendRechercheAlerteEmail, sendErrorReportEmail } from './email.js';

/**
 * Pour chaque recherche sauvegardée active (comptes utilisateurs, cf. docs/comptes-alertes.md
 * dans scraper-immo), regarde s'il y a de nouvelles annonces correspondant à ses critères
 * depuis son dernier passage et, si oui, envoie un email récapitulatif à l'utilisateur
 * propriétaire de cette recherche.
 */
export async function traiterNotificationsRecherches(typeTransaction) {
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

/**
 * Envoie le rapport des erreurs de scraping pas encore notifiées, puis purge les anciennes
 * erreurs déjà notifiées (cf. purgeOldErreurs).
 */
export async function envoyerRapportErreurs() {
  const erreurs = await claimUnnotifiedErreurs();
  await sendErrorReportEmail(erreurs);
  // Purge à chaque passage plutôt que sur un déclencheur dédié : ce rapport tourne déjà
  // régulièrement, pas besoin d'un déclencheur de plus pour ça.
  const supprimees = await purgeOldErreurs();
  return { notifiees: erreurs.length, supprimees };
}
