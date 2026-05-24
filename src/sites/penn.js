import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

const LIST_URL =
  "https://www.penn-immobilier.com/nos-biens/xdpemrqtp4buydnf99nh9kerfqiayzh3imfyje44jebrsyzmou7q6h3enzade8wot9r54jszgx4f537jrwf9kf5rqbkty9a8jmajdyhn8t4w3m6tqdyctxcdxj8jad1cpogj5htn3hfuuqq1zginiqb6nshgcag1n1obpshr9k8mphp5e3wjzmpgswqdam7ndrscscbef6xiu4z5rpp8anyimf7jpmamm6idfckcb6t66wguh4398s8j3qqutopgtu1d5cz5a9o83889eeahnitqdkwgnhizy3qwsqr6yko7x7auozr8pde1e1fcp7b9s68cupbjum5uwin4oxpnxm464gw8xcdktpkn4apgg6w9m96i6rxgwoy9mg8ocxk8n8exx1ydmf3fd4s84ydiht1cfonw558djn3rh686ygmoumga/1";

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
  $(".property-listing-v3__item .item__drawing > a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (!href.includes("/i/") && !href.includes("javascript:")) {
      links.add(href.startsWith("http") ? href : `https://www.penn-immobilier.com${href}`);
    }
  });

  // Pagination : lien "Suivant" ou page numérotée dans l'URL /nos-biens/.../N
  const nextUrl = $("a.pagination__next, a[rel='next']").attr("href") || null;

  return { links: [...links], nextUrl };
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  function getTableValue(label) {
    let result = null;
    $(".table-aria__tr").each((_, el) => {
      if ($(el).find(".table-aria__td--title").text().trim() === label) {
        result = $(el).find(".table-aria__td--value").text().trim();
        return false;
      }
    });
    return result;
  }

  // Ville, type et ref extraits de l'URL canonique : /vente/1-vitre/maison/tX/15495-slug/
  const canonical = $("link[rel='canonical']").attr("href") || url;
  const urlMatch = canonical.match(/\/vente\/\d+-([^/]+)\/([^/]+)\/[^/]+\/(\d+)-/);
  const ville = urlMatch?.[1]?.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) || "";
  const type = urlMatch?.[2]?.replace(/\b\w/g, c => c.toUpperCase()) || "Non spécifié";

  const prix = parseInt((getTableValue("Prix de vente honoraires TTC inclus") || "").replace(/[^0-9]/g, "")) || 0;
  const surface = parseFloat((getTableValue("Surface habitable (m²)") || "").replace(",", ".")) || 0;
  const pieces = parseInt(getTableValue("Nombre de pièces") || "0") || 0;
  const chambres = parseInt(getTableValue("Nombre de chambre(s)") || "0") || 0;
  const description = $(".main-info__text-block p").first().text().trim();

  const photos = [];
  $('.slider-img__swiper-slide a[href*="/original/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const src = href.startsWith("//") ? `https:${href}` : href;
    if (src && !photos.includes(src)) photos.push(src);
  });

  return { ville, type, prix, surface, pieces, chambres, description, photos };
}

export const pennScraper = async () => {
  const liensActuels = [];
  let currentUrl = LIST_URL;

  while (currentUrl) {
    console.log(`🔎 Penn - Page de liste : ${currentUrl}`);
    const { links, nextUrl } = await scrapeListPage(currentUrl);
    console.log(`📌 Penn - ${links.length} annonces trouvées.`);

    for (const url of links) {
      try {
        console.log(`📄 Penn - Page détail : ${url}`);
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
            agence: "Penn",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Penn - Données incomplètes pour ${url}`);
          await insertErreur("Penn", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Penn - Erreur sur ${url}:`, err.message);
        await insertErreur("Penn", url, String(err));
      }
    }

    currentUrl = nextUrl;
  }

  await deleteMissingAnnonces("Penn", Array.from(new Set(liensActuels)));
  console.log("✅ Penn - Scraping terminé !");
};
