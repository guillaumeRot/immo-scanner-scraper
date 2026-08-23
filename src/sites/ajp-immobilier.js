import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://www.ajp-immobilier.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

// Comme Cornier Immobilier, le site n'a pas de recherche par ville exploitable en
// fetch+cheerio, mais le sitemap.xml liste individuellement toutes les annonces actives
// (plus de 5800 URLs) — on peut donc filtrer directement dessus plutôt que reproduire une
// recherche.
async function fetchSitemapLinks(slugs) {
  const xml = await fetchHtml(`${BASE_URL}/sitemap.xml`);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return locs.filter(
    (url) =>
      /\/annonces\/achat\/(maison|immeuble)\//.test(url) &&
      slugs.some((slug) => url.includes(`/${slug}/`))
  );
}

const OFF_MARKET_MARKERS = /^(SOUS COMPROMIS|VENDU|COMPROMIS SIGN[EÉ]|OFFRE ACCEPT[EÉ]E)/i;

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const h1 = $("h1").first().text().trim();
  const m = h1.match(/Vente\s+(maison|immeuble|appartement)\s+(.+?)\s*:/i);
  const typeRaw = m?.[1]?.toLowerCase() || "";
  const type = typeRaw === "maison" ? "Maison" : typeRaw === "immeuble" ? "Immeuble" : null;
  const ville = m?.[2]?.trim() || "";

  const prix = parseInt(($(".ajp-blue.h2").first().text() || "").replace(/[^\d]/g, "")) || 0;

  const critere = (iconName) => {
    const img = $(`img[data-src*="${iconName}"], img[src*="${iconName}"]`).first();
    return parseInt(img.next(".amount").text().replace(/[^\d]/g, "")) || 0;
  };
  const surface = critere("dimensions-icon");
  const pieces = critere("rooms-icon");
  const chambres = critere("bedrooms-icon");

  const description = $("p.light").first().text().trim();
  const horsMarche = OFF_MARKET_MARKERS.test(description) || OFF_MARKET_MARKERS.test(h1);

  const photos = [...new Set($(".carousel-item img").map((_, el) => $(el).attr("src")).get())];

  return { type, ville, prix, surface, pieces, chambres, description, photos, horsMarche };
}

export const ajpImmobilierScraper = async () => {
  const villeRows = await getVilleParams("ajp-immobilier");
  if (!villeRows.length) {
    console.warn("⚠️ AJP Immobilier - Aucune ville configurée en base");
    return;
  }
  const slugs = villeRows.map((r) => r.params.slug);

  let links;
  try {
    links = await fetchSitemapLinks(slugs);
  } catch (err) {
    console.error(`❌ AJP Immobilier - Erreur sur le sitemap: ${err.message}`);
    await insertErreur("AJP Immobilier", `${BASE_URL}/sitemap.xml`, String(err));
    return;
  }
  console.log(`📌 AJP Immobilier - ${links.length} annonces trouvées.`);

  const liensActuels = [];
  let horsMarcheIgnorees = 0;

  for (const url of links) {
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
          agence: "AJP Immobilier",
          lien: url,
        });
        liensActuels.push(url);
      } else {
        console.warn(`⚠️ AJP Immobilier - Données incomplètes pour ${url}`);
        await insertErreur("AJP Immobilier", url, "Données incomplètes (ville, type ou prix manquant)");
      }
    } catch (err) {
      console.error(`❌ AJP Immobilier - Erreur sur ${url}: ${err.message}`);
      await insertErreur("AJP Immobilier", url, String(err));
    }
  }

  console.log(`ℹ️ AJP Immobilier - ${horsMarcheIgnorees} annonces hors marché ignorées (sous compromis/vendu).`);
  await deleteMissingAnnonces("AJP Immobilier", [...new Set(liensActuels)]);
  console.log("✅ AJP Immobilier - Scraping terminé !");
};
