import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://www.laforet.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// Laforêt n'a pas de page ville dédiée pour "immeuble" sur des petites communes (redirige
// vers la page département) : seul le type "maison" est couvert par ce scraper.
// La page ville (issue du sitemap achat-maison-villes.xml) est explicitement autorisée par
// leur robots.txt, qui ne bloque que /acheter/rechercher?* (résultats de recherche dynamiques).

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

function normalize(str) {
  return str.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// La page ville fait une recherche à rayon large (communes voisines incluses, comme
// Bretil'Immo/Blot) : la ville de chaque carte est déjà connue via le bouton "favoris"
// (mêmes attributs data-gtm que la page détail), donc on filtre ici avant de charger
// quoi que ce soit — sinon on gaspille un fetch par annonce hors zone (jusqu'à 40+/ville).
async function scrapeListPage(url, villeCible) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = new Set();
  $("article.min-w-0").each((_, card) => {
    const $card = $(card);
    const ville = $card.find("button[data-gtm-item-id-param]").first().attr("data-gtm-item-city-param") || "";
    if (normalize(ville) !== normalize(villeCible)) return;
    const href = ($card.find("a[href*='/agence-immobiliere/']").first().attr("href") || "").split("#")[0];
    if (href) links.add(href);
  });

  return [...links];
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const btn = $('button[data-sharer="email"]').first();
  const type = btn.attr("data-gtm-item-type-param") || "Non spécifié";
  const prix = parseInt(btn.attr("data-gtm-item-price-param")) || 0;
  const villeRaw = btn.attr("data-gtm-item-city-param") || "";
  const ville = villeRaw.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const surface = parseFloat(btn.attr("data-gtm-item-size-param")) || 0;
  const pieces = parseInt(btn.attr("data-gtm-item-rooms-nb-param")) || 0;

  const description = $(".prose").first().text().trim();

  // og:image_0, og:image_1... (exclure og:image_width/og:image_height qui partagent le préfixe)
  const photos = [];
  $('meta[property^="og:image_"]').each((_, el) => {
    const prop = $(el).attr("property") || "";
    const content = $(el).attr("content") || "";
    if (/^og:image_\d+$/.test(prop) && content.startsWith("http") && !photos.includes(content)) {
      photos.push(content);
    }
  });

  return { type, prix, ville, surface, pieces, description, photos, dpe: null, ges: null };
}

export const laforetScraper = async () => {
  const villeRows = await getVilleParams("laforet");
  if (!villeRows.length) {
    console.warn("⚠️ Laforêt - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];

  for (const row of villeRows) {
    const listUrl = `${BASE_URL}/ville/achat-maison-${row.params.slug}`;
    console.log(`🔎 Laforêt - Page de liste : ${listUrl}`);

    let links;
    try {
      links = await scrapeListPage(listUrl, row.nom);
    } catch (err) {
      console.error(`❌ Laforêt - Erreur sur la page de liste ${listUrl}:`, err.message);
      continue;
    }
    console.log(`📌 Laforêt - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Laforêt - Page détail : ${url}`);
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
            agence: "Laforêt",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Laforêt - Données incomplètes pour ${url}`);
          await insertErreur("Laforêt", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Laforêt - Erreur sur ${url}:`, err.message);
        await insertErreur("Laforêt", url, String(err));
      }
    }
  }

  await deleteMissingAnnonces("Laforêt", Array.from(new Set(liensActuels)));
  console.log("✅ Laforêt - Scraping terminé !");
};
