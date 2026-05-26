import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://www.immonot.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

async function fetchHtml(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 2000 * i));
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return res.text();
    } catch (e) {
      if (i === retries - 1) throw e;
    }
  }
  throw new Error(`HTTP fetch failed for ${url}`);
}

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const links = [];
  $("a.js-mirror-link").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.push(href.startsWith("http") ? href : BASE_URL + href);
  });
  const nextHref = $('a.page-link[rel="next"]').attr("href");
  const nextUrl = nextHref ? (nextHref.startsWith("http") ? nextHref : BASE_URL + nextHref) : null;
  return { links, nextUrl };
}

function getSpec($, label) {
  let value = "";
  $("dl.id-spec").each((_, el) => {
    if ($(el).find("dt").text().trim() === label) {
      // Use first text node to avoid concatenation with <sup>2</sup> in surface fields
      value = $(el).find("dd").contents().first().text().trim();
    }
  });
  return value;
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const typeRaw = $(".id-title-type").first().text().trim().toLowerCase();
  const type = typeRaw.includes("immeuble") ? "immeuble" : "maison";
  const prix = parseInt($(".id-price-amount").first().text().replace(/\D/g, "")) || 0;
  const ville = $(".id-title-location").first().text().trim();
  const description = $(".id-desc-body").first().text().trim();
  const surface = parseFloat(getSpec($, "Surface habitable")) || 0;
  const pieces = parseInt(getSpec($, "Pièces")) || 0;
  const chambres = parseInt(getSpec($, "Chambres")) || 0;

  const photos = [];
  $("#js-lightgallery a").each((_, el) => {
    const href = $(el).attr("href");
    if (href && !href.startsWith("#")) {
      photos.push(href.startsWith("//") ? "https:" + href : href);
    }
  });

  return { type, prix, ville, surface, pieces, chambres, description, photos, dpe: null, ges: null };
}

export const immonotScraper = async () => {
  const villeRows = await getVilleParams("immonot");
  if (!villeRows.length) {
    console.warn("⚠️ Immonot - Aucune ville configurée en base");
    return;
  }
  const LIST_URLS = villeRows.flatMap(r => [
    `${BASE_URL}/recherche-annonces-par-ville/VENT/MAIS/${r.params.dept}/${r.params.code_postal}-${r.params.slug}/Achat-Maison-ille-et-vilaine-${r.params.code_postal}-${r.params.slug}.html`,
    `${BASE_URL}/recherche-annonces-par-ville/VENT/IMMR/${r.params.dept}/${r.params.code_postal}-${r.params.slug}/Achat-Immeuble-ille-et-vilaine-${r.params.code_postal}-${r.params.slug}.html`,
  ]);

  const liensActuels = [];

  for (const startUrl of LIST_URLS) {
    let currentUrl = startUrl;
    while (currentUrl) {
      const { links, nextUrl } = await scrapeListPage(currentUrl);
      console.log(`📌 Immonot - ${links.length} annonces sur ${currentUrl}`);

      for (const url of links) {
        try {
          const data = await scrapeDetailPage(url);
          if (data.ville && data.prix && data.prix <= 400000) {
            await insertAnnonce({ ...data, agence: "Immonot", lien: url });
            liensActuels.push(url);
          } else if (!data.ville || !data.prix) {
            console.warn(`⚠️ Immonot - Données incomplètes pour ${url}`);
            await insertErreur("Immonot", url, "Données incomplètes (ville ou prix manquant)");
          }
        } catch (err) {
          console.error(`❌ Immonot - Erreur sur ${url}: ${err.message}`);
          await insertErreur("Immonot", url, String(err));
        }
        await new Promise(r => setTimeout(r, 300));
      }
      currentUrl = nextUrl;
    }
  }

  await deleteMissingAnnonces("Immonot", [...new Set(liensActuels)]);
  console.log("✅ Immonot - Scraping terminé !");
};
