import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

function normalize(str) {
  return str.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

async function scrapeListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = new Set();
  $("a[href*='/propriete/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!href) return;

    const typeSlug = href.match(/\/propriete\/([^-]+)/)?.[1] || "";
    const cityMatch = text.match(/[—–]([A-ZÉÀÈÙÂÊÎÔÛÄËÏÖÜ\s]+?)(\d)/);
    const city = cityMatch?.[1]?.trim() || "";
    const priceMatch = text.match(/([\d\s]+)\s*€\s*$/);
    const prix = parseInt((priceMatch?.[1] || "0").replace(/\s/g, "")) || 0;

    const isValidType = ["maison", "immeuble"].includes(typeSlug);
    const isVitre = normalize(city).includes("vitre");
    const isInBudget = prix <= 400000 && prix > 0;

    if (isValidType && isVitre && isInBudget) {
      links.add(`https://bretilimmo.com${href}`);
    }
  });

  // Site rebuilt in Next.js — no server-side pagination in filter results
  return { links: [...links], nextUrl: null };
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  let jsonLd = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      if (data["@type"] === "RealEstateListing") jsonLd = data;
    } catch {}
  });

  const typeSlug = url.match(/\/propriete\/([^-]+)/)?.[1] || "";
  const type = typeSlug.charAt(0).toUpperCase() + typeSlug.slice(1) || "Non spécifié";

  const prix = jsonLd?.offers?.price ? parseInt(jsonLd.offers.price) : 0;
  const ville = jsonLd?.address?.addressLocality || "";
  const surface = jsonLd?.floorSize?.value ? parseFloat(jsonLd.floorSize.value) : 0;
  const pieces = jsonLd?.numberOfRooms ? parseInt(jsonLd.numberOfRooms) : 0;
  const description = jsonLd?.description || "";

  const photos = [];
  $("img").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || "";
    const match = src.match(/[?&]url=([^&]+)/);
    if (match) {
      const decoded = decodeURIComponent(match[1]);
      if (decoded.startsWith("http") && !photos.includes(decoded)) photos.push(decoded);
    }
  });

  return { type, prix, ville, surface, pieces, chambres: 0, description, photos };
}

export const bretilimmoScraper = async () => {
  const villeRows = await getVilleParams("bretilimmo");
  if (!villeRows.length) {
    console.warn("⚠️ Bretil'Immo - Aucune ville configurée en base");
    return;
  }
  const locParams = villeRows.map(r => `localisation%5B%5D=${r.params.slug}`).join("&");
  const LIST_URL =
    `https://bretilimmo.com/a-vendre?sort=&type_bien%5B%5D=immeuble&type_bien%5B%5D=maison-villa` +
    `&${locParams}&pieces=&chambres=&minBudget=&maxBudget=400000&minSurface=&maxSurface=&minTerrain=&maxTerrain=&reference=&submit=`;

  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 Bretil'Immo - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 Bretil'Immo - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Bretil'Immo - Page détail : ${url}`);
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
            agence: "Bretil'Immo",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Bretil'Immo - Données incomplètes pour ${url}`);
          await insertErreur("Bretil'Immo", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Bretil'Immo - Erreur sur ${url}:`, err.message);
        await insertErreur("Bretil'Immo", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("Bretil'Immo", Array.from(new Set(liensActuels)));
  console.log("✅ Bretil'Immo - Scraping terminé !");
};
