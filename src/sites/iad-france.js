import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

// iad France : premier réseau de mandataires immobiliers indépendants — un site unique
// (pas un site par mandataire) avec un vrai catalogue national.
const BASE_URL = "https://www.iadfrance.fr";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

// Une seule page par ville/type : les communes de ce projet ont peu d'annonces (moins
// d'une quinzaine constaté), pas de pagination observée à ce volume.
async function scrapeListPage(slug, type) {
  const html = await fetchHtml(`${BASE_URL}/annonces/${slug}/vente/${type}`);
  const $ = cheerio.load(html);
  const links = new Set();
  $("a[href^='/annonce/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.add(`${BASE_URL}${href}`);
  });
  return [...links];
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Bloc JSON-LD schema.org riche (SingleFamilyResidence + Offer) — bien plus fiable que
  // le titre marketing libre de l'annonce, qui mentionne parfois un lieu-dit différent du
  // nom de la commune.
  const ldRaw = $('script[data-nuxt-schema-org="true"]').first().html();
  const ld = ldRaw ? JSON.parse(ldRaw) : null;
  const graph = ld?.["@graph"] || [];

  const property = graph.find((e) => e.floorSize || e.numberOfRooms);
  const offer = graph.find((e) => e["@type"] === "Offer");
  const photos = graph.filter((e) => e["@type"] === "ImageObject").map((e) => e.url).filter(Boolean);

  const type = /\/maison-vente-/.test(url) ? "Maison" : /\/immeuble-vente-/.test(url) ? "Immeuble" : null;
  const ville = property?.address?.addressLocality || "";
  const pieces = property?.numberOfRooms || 0;
  const chambres = property?.numberOfBedrooms || 0;
  const surface = property?.floorSize?.value || 0;
  const prix = parseInt((offer?.price || "").replace(/[^\d]/g, "")) || 0;
  const description = property?.description || "";
  // schema.org standard : "https://schema.org/InStock" pour un bien toujours disponible.
  const horsMarche = !!offer?.availability && !offer.availability.includes("InStock");

  return { type, ville, prix, pieces, chambres, surface, description, photos, horsMarche };
}

export const iadFranceScraper = async () => {
  const villeRows = await getVilleParams("iad-france");
  if (!villeRows.length) {
    console.warn("⚠️ iad France - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];
  const liensVus = new Set();
  let horsMarcheIgnorees = 0;

  for (const row of villeRows) {
    for (const type of ["maison", "immeuble"]) {
      let links;
      try {
        links = await scrapeListPage(row.params.slug, type);
      } catch (err) {
        console.error(`❌ iad France - Erreur sur la page de liste (${row.nom}, ${type}): ${err.message}`);
        await insertErreur("iad France", `${row.nom} (${type})`, String(err));
        continue;
      }
      console.log(`📌 iad France - ${row.nom} (${type}) : ${links.length} annonces trouvées.`);

      for (const url of links) {
        if (liensVus.has(url)) continue;
        liensVus.add(url);
        try {
          const data = await scrapeDetailPage(url);
          if (data.horsMarche) {
            horsMarcheIgnorees++;
            continue;
          }
          if (data.ville && data.prix && data.type) {
            await insertAnnonce({
              type: data.type,
              prix: data.prix,
              ville: data.ville,
              pieces: data.pieces,
              chambres: data.chambres,
              surface: data.surface,
              description: data.description,
              photos: data.photos,
              agence: "iad France",
              lien: url,
            });
            liensActuels.push(url);
          } else {
            console.warn(`⚠️ iad France - Données incomplètes pour ${url}`);
            await insertErreur("iad France", url, "Données incomplètes (ville, type ou prix manquant)");
          }
        } catch (err) {
          console.error(`❌ iad France - Erreur sur ${url}: ${err.message}`);
          await insertErreur("iad France", url, String(err));
        }
      }
    }
  }

  console.log(`ℹ️ iad France - ${horsMarcheIgnorees} annonces hors marché ignorées.`);
  await deleteMissingAnnonces("iad France", [...new Set(liensActuels)]);
  console.log("✅ iad France - Scraping terminé !");
};
