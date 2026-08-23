import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://nestenn.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

// Nestenn (marque locale "Avis Immobilier") fait une recherche par rayon autour de la
// ville demandée (constaté : les résultats pour "vitre-35500" incluent des communes
// voisines comme Louvigné-de-Bais) — la whitelist de villes (VILLES dans db.js) filtre
// naturellement ce qui n'est pas une de nos 5 communes, comme pour tout autre scraper.
async function scrapeListPage(slug) {
  const html = await fetchHtml(`${BASE_URL}/vente/maison/${slug}`);
  const $ = cheerio.load(html);
  const links = new Set();
  $("a[href^='maison-'], a[href^='immeuble-']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.add(`${BASE_URL}/vente/maison/${slug}/${href}`);
  });
  return [...links];
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Le dernier élément du fil d'Ariane donne la ville et le type de bien de façon fiable
  // (le titre affiché mêle parfois des adjectifs marketing avant le nom de la ville).
  const breadcrumbText = $(".breadcrumb_container li").last().text().trim();
  const bcMatch = breadcrumbText.match(/Vente\s+(Maison|Appartement|Immeuble)\s+(.+?)\s*\((\d{5})\)/i);
  const typeRaw = bcMatch?.[1] || "";
  const type = /maison/i.test(typeRaw) ? "Maison" : /immeuble/i.test(typeRaw) ? "Immeuble" : null;
  const ville = bcMatch?.[2]?.trim() || "";

  const prix = parseInt(($(".titre1").first().text() || "").replace(/[^\d]/g, "")) || 0;

  const critere = (label) => {
    let val = 0;
    $(".cracteristiques").each((_, el) => {
      if ($(el).text().trim().toLowerCase() === label) {
        val = parseInt($(el).prev(".titre2").text()) || 0;
      }
    });
    return val;
  };
  const pieces = critere("pièces");
  const chambres = critere("chambres");
  const surface = critere("habitables");

  const legales = $("#mentions_legales").text();
  const dpe = legales.match(/DPE\s*:\s*([A-G])\b/)?.[1] || null;
  const ges = legales.match(/GES\s*:\s*([A-G])\b/)?.[1] || null;

  const description = $(".description").first().text().replace(/\s+/g, " ").trim();

  // Les vignettes appartiennent à cette annonce si leur URL contient sa référence (les
  // suggestions "biens similaires" plus bas dans la page utilisent d'autres références).
  const ref = url.match(/ref-(\d+)$/)?.[1];
  const photos = ref
    ? [...new Set($(`img[src*="/${ref}"]`).map((_, el) => $(el).attr("src")).get())]
    : [];

  return { type, ville, prix, pieces, chambres, surface, dpe, ges, description, photos };
}

export const nestennScraper = async () => {
  const villeRows = await getVilleParams("nestenn");
  if (!villeRows.length) {
    console.warn("⚠️ Nestenn - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];
  const liensVus = new Set();

  for (const row of villeRows) {
    let links;
    try {
      links = await scrapeListPage(row.params.slug);
    } catch (err) {
      console.error(`❌ Nestenn - Erreur sur la page de liste (${row.nom}): ${err.message}`);
      await insertErreur("Nestenn", row.nom, String(err));
      continue;
    }
    console.log(`📌 Nestenn - ${row.nom} : ${links.length} annonces trouvées.`);

    for (const url of links) {
      if (liensVus.has(url)) continue; // recherche par rayon : chevauchement entre villes voisines
      liensVus.add(url);
      try {
        const data = await scrapeDetailPage(url);
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
            dpe: data.dpe,
            ges: data.ges,
            agence: "Nestenn",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Nestenn - Données incomplètes pour ${url}`);
          await insertErreur("Nestenn", url, "Données incomplètes (ville, type ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Nestenn - Erreur sur ${url}: ${err.message}`);
        await insertErreur("Nestenn", url, String(err));
      }
    }
  }

  await deleteMissingAnnonces("Nestenn", [...new Set(liensActuels)]);
  console.log("✅ Nestenn - Scraping terminé !");
};
