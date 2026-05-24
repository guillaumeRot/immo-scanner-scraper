import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

const LIST_URL =
  "https://www.carnotimmo.com/recherche-de-bien/?status=vente&type%5B%5D=maison&location=vitre-35500";

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

  const links = [];
  $(".rh_list_card__wrap h3 a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.push(href);
  });

  const nextUrl = $("a.rh_pagination__next").attr("href") || null;
  return { links, nextUrl };
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  function getAdditionalDetail(label) {
    let result = null;
    $("#property-content-section-additional-details li").each((_, el) => {
      if ($(el).find(".title").text().includes(label)) {
        result = $(el).find(".value").text().trim();
        return false;
      }
    });
    return result;
  }

  const priceText = $(".rh_page__property_price .price").first().text().trim();
  const prix = parseInt(priceText.replace(/[^0-9]/g, "")) || 0;

  const ville = $(".rh_page__property_address").first().text().trim();
  const surface = parseInt($(".prop_area .figure").first().text().trim()) || 0;
  const chambres = parseInt($(".prop_bedrooms .figure").first().text().trim()) || 0;
  const pieces = parseInt(getAdditionalDetail("Nombre de pièces")) || chambres + 1;

  const description = $(".rh_property__content .rh_content").first().text().trim();
  const type = description.split(/[\n\r]/)[0]?.trim().split(" ")[0] || "Non spécifié";

  const dpeMatch = ($("#bloc-energies #dpe .details-dpe").attr("class") || "").match(/dpe-([A-G])/);
  const gesMatch = ($("#bloc-energies #ges .details-ges").attr("class") || "").match(/ges-([A-G])/);

  const photos = [];
  $('.inspiry_property_masonry_style a[data-fancybox="gallery"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) photos.push(href);
  });

  return {
    prix,
    ville,
    surface,
    chambres,
    pieces,
    type,
    description,
    photos,
    dpe: dpeMatch?.[1] ?? null,
    ges: gesMatch?.[1] ?? null,
  };
}

export const carnotScraper = async () => {
  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 Carnot - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 Carnot - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Carnot - Page détail : ${url}`);
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
            agence: "Carnot",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Carnot - Données incomplètes pour ${url}`);
          await insertErreur("Carnot", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Carnot - Erreur sur ${url}:`, err.message);
        await insertErreur("Carnot", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("Carnot", Array.from(new Set(liensActuels)));
  console.log("✅ Carnot - Scraping terminé !");
};
