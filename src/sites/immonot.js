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
  // Scoper sous .card-immo-li : quand la recherche ne renvoie aucun résultat, la page
  // affiche un carrousel "recherches similaires" qui réutilise le même motif de lien
  // mais avec des biens hors zone (autres villes) — il faut l'exclure.
  $('.card-immo-li a[href^="/immobilier-notaire/detail/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.push(href.startsWith("http") ? href : BASE_URL + href);
  });
  const nextHref = $('link[rel="next"]').attr("href");
  const nextUrl = nextHref ? (nextHref.startsWith("http") ? nextHref : BASE_URL + nextHref) : null;
  return { links, nextUrl };
}

// Fiche produit : les libellés "Nombre de pièces", "Chambres", "Surface habitable"
// sont rendus en paires <p class="text-sm text-gray-4">label</p><p class="text-base font-bold">valeur</p>
function getSpec($, label) {
  let value = "";
  $("p.text-sm.text-gray-4").each((_, el) => {
    if ($(el).text().trim() === label) {
      value = $(el).next("p.text-base.font-bold").text().trim();
    }
  });
  return value;
}

// Données structurées JSON-LD (BuyAction) : plus fiable que le HTML pour prix/ville/description/photos
function extractBuyAction($) {
  let buyAction = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const node = (data["@graph"] || []).find(n => n["@type"] === "BuyAction");
      if (node) buyAction = node;
    } catch {}
  });
  return buyAction;
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const buyAction = extractBuyAction($);

  const typeRaw = $(".hero-detail-subtitle").first().text().trim().toLowerCase();
  const type = typeRaw.includes("immeuble") ? "immeuble" : "maison";
  const prix = parseInt(buyAction?.price) || 0;
  const ville = (buyAction?.location?.address?.addressLocality || "").replace(/\s*\([^)]*\)/g, "").trim();
  const description = (buyAction?.object?.description || "").trim();
  const photos = buyAction?.object?.image || [];
  const surface = parseFloat(getSpec($, "Surface habitable")) || 0;
  const pieces = parseInt(getSpec($, "Nombre de pièces")) || 0;
  const chambres = parseInt(getSpec($, "Chambres")) || 0;

  // DPE et GES réutilisent le même attribut data-dpe-classe sur deux <figure> distincts (ordre : DPE puis GES)
  const dpe = $("[data-dpe-classe]").eq(0).attr("data-dpe-classe") || null;
  const ges = $("[data-dpe-classe]").eq(1).attr("data-dpe-classe") || null;

  return { type, prix, ville, surface, pieces, chambres, description, photos, dpe, ges };
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
