import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

const BASE_URL = "https://www.diard-immobilier.fr";
const LIST_URL =
  `${BASE_URL}/catalog/advanced_search_result.php?action=update_search` +
  `&C_28_search=EGAL&C_28_type=UNIQUE&C_28=Vente` +
  `&C_27_search=EGAL&C_27_type=UNIQUE&C_27=2` +
  `&C_30_MAX=400000&C_30_search=COMPRIS&C_30_type=NUMBER`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  // Le site utilise ISO-8859-1
  const buf = await res.arrayBuffer();
  return new TextDecoder("iso-8859-1").decode(buf);
}

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = new Set();
  $("a[href*='fiches']").each((_, el) => {
    let href = ($(el).attr("href") || "").replace(/\?.*$/, "");
    href = href.replace(/^\.\.\//, `${BASE_URL}/`);
    if (href.startsWith("http")) links.add(href);
  });

  const nextHref = $("a:contains('Suivante')").attr("href") || null;
  const nextUrl = nextHref
    ? nextHref.startsWith("http") ? nextHref : `${BASE_URL}${nextHref}`
    : null;

  return { links: [...links], nextUrl };
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  function getCritere(label) {
    let result = null;
    $(".product-criteres .list-group-item").each((_, el) => {
      const cols = $(el).find(".col-sm-6");
      if (cols.first().text().trim() === label) {
        result = cols.last().find("b").text().trim() || cols.last().text().trim();
        return false;
      }
    });
    return result;
  }

  const prix = parseInt($(".hono_inclus_price").first().text().replace(/[^0-9]/g, "")) || 0;
  const ville = $(".ville-title").first().text().trim();
  const surface = parseInt((getCritere("Surface") || "").match(/\d+/)?.[0] || "0");
  const pieces = parseInt(getCritere("Nombre pièces")) || 0;
  const chambres = parseInt(getCritere("Chambres")) || 0;
  const dpe = getCritere("Consommation énergie primaire") || null;
  const ges = getCritere("Gaz Effet de Serre") || null;
  const description = $(".products-description").first().text().trim();
  const type = $("h1.product-title").first().text().trim().split(/\s+/)[0] || "Non spécifié";

  const photos = [];
  $(".container-slider-product img[src*='pr_p']").each((_, el) => {
    const src = ($(el).attr("src") || "").replace(/^\.\.\//, `${BASE_URL}/`);
    if (src && !photos.includes(src)) photos.push(src);
  });

  return { prix, ville, surface, pieces, chambres, dpe, ges, description, type, photos };
}

export const diardScraper = async () => {
  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 Diard - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 Diard - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Diard - Page détail : ${url}`);
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
            dpe: data.dpe,
            ges: data.ges,
            agence: "Diard",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Diard - Données incomplètes pour ${url}`);
          await insertErreur("Diard", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Diard - Erreur sur ${url}:`, err.message);
        await insertErreur("Diard", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("Diard", Array.from(new Set(liensActuels)));
  console.log("✅ Diard - Scraping terminé !");
};
