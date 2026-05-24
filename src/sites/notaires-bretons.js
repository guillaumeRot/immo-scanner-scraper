import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

const BASE_URL = "https://www.notaireetbreton.bzh";
const LIST_URL =
  `${BASE_URL}/biens/achat/immeuble%2Cmaison-individuelle/vitre-35500` +
  `?field_price_value%5Bmax%5D=400000&sort_bef_combine=field_price_value_ASC&display-mode=list`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = new Set();
  $(".view-content .node--type-property .node__content > a[href^='/biens/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href) links.add(`${BASE_URL}${href.split("?")[0]}`);
  });

  const nextHref = $("a[rel='next'], a.pager__item--next a").attr("href") || null;
  const nextUrl = nextHref
    ? nextHref.startsWith("http") ? nextHref : `${BASE_URL}${nextHref}`
    : null;

  return { links: [...links], nextUrl };
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const ville = $("nav.breadcrumb li:nth-child(5) span[itemprop='name']")
    .text().trim().replace(/\(.*\)/g, "").trim();
  const type = $("nav.breadcrumb li:nth-child(3) span[itemprop='name']").text().trim();
  const prix = parseInt(($(".field--name-field-price").first().text() || "").replace(/[^0-9]/g, "")) || 0;
  const surface = parseInt(($(".field--name-field-living-space .field__item").first().text() || "").replace(/\D/g, "")) || 0;
  const pieces = parseInt(($(".field--name-field-rooms-number .field__item").first().text() || "").replace(/\D/g, "")) || 0;
  const chambres = parseInt(($(".field--name-field-bedrooms .field__item").first().text() || "").replace(/\D/g, "")) || 0;
  const description = $(".description-content p").first().text().trim();
  const dpe = $(".diagnostic-energy .letter.active .content-indice").text().trim() || null;
  const ges = $(".diagnostic-climate .letter.active .content-indice").text().trim() || null;

  const photos = [];
  $("img[src*='/property/']").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (src.includes("/themes/")) return;
    const full = src.startsWith("http") ? src : `${BASE_URL}${src}`;
    if (!photos.includes(full)) photos.push(full);
  });

  return { ville, type, prix, surface, pieces, chambres, description, dpe, ges, photos };
}

export const notairesBretonsScraper = async () => {
  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 Notaires Bretons - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 Notaires Bretons - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Notaires Bretons - Page détail : ${url}`);
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
            agence: "Notaires et Bretons",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Notaires Bretons - Données incomplètes pour ${url}`);
          await insertErreur("Notaires et Bretons", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Notaires Bretons - Erreur sur ${url}:`, err.message);
        await insertErreur("Notaires et Bretons", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("Notaires et Bretons", Array.from(new Set(liensActuels)));
  console.log("✅ Notaires Bretons - Scraping terminé !");
};
