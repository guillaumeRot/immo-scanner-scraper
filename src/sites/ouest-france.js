import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

const BASE_URL = "https://www.ouestfrance-immo.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const LIST_URL = `${BASE_URL}/acheter/?prix=0_400000&types=maison,immeuble&lieux=15942,15645`;

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
  $("article.card-annonce a[href*='/immobilier/vente/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.add((href.startsWith("http") ? href : BASE_URL + href).split("?")[0]);
  });
  const nextHref = $('a[data-t="page-suivante"]').attr("href");
  const nextUrl = nextHref ? (nextHref.startsWith("http") ? nextHref : BASE_URL + nextHref) : null;
  return { links: [...links], nextUrl };
}

function getInfo($, label) {
  let val = "";
  $(".detail-info").each((_, el) => {
    if ($(el).find(".detail-info__label").text().toLowerCase().includes(label.toLowerCase())) {
      val = $(el).find(".detail-info__value").text().trim();
    }
  });
  return val;
}

function extractPhotos(html, annonceId) {
  const byKey = new Map();
  for (const [, srcset] of html.matchAll(/srcset="([^"]+)"/g)) {
    if (!srcset.includes(annonceId)) continue;
    for (const entry of srcset.split(",")) {
      const parts = entry.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const [url, sizeStr] = parts;
      const size = parseInt(sizeStr) || 0;
      const key = url.replace(/_rcrop_\d+-\d+_/, "_");
      const existing = byKey.get(key);
      if (!existing || size > existing.size) {
        byKey.set(key, { url, size });
      }
    }
  }
  return [...new Set([...byKey.values()].map(v => v.url))];
}

async function scrapeDetailPage(url) {
  const annonceId = url.match(/\/(\d+)\.htm$/)?.[1];
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const titleEl = $("h2.detail-page__title").text().trim();
  const [typeRaw, ...villeParts] = titleEl.split(" ");
  const type = typeRaw.toLowerCase().includes("immeuble") ? "immeuble" : "maison";
  const ville = villeParts.join(" ").trim();

  const prix = parseInt(getInfo($, "Prix").split("€")[0].replace(/[^0-9]/g, "")) || 0;
  const surface = parseInt(getInfo($, "Surface habitable").replace(/[^0-9]/g, "")) || 0;
  const pieces = parseInt(getInfo($, "Pièces")) || 0;
  const chambres = parseInt(getInfo($, "Chambres")) || 0;

  const description = $(".detail-description .detail-description__text-part")
    .map((_, el) => $(el).text().trim()).get()
    .filter(t => t && !t.includes("georisques.gouv.fr"))
    .join("\n");

  const photos = extractPhotos(html, annonceId);

  return { type, prix, ville, surface, pieces, chambres, description, photos, dpe: null, ges: null };
}

export const ouestFranceScraper = async () => {
  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 Ouest-France Immo - ${links.length} annonces sur ${currentUrl}`);

    for (const url of links) {
      try {
        const data = await scrapeDetailPage(url);
        if (data.ville && data.prix) {
          await insertAnnonce({ ...data, agence: "Ouest-France Immo", lien: url });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Ouest-France Immo - Données incomplètes pour ${url}`);
          await insertErreur("Ouest-France Immo", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Ouest-France Immo - Erreur sur ${url}: ${err.message}`);
        await insertErreur("Ouest-France Immo", url, String(err));
      }
      await new Promise(r => setTimeout(r, 300));
    }
    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("Ouest-France Immo", [...new Set(liensActuels)]);
  console.log("✅ Ouest-France Immo - Scraping terminé !");
};
