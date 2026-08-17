import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://www.squarehabitat.fr";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// Pas de sitemap "achat-immeuble" chez Square Habitat (seulement appartement/maison) :
// seul le type "maison" est couvert ici. La page ville (issue du sitemap
// achat-maison-localisation.xml) n'est pas concernée par leur robots.txt, qui bloque
// uniquement /resultat-achat, /resultat-location et les anciennes pages .aspx.

function normalize(str) {
  return str.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

// La page ville fait une recherche à rayon large (communes voisines incluses, comme
// Bretil'Immo/Blot) : on ne garde que les liens dont le segment ville correspond exactement.
async function scrapeListPage(url, villeSlug) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = new Set();
  $("a[href*='/annonces/biens/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/\/maison\/([^/]+)\//);
    const citySlug = match?.[1] || "";
    if (normalize(citySlug) === normalize(villeSlug)) {
      links.add(href.startsWith("http") ? href : `${BASE_URL}${href}`);
    }
  });

  return [...links];
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  let main = null;
  let priceSpec = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data.address && data.description) main = data;
      if (data["@type"] === "UnitPriceSpecification") priceSpec = data;
    } catch {}
  });

  const prix = priceSpec?.price ? parseInt(priceSpec.price) : 0;
  const villeRaw = main?.address?.addressLocality || "";
  // Format observé : "VITRE 35500" -> garder juste le nom de ville
  const ville = villeRaw.replace(/\s*\d{5}\s*$/, "").trim();
  const surface = main?.floorSize?.value ? parseFloat(main.floorSize.value) : 0;
  const pieces = main?.numberOfRooms ? parseInt(main.numberOfRooms) : 0;
  const description = main?.description || "";

  // Le DPE est mentionné en texte libre dans la description ("Classe énergie : D")
  const dpeMatch = description.match(/[Cc]lasse\s+[ée]nerg[ei]e?\s*:?\s*([A-G])\b/);
  const gesMatch = description.match(/[Cc]lasse\s+(?:GES|climat)\s*:?\s*([A-G])\b/i);

  const photos = [];
  for (const m of html.matchAll(/https:\/\/www\.squarehabitat\.fr\/medias\/biens\/l\/[a-f0-9-]+\.webp/gi)) {
    if (!photos.includes(m[0])) photos.push(m[0]);
  }

  return {
    type: "Maison",
    prix,
    ville,
    surface,
    pieces,
    description,
    photos,
    dpe: dpeMatch?.[1] || null,
    ges: gesMatch?.[1] || null,
  };
}

export const squareHabitatScraper = async () => {
  const villeRows = await getVilleParams("square-habitat");
  if (!villeRows.length) {
    console.warn("⚠️ Square Habitat - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];

  for (const row of villeRows) {
    const listUrl = `${BASE_URL}/annonces/achat/bien/maison/immobilier/${row.params.region}/${row.params.slug}`;
    console.log(`🔎 Square Habitat - Page de liste : ${listUrl}`);

    let links;
    try {
      links = await scrapeListPage(listUrl, row.params.villeSlug);
    } catch (err) {
      console.error(`❌ Square Habitat - Erreur sur la page de liste ${listUrl}:`, err.message);
      continue;
    }
    console.log(`📌 Square Habitat - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Square Habitat - Page détail : ${url}`);
        const data = await scrapeDetailPage(url);

        if (data.ville && data.prix) {
          await insertAnnonce({
            type: data.type,
            prix: data.prix,
            ville: data.ville,
            pieces: data.pieces,
            surface: data.surface,
            description: data.description,
            photos: data.photos,
            dpe: data.dpe,
            ges: data.ges,
            agence: "Square Habitat",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Square Habitat - Données incomplètes pour ${url}`);
          await insertErreur("Square Habitat", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Square Habitat - Erreur sur ${url}:`, err.message);
        await insertErreur("Square Habitat", url, String(err));
      }
    }
  }

  await deleteMissingAnnonces("Square Habitat", Array.from(new Set(liensActuels)));
  console.log("✅ Square Habitat - Scraping terminé !");
};
