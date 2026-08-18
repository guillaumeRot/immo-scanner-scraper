import { deleteMissingAnnonces, insertAnnonce, insertErreur, insertAnnonceLocation, deleteMissingAnnoncesLocation, getVilleParams } from "../db.js";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.bienici.com/",
  "Accept": "application/json",
};

async function fetchPage(from, zoneIds, size = 100) {
  const filters = {
    size, from,
    filterType: "buy",
    propertyType: ["house", "building"],
    maxPrice: 400000,
    zoneIdsByTypes: { zoneIds },
    sortBy: "publicationDate",
    sortOrder: "desc",
  };
  const url = `https://www.bienici.com/realEstateAds.json?filters=${encodeURIComponent(JSON.stringify(filters))}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on realEstateAds.json`);
  return res.json();
}

function parseAd(ad) {
  const type = ad.propertyType === "building" ? "immeuble" : "maison";
  // Programmes neufs à plusieurs lots : ad.price peut être un tableau [min, max] au lieu
  // d'un nombre — sans ça, pg sérialise le tableau JS en littéral Postgres "{123,NULL}"
  // et corrompt la colonne (constaté en base : prix = '{"328515",NULL}').
  const prix = (Array.isArray(ad.price) ? ad.price[0] : ad.price) || 0;
  const ville = ad.city || "";
  const surface = ad.surfaceArea || 0;
  const pieces = ad.roomsQuantity || 0;
  const chambres = ad.bedroomsQuantity || 0;
  const description = (ad.description || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
  const photos = (ad.photos || []).map(p => p.url || p.url_photo).filter(Boolean);
  const dpe = ad.energyClassification || null;
  const ges = ad.greenhouseGazClassification || null;
  return { type, prix, ville, surface, pieces, chambres, description, photos, dpe, ges };
}

async function fetchLocationPage(from, zoneIds, size = 100) {
  const filters = {
    size, from,
    filterType: "rent",
    propertyType: ["flat"],
    zoneIdsByTypes: { zoneIds },
    sortBy: "publicationDate",
    sortOrder: "desc",
  };
  const url = `https://www.bienici.com/realEstateAds.json?filters=${encodeURIComponent(JSON.stringify(filters))}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on realEstateAds.json`);
  return res.json();
}

// BienIci agrège les annonces de nombreuses agences : la même maison peut apparaître
// plusieurs fois (une par portail/agent), ce qui gonfle vite le total par zone (constaté :
// >1500 annonces pour une commune de moins de 20 000 habitants). Trier par date de
// publication et plafonner à quelques pages par ville suffit à couvrir l'activité récente
// sans dépasser la limite de durée d'une fonction serverless (chaque zone est interrogée
// séparément pour que les deux villes soient couvertes équitablement).
// Plafond cron-job.org (30s, non modifiable) plus strict que celui de Vercel (60s) :
// à 5 pages/ville la version vente tournait à ~23s, marge trop faible → réduit à 3.
const MAX_PAGES_PAR_VILLE = 3;

