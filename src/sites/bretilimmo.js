import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, insertAnnonceLocation, deleteMissingAnnoncesLocation, getVilleParams } from "../db.js";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

function normalize(str) {
  return str.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

// Le paramètre type_bien n'est pas respecté côté serveur (les résultats mélangent tous les
// types), et le paramètre localisation[] non plus (constaté : une recherche filtrée sur une
// seule ville renvoie quand même un mélange de communes du secteur) : le filtre par
// type/ville/budget se fait donc entièrement côté client, comme pour la vente.
// validCitySlugs : fragments (pas le nom complet) servant à reconnaître chaque ville dans le
// texte affiché, volontairement courts pour tolérer les coquilles côté site (constaté :
// "Noyal sur Vialine" au lieu de "Noyal sur Vilaine" dans leurs propres données — le
// fragment "noyal" reste correct dans les deux cas).
async function scrapeListPage(url, validTypes = ["maison", "immeuble"], maxBudget = 400000, validCitySlugs = ["vitre"]) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = new Set();
  $("a[href*='/propriete/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!href) return;

    const typeSlug = href.match(/\/propriete\/([^-]+)/)?.[1] || "";
    // Casse observée variable ("VITRE" ou "Vitre" selon les biens) : /i pour ne pas rater
    // les noms de ville en casse mixte (bug préexistant qui faisait tout rejeter en silence)
    const cityMatch = text.match(/[—–]([A-ZÉÀÈÙÂÊÎÔÛÄËÏÖÜ\s]+?)(\d)/i);
    const city = cityMatch?.[1]?.trim() || "";
    // "245 000 €" en vente, "600 €/mois" en location
    const priceMatch = text.match(/([\d\s]+)\s*€(?:\/mois)?\s*$/);
    const prix = parseInt((priceMatch?.[1] || "0").replace(/\s/g, "")) || 0;

    const isValidType = validTypes.includes(typeSlug);
    const isValidCity = validCitySlugs.some((slug) => normalize(city).includes(normalize(slug)));
    const isInBudget = prix <= maxBudget && prix > 0;

    if (isValidType && isValidCity && isInBudget) {
      links.add(`https://bretilimmo.com${href}`);
    }
  });

  // Site rebuilt in Next.js — no server-side pagination in filter results
  return { links: [...links], nextUrl: null };
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  let jsonLd = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data["@type"] === "RealEstateListing") jsonLd = data;
    } catch {}
  });

  const typeSlug = url.match(/\/propriete\/([^-]+)/)?.[1] || "";
  const type = typeSlug.charAt(0).toUpperCase() + typeSlug.slice(1) || "Non spécifié";

  const prix = jsonLd?.offers?.price ? parseInt(jsonLd.offers.price) : 0;
  const ville = jsonLd?.address?.addressLocality || "";
  const surface = jsonLd?.floorSize?.value ? parseFloat(jsonLd.floorSize.value) : 0;
  const pieces = jsonLd?.numberOfRooms ? parseInt(jsonLd.numberOfRooms) : 0;
  const description = jsonLd?.description || "";

  const photos = [];
  $("img").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || "";
    const match = src.match(/[?&]url=([^&]+)/);
    if (match) {
      const decoded = decodeURIComponent(match[1]);
      if (decoded.startsWith("http") && !photos.includes(decoded)) photos.push(decoded);
    }
  });

  return { type, prix, ville, surface, pieces, chambres: 0, description, photos };
}

export const bretilimmoLocationScraper = async () => {
  const villeRows = await getVilleParams("bretilimmo");
  if (!villeRows.length) {
    console.warn("⚠️ Bretil'Immo (location) - Aucune ville configurée en base");
    return;
  }
  const locParams = villeRows.map(r => `localisation%5B%5D=${r.params.slug}`).join("&");
  const validCitySlugs = villeRows.map((r) => r.params.slug);
  const LIST_URL =
    `https://bretilimmo.com/location?sort=&type_bien%5B%5D=appartement` +
    `&${locParams}&pieces=&chambres=&minBudget=&maxBudget=&minSurface=&maxSurface=&minTerrain=&maxTerrain=&reference=&submit=`;

  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 Bretil'Immo (location) - Page de liste : ${currentUrl}`);
    // Pas de plafond de budget pertinent pour un loyer ; on ne garde que le type "appartement"
    const { links, nextUrl } = await scrapeListPage(currentUrl, ["appartement"], Infinity, validCitySlugs);
    console.log(`📌 Bretil'Immo (location) - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Bretil'Immo (location) - Page détail : ${url}`);
        const data = await scrapeDetailPage(url);

        if (data.ville && data.prix) {
          await insertAnnonceLocation({
            type: "Appartement",
            loyer: data.prix,
            ville: data.ville,
            pieces: data.pieces,
            surface: data.surface,
            description: data.description,
            photos: data.photos,
            agence: "Bretil'Immo",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Bretil'Immo (location) - Données incomplètes pour ${url}`);
          await insertErreur("Bretil'Immo (location)", url, "Données incomplètes (ville ou loyer manquant)");
        }
      } catch (err) {
        console.error(`❌ Bretil'Immo (location) - Erreur sur ${url}:`, err.message);
        await insertErreur("Bretil'Immo (location)", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnoncesLocation("Bretil'Immo", Array.from(new Set(liensActuels)));
  console.log("✅ Bretil'Immo (location) - Scraping terminé !");
};

export const bretilimmoScraper = async () => {
  const villeRows = await getVilleParams("bretilimmo");
  if (!villeRows.length) {
    console.warn("⚠️ Bretil'Immo - Aucune ville configurée en base");
    return;
  }
  const locParams = villeRows.map(r => `localisation%5B%5D=${r.params.slug}`).join("&");
  const validCitySlugs = villeRows.map((r) => r.params.slug);
  const LIST_URL =
    `https://bretilimmo.com/a-vendre?sort=&type_bien%5B%5D=immeuble&type_bien%5B%5D=maison-villa` +
    `&${locParams}&pieces=&chambres=&minBudget=&maxBudget=400000&minSurface=&maxSurface=&minTerrain=&maxTerrain=&reference=&submit=`;

  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 Bretil'Immo - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl, ["maison", "immeuble"], 400000, validCitySlugs);
    console.log(`📌 Bretil'Immo - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Bretil'Immo - Page détail : ${url}`);
        const data = await scrapeDetailPage(url);

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
            agence: "Bretil'Immo",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Bretil'Immo - Données incomplètes pour ${url}`);
          await insertErreur("Bretil'Immo", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Bretil'Immo - Erreur sur ${url}:`, err.message);
        await insertErreur("Bretil'Immo", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("Bretil'Immo", Array.from(new Set(liensActuels)));
  console.log("✅ Bretil'Immo - Scraping terminé !");
};
