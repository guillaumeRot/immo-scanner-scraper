import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, insertAnnonceLocation, deleteMissingAnnoncesLocation, getVilleParams } from "../db.js";

const BASE_URL = "https://www.kermarrec-habitation.fr";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

function extractText($el) {
  $el.find(".ico").remove();
  return $el.text().trim().replace(/\s+/g, " ");
}

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = [];
  $("article.list-bien a.link-full").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.push(href);
  });

  const nextHref = $("a.next.page-numbers").attr("href") || null;
  return { links, nextUrl: nextHref };
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Prix — premier .entry-price sans classe .text-blue
  const prixRaw = $(".entry-price").not(".text-blue").first().text();
  const prix = parseInt(prixRaw.replace(/[^0-9]/g, "")) || 0;

  // Surface, typologie, ville depuis les <p> du bloc description
  let surfaceText = "";
  let typologie = "";
  let ville = "";

  $(".entry-description-content p").each((_, el) => {
    const ico = $(el).find("span[data-ico]").attr("data-ico");
    const text = extractText($(el));
    if (ico === "surface") surfaceText = text;
    else if (ico === "typologie") typologie = text;
    else if (ico === "ville") ville = text;
  });

  const surface = parseFloat(surfaceText.replace(/[^0-9,.]/g, "").replace(",", ".")) || 0;

  let pieces = 0;
  let chambres = 0;
  if (typologie) {
    const mPieces = typologie.match(/(\d+)\s*pi[èe]ce/i);
    const mChambres = typologie.match(/(\d+)\s*ch(?:ambres?)?/i);
    pieces = mPieces ? parseInt(mPieces[1]) : 0;
    chambres = mChambres ? parseInt(mChambres[1]) : 0;
  }

  // Description
  const description = $("#description p").first().text().trim();

  // Photos — lazy-loaded, URL dans data-lazy-src
  const photos = [];
  $(".entry-medias img").each((_, el) => {
    const src = $(el).attr("data-lazy-src") || $(el).attr("src") || "";
    if (src && !src.startsWith("data:")) photos.push(src);
  });

  // DPE / GES
  const dpe = $(".emission-diagram .diag_selected .diag_letter").first().text().trim();
  const ges = $(".diag_ges .diag_selected .diag_letter").first().text().trim();

  return { prix, ville, surface, typologie, pieces, chambres, description, photos, dpe, ges };
}

async function scrapeLocationDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Loyer au format "666,90 €/mois CC" — décimales à virgule, ne pas juste retirer les
  // caractères non numériques (concaténerait les centimes : "666,90" -> "66690")
  const prixRaw = $(".entry-price").not(".text-blue").first().text();
  const loyer = parseInt(prixRaw.split(",")[0].replace(/[^0-9]/g, "")) || 0;

  let surfaceText = "";
  let typologie = "";
  let ville = "";

  $(".entry-description-content p").each((_, el) => {
    const ico = $(el).find("span[data-ico]").attr("data-ico");
    const text = extractText($(el));
    if (ico === "surface") surfaceText = text;
    else if (ico === "typologie") typologie = text;
    else if (ico === "ville") ville = text;
  });

  const surface = parseFloat(surfaceText.replace(/[^0-9,.]/g, "").replace(",", ".")) || 0;
  const pieces = typologie.match(/(\d+)\s*pi[èe]ce/i)?.[1] ? parseInt(typologie.match(/(\d+)\s*pi[èe]ce/i)[1]) : 0;

  const description = $("#description p").first().text().trim();

  const photos = [];
  $(".entry-medias img").each((_, el) => {
    const src = $(el).attr("data-lazy-src") || $(el).attr("src") || "";
    if (src && !src.startsWith("data:")) photos.push(src);
  });

  const dpe = $(".emission-diagram .diag_selected .diag_letter").first().text().trim();
  const ges = $(".diag_ges .diag_selected .diag_letter").first().text().trim();

  return { loyer, ville, surface, pieces, description, photos, dpe, ges };
}

export const kermarrecLocationScraper = async () => {
  const villeRows = await getVilleParams("kermarrec");
  if (!villeRows.length) {
    console.warn("⚠️ Kermarrec (location) - Aucune ville configurée en base");
    return;
  }
  const primary = villeRows.find(r => r.params.is_primary) || villeRows[villeRows.length - 1];
  const villeParams = villeRows.map(r => `ville%5B%5D=${r.params.slug}`).join("&");
  const LIST_URL =
    `${BASE_URL}/location/appartement/?post_type=location&false-select=on&1d04ea34=${primary.params.nom}` +
    `&${villeParams}&reference=&rayon=0&avec_carte=false&tri=pertinence`;

  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 Kermarrec (location) - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 Kermarrec (location) - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Kermarrec (location) - Page détail : ${url}`);
        const data = await scrapeLocationDetailPage(url);

        if (data.ville && data.loyer) {
          await insertAnnonceLocation({
            type: "Appartement",
            loyer: data.loyer,
            ville: data.ville,
            pieces: data.pieces,
            surface: data.surface,
            description: data.description,
            photos: data.photos,
            dpe: data.dpe,
            ges: data.ges,
            agence: "Kermarrec",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Kermarrec (location) - Données incomplètes pour ${url}`);
          await insertErreur("Kermarrec (location)", url, "Données incomplètes (ville ou loyer manquant)");
        }
      } catch (err) {
        console.error(`❌ Kermarrec (location) - Erreur sur ${url}:`, err.message);
        await insertErreur("Kermarrec (location)", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnoncesLocation("Kermarrec", Array.from(new Set(liensActuels)));
  console.log("✅ Kermarrec (location) - Scraping terminé !");
};

export const kermarrecScraper = async () => {
  const villeRows = await getVilleParams("kermarrec");
  if (!villeRows.length) {
    console.warn("⚠️ Kermarrec - Aucune ville configurée en base");
    return;
  }
  const primary    = villeRows.find(r => r.params.is_primary) || villeRows[villeRows.length - 1];
  const villeParams = villeRows.map(r => `ville%5B%5D=${r.params.slug}`).join("&");
  const LIST_URL =
    `${BASE_URL}/achat/?post_type=achat&false-select=on&1d04ea34=${primary.params.nom}` +
    `&${villeParams}&typebien%5B%5D=immeuble&typebien%5B%5D=maison&budget_max=400000` +
    `&reference=&rayon=0&avec_carte=false&tri=pertinence`;

  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 Kermarrec - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 Kermarrec - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Kermarrec - Page détail : ${url}`);
        const data = await scrapeDetailPage(url);

        if (data.ville && data.prix) {
          await insertAnnonce({
            type: data.typologie || "Non spécifié",
            prix: data.prix,
            ville: data.ville,
            pieces: data.pieces,
            chambres: data.chambres,
            surface: data.surface,
            description: data.description,
            photos: data.photos,
            dpe: data.dpe,
            ges: data.ges,
            agence: "Kermarrec",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Kermarrec - Données incomplètes pour ${url}`);
          await insertErreur("Kermarrec", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Kermarrec - Erreur sur ${url}:`, err.message);
        await insertErreur("Kermarrec", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("Kermarrec", Array.from(new Set(liensActuels)));
  console.log("✅ Kermarrec - Scraping terminé !");
};
