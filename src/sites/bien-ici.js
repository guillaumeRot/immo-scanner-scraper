import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

const ZONE_IDS = ["-106682", "-6837759"]; // Vitré 35500, Châteaugiron 35410
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.bienici.com/",
  "Accept": "application/json",
};

async function fetchPage(from, size = 100) {
  const filters = {
    size, from,
    filterType: "buy",
    propertyType: ["house", "building"],
    maxPrice: 400000,
    zoneIdsByTypes: { zoneIds: ZONE_IDS },
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
  const prix = ad.price || 0;
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

export const bienIciScraper = async () => {
  const liensActuels = [];
  const size = 100;
  let from = 0;
  let total = Infinity;

  while (from < total) {
    const json = await fetchPage(from, size);
    total = json.total;
    const ads = json.realEstateAds || [];
    console.log(`📌 Bien-ici - ${from + ads.length}/${total} annonces récupérées`);

    for (const ad of ads) {
      const lien = `https://www.bienici.com/annonce/${ad.id}`;
      try {
        const data = parseAd(ad);
        if (data.ville && data.prix) {
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
    if (ads.length < size) break;
  }

  await deleteMissingAnnonces("Bien-ici", [...new Set(liensActuels)]);
  console.log("✅ Bien-ici - Scraping terminé !");
};
