import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://www.fnaim.fr";
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
  const links = new Set();
  $('.liste .item a.linkAnnonce[href^="/annonce-immobiliere/"]').each((_, el) => {
    links.add(BASE_URL + $(el).attr("href"));
  });
  const nextHref = $('.regletteNavigation .next a').attr("href");
  const nextUrl = nextHref ? (nextHref.startsWith("http") ? nextHref : BASE_URL + nextHref) : null;
  return { links: [...links], nextUrl };
}

function getCarac($, label) {
  let val = "";
  $('#caracteristiques li').each((_, el) => {
    const span = $(el).find("span").first().text().replace(/\s+/g, " ").trim();
    if (span.toLowerCase().includes(label.toLowerCase())) {
      val = $(el).text().replace(span, "").replace(/[^\d,.]/g, "").trim();
    }
  });
  return val;
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const typeRaw = $('.ariane span:nth-child(2) span[itemprop="title"]').text().trim()
    .replace(/^ACHAT\s+/i, "").toLowerCase();
  const type = typeRaw.includes("immeuble") ? "immeuble" : "maison";

  const prix = parseInt($('.annonce_price span[itemprop="price"]').text().replace(/\s+/g, "")) || 0;

  const ville = $('div[itemprop="address"] span').first().text().trim()
    .replace(/\s*\([^)]*\)/g, "").trim();

  const surface = parseFloat(getCarac($, "Surface habitable")) || 0;
  const chambres = parseInt(getCarac($, "Nombre de chambres")) || 0;

  // Pièces extraites du title (ex: "Achat Maison 4 pièce(s) 82 m² ...")
  const titleMatch = $("title").text().match(/(\d+)\s*pièce/i);
  const pieces = titleMatch ? parseInt(titleMatch[1]) : 0;

  const description = $('#description p[itemprop="description"]').text().trim();

  const photos = [];
  $('a.imageAnnonce[href*="imagesv2.fnaim.fr"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) photos.push(href.split("?")[0]);
  });

  const dpeMatch = description.match(/[Cc]lasse.*?[Éé]nergie.*?[:=]\s*([A-G])/);
  const gesMatch = description.match(/[Cc]lasse.*?GES.*?[:=]\s*([A-G])/);
  const dpe = dpeMatch?.[1] ?? null;
  const ges = gesMatch?.[1] ?? null;

  return { type, prix, ville, surface, pieces, chambres, description, photos, dpe, ges };
}

export const fnaimScraper = async () => {
  const villeRows = await getVilleParams("fnaim");
  if (!villeRows.length) {
    console.warn("⚠️ FNAIM - Aucune ville configurée en base");
    return;
  }
  const localites = villeRows.map(r => r.params);
  const LIST_URL =
    `${BASE_URL}/17-acheter.htm?localites=${encodeURIComponent(JSON.stringify(localites))}` +
    `&PRIX_MAX=400000&TYPE%5B%5D=2&TYPE%5B%5D=9&idtf=17&TRANSACTION=1&submit=Rechercher`;

  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 FNAIM - ${links.length} annonces sur ${currentUrl}`);

    for (const url of links) {
      try {
        const data = await scrapeDetailPage(url);
        if (data.ville && data.prix) {
          await insertAnnonce({ ...data, agence: "FNAIM", lien: url });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ FNAIM - Données incomplètes pour ${url}`);
          await insertErreur("FNAIM", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ FNAIM - Erreur sur ${url}: ${err.message}`);
        await insertErreur("FNAIM", url, String(err));
      }
      await new Promise(r => setTimeout(r, 300));
    }
    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("FNAIM", [...new Set(liensActuels)]);
  console.log("✅ FNAIM - Scraping terminé !");
};