export const bienIciScraper = async () => {
  const villeRows = await getVilleParams("bienici");
  if (!villeRows.length) {
    console.warn("⚠️ Bien-ici - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];
  const size = 100;
  // Cf. version location : une même agence republie parfois le même bien sous plusieurs
  // ids distincts (jusqu'à 13 fois vu en pratique) — on ne garde qu'une occurrence par
  // empreinte pour éviter des dizaines d'écritures DB inutiles (source du dépassement des
  // 30s de timeout cron-job.org sur ce scraper).
  const empreintesVues = new Set();

  for (const row of villeRows) {
    const zoneIds = [row.params.zone_id];
    let from = 0;
    let total = Infinity;
    let page = 0;

    while (from < total && page < MAX_PAGES_PAR_VILLE) {
      let json;
      try {
        json = await fetchPage(from, zoneIds, size);
      } catch (err) {
        // L'API refuse de paginer au-delà d'un certain offset ("Too many ads requested") :
        // on s'arrête proprement avec ce qu'on a déjà récupéré plutôt que de planter le scraper.
        console.warn(`⚠️ Bien-ici - Pagination interrompue à from=${from}: ${err.message}`);
        break;
      }
      total = json.total;
      const ads = json.realEstateAds || [];
      console.log(`📌 Bien-ici - ${row.nom} : ${from + ads.length}/${total} annonces récupérées`);

      for (const ad of ads) {
        const lien = `https://www.bienici.com/annonce/${ad.id}`;
        try {
          const data = parseAd(ad);
          const empreinte = `${data.ville}|${data.prix}|${data.surface}|${data.pieces}|${data.description}`;
          if (empreintesVues.has(empreinte)) continue;
          if (data.ville && data.prix) {
            empreintesVues.add(empreinte);
            await insertAnnonce({
              type: data.type,
              prix: data.prix,
              ville: data.ville,
              pieces: data.pieces,
              chambres: data.chambres,
              surface: data.surface,
              description: data.description,
              photos: data.photos,
              dpe: data.dpe,
              ges: data.ges,
              agence: "Bien-ici",
              lien,
            });
            liensActuels.push(lien);
          } else {
            console.warn(`⚠️ Bien-ici - Données incomplètes pour ${lien}`);
            await insertErreur("Bien-ici", lien, "Données incomplètes (ville ou prix manquant)");
          }
        } catch (err) {
          console.error(`❌ Bien-ici - Erreur sur ${lien}: ${err.message}`);
          await insertErreur("Bien-ici", lien, String(err));
        }
      }

      from += size;
      page++;
      if (ads.length < size) break;
    }
  }

  await deleteMissingAnnonces("Bien-ici", [...new Set(liensActuels)]);
  console.log("✅ Bien-ici - Scraping terminé !");
};

export const bienIciLocationScraper = async () => {
  const villeRows = await getVilleParams("bienici");
  if (!villeRows.length) {
    console.warn("⚠️ Bien-ici (location) - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];
  const size = 100;
  // Certaines agences republient le même logement (même résidence, lot identique) sous
  // plusieurs ids d'annonce distincts — jusqu'à 13 fois vu en pratique. On ne garde que
  // la première occurrence par empreinte (ville+loyer+surface+pieces+description) pour
  // éviter de saturer les résultats avec des doublons quasi identiques.
  const empreintesVues = new Set();
  let horsMarcheIgnorees = 0;

  for (const row of villeRows) {
    const zoneIds = [row.params.zone_id];
    let from = 0;
    let total = Infinity;
    let page = 0;

    while (from < total && page < MAX_PAGES_PAR_VILLE) {
      let json;
      try {
        json = await fetchLocationPage(from, zoneIds, size);
      } catch (err) {
        console.warn(`⚠️ Bien-ici (location) - Pagination interrompue à from=${from}: ${err.message}`);
        break;
      }
      total = json.total;
      const ads = json.realEstateAds || [];
      console.log(`📌 Bien-ici (location) - ${row.nom} : ${from + ads.length}/${total} annonces récupérées`);

      for (const ad of ads) {
        // Sur la zone Vitré/Châteaugiron, l'index location de Bien-ici contient énormément
        // d'annonces retirées (constaté : ~99% avec status.onTheMarket=false et une
        // publicationDate à l'epoch Unix 1970-01-01, contre des dates fraîches et un ratio
        // normal sur d'autres zones comme Rennes ou Paris) : le lien mène alors à une fiche
        // qui n'existe plus. On ne garde que les annonces explicitement encore sur le marché.
        if (ad.status?.onTheMarket !== true) {
          horsMarcheIgnorees++;
          continue;
        }
        const lien = `https://www.bienici.com/annonce/${ad.id}`;
        try {
          const data = parseAd(ad);
          const empreinte = `${data.ville}|${data.prix}|${data.surface}|${data.pieces}|${data.description}`;
          if (empreintesVues.has(empreinte)) continue;
          if (data.ville && data.prix) {
            empreintesVues.add(empreinte);
            await insertAnnonceLocation({
              type: "Appartement",
              loyer: data.prix,
              ville: data.ville,
              pieces: data.pieces,
              surface: data.surface,
              description: data.description,
              photos: data.photos,
              dpe: data.dpe,
              ges: data.ges,
              agence: "Bien-ici",
              lien,
            });
            liensActuels.push(lien);
          } else {
            console.warn(`⚠️ Bien-ici (location) - Données incomplètes pour ${lien}`);
            await insertErreur("Bien-ici (location)", lien, "Données incomplètes (ville ou loyer manquant)");
          }
        } catch (err) {
          console.error(`❌ Bien-ici (location) - Erreur sur ${lien}: ${err.message}`);
          await insertErreur("Bien-ici (location)", lien, String(err));
        }
      }

      from += size;
      page++;
      if (ads.length < size) break;
    }
  }

  console.log(`ℹ️ Bien-ici (location) - ${horsMarcheIgnorees} annonces hors marché ignorées.`);
  await deleteMissingAnnoncesLocation("Bien-ici", [...new Set(liensActuels)]);
  console.log("✅ Bien-ici (location) - Scraping terminé !");
};
