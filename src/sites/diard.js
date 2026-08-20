import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, insertAnnonceLocation, deleteMissingAnnoncesLocation, getVilleParams } from "../db.js";

const BASE_URL = "https://www.diard-immobilier.fr";
const BASE_LIST_URL =
  `${BASE_URL}/catalog/advanced_search_result.php?action=update_search` +
  `&C_28_search=EGAL&C_28_type=UNIQUE&C_28=Vente` +
  `&C_27_search=EGAL&C_27_type=UNIQUE&C_27=2` +
  `&C_30_MAX=400000&C_30_search=COMPRIS&C_30_type=NUMBER` +
  `&C_65_search=CONTIENT&C_65_type=TEXT&C_65=`;

// Location : C_27=1 (Appartement, cf. options du formulaire), pas de plafond de budget
const BASE_LIST_URL_LOCATION =
  `${BASE_URL}/catalog/advanced_search_result.php?action=update_search` +
  `&C_28_search=EGAL&C_28_type=UNIQUE&C_28=Location` +
  `&C_27_search=EGAL&C_27_type=UNIQUE&C_27=1` +
  `&C_65_search=CONTIENT&C_65_type=TEXT&C_65=`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// Le serveur Diard répond parfois par un 502/503/504 ou reste muet une trentaine de
// secondes (constaté : une seule fiche en erreur a fait passer un run entier de ~8s à
// 90s, dépassant la limite de 60s d'une fonction Vercel). On borne donc chaque requête
// à 5s et on réessaie une fois pour les problèmes transitoires — timeout réseau ou
// 502/503/504 (souci ponctuel de proxy/passerelle côté site, pas un bug qui persiste).
// Un vrai 500 (ou tout autre code) n'est lui jamais réessayé : ça remonte tel quel.
const CODES_TRANSITOIRES = new Set([502, 503, 504]);
const FETCH_TIMEOUT_MS = 5000;
// Plafond cron-job.org (30s, non modifiable) : même avec des requêtes rapides, plusieurs
// échecs (timeout + réessai) dans un même run peuvent s'accumuler au-delà de 30s. Ce
// budget interrompt proprement le scraper avant cette limite plutôt que de laisser
// cron-job.org le couper en plein milieu. Le check n'a lieu qu'entre deux itérations :
// une dernière requête déjà lancée peut encore coûter jusqu'à ~12s (timeout + réessai)
// après que le budget soit dépassé (constaté : 28s avec un budget à 20s) — fixé à 15s
// pour garder une vraie marge sous les 30s.
const BUDGET_MS = 15000;

async function fetchOnce(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) {
      const httpErr = new Error(`HTTP ${res.status} on ${url}`);
      if (CODES_TRANSITOIRES.has(res.status)) httpErr.isRetryable = true;
      throw httpErr;
    }
    // Le site utilise ISO-8859-1
    const buf = await res.arrayBuffer();
    return new TextDecoder("iso-8859-1").decode(buf);
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error(`Timeout (${FETCH_TIMEOUT_MS / 1000}s) on ${url}`);
      timeoutErr.isRetryable = true;
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHtml(url) {
  try {
    return await fetchOnce(url);
  } catch (err) {
    if (!err.isRetryable) throw err; // HTTP 500 etc. : pas de réessai, on relance direct
    console.warn(`⚠️ Diard - ${err.message}, réessai unique...`);
    await new Promise((r) => setTimeout(r, 2000));
    return await fetchOnce(url); // 2e et dernière tentative ; si elle échoue aussi, l'erreur remonte
  }
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

async function scrapeLocationDetailPage(url) {
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

  // Widget de conformité loi ALUR (composant partagé par ce CMS, cf. Boyer) : .hono_inclus_price
  // reste présent mais affiche une autre valeur (estimation), pas le loyer réel
  const loyer = parseInt($(".alur_loyer_price").first().text().replace(/[^0-9]/g, "")) || 0;
  const ville = $(".ville-title").first().text().trim();
  const surface = parseInt((getCritere("Surface") || "").match(/\d+/)?.[0] || "0");
  const pieces = parseInt(getCritere("Nombre pièces")) || 0;
  const dpe = getCritere("Consommation énergie primaire") || null;
  const ges = getCritere("Gaz Effet de Serre") || null;
  const description = $(".products-description").first().text().trim();
  const type = "Appartement";

  const photos = [];
  $(".container-slider-product img[src*='pr_p']").each((_, el) => {
    const src = ($(el).attr("src") || "").replace(/^\.\.\//, `${BASE_URL}/`);
    if (src && !photos.includes(src)) photos.push(src);
  });

  return { loyer, ville, surface, pieces, dpe, ges, description, type, photos };
}

export const diardLocationScraper = async () => {
  const villeRows = await getVilleParams("diard");
  if (!villeRows.length) {
    console.warn("⚠️ Diard (location) - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];
  const scraperStart = Date.now();
  let scrapeIncomplete = false;

  villeLoop:
  for (const row of villeRows) {
    let currentUrl = BASE_LIST_URL_LOCATION + encodeURIComponent(row.params.C_65);

    while (currentUrl) {
      if (Date.now() - scraperStart > BUDGET_MS) {
        console.warn(`⚠️ Diard (location) - Budget de temps dépassé, arrêt anticipé (run incomplet)`);
        await insertErreur("Diard (location)", currentUrl, `Budget de temps dépassé (run incomplet) — ${row.nom}`);
        scrapeIncomplete = true;
        break villeLoop;
      }
      console.log(`🔎 Diard (location) - Page de liste : ${currentUrl}`);
      let links, nextUrl;
      try {
        ({ links, nextUrl } = await scrapeListPage(currentUrl));
      } catch (err) {
        if (!err.isRetryable) throw err; // vraie erreur HTTP (500...) : on laisse remonter, pas de faux succès
        console.error(`❌ Diard (location) - Échec persistant sur la page de liste ${currentUrl}: ${err.message}`);
        await insertErreur("Diard (location)", currentUrl, String(err));
        scrapeIncomplete = true;
        break; // on passe à la ville suivante plutôt que de planter tout le scraper
      }
      console.log(`📌 Diard (location) - ${links.length} annonces trouvées.`);

      for (const url of links) {
        if (Date.now() - scraperStart > BUDGET_MS) {
          console.warn(`⚠️ Diard (location) - Budget de temps dépassé, arrêt anticipé (run incomplet)`);
          await insertErreur("Diard (location)", url, `Budget de temps dépassé (run incomplet) — ${row.nom}`);
          scrapeIncomplete = true;
          break villeLoop;
        }
        try {
          console.log(`📄 Diard (location) - Page détail : ${url}`);
          const data = await scrapeLocationDetailPage(url);

          if (data.ville && data.loyer) {
            await insertAnnonceLocation({
              type: data.type,
              loyer: data.loyer,
              ville: data.ville,
              pieces: data.pieces,
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
            console.warn(`⚠️ Diard (location) - Données incomplètes pour ${url}`);
            await insertErreur("Diard (location)", url, "Données incomplètes (ville ou loyer manquant)");
          }
        } catch (err) {
          console.error(`❌ Diard (location) - Erreur sur ${url}:`, err.message);
          await insertErreur("Diard (location)", url, String(err));
        }
      }

      currentUrl = nextUrl;
    }
  }

  if (scrapeIncomplete) {
    console.warn("⚠️ Diard (location) - Run incomplet : nettoyage des annonces disparues ignoré pour cette exécution.");
  } else {
    await deleteMissingAnnoncesLocation("Diard", Array.from(new Set(liensActuels)));
  }
  console.log("✅ Diard (location) - Scraping terminé !");
};

export const diardScraper = async () => {
  const villeRows = await getVilleParams("diard");
  if (!villeRows.length) {
    console.warn("⚠️ Diard - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];
  const scraperStart = Date.now();
  let scrapeIncomplete = false;

  villeLoop:
  for (const row of villeRows) {
  let currentUrl = BASE_LIST_URL + encodeURIComponent(row.params.C_65);

  while (currentUrl) {
    if (Date.now() - scraperStart > BUDGET_MS) {
      console.warn(`⚠️ Diard - Budget de temps dépassé, arrêt anticipé (run incomplet)`);
      await insertErreur("Diard", currentUrl, `Budget de temps dépassé (run incomplet) — ${row.nom}`);
      scrapeIncomplete = true;
      break villeLoop;
    }
    console.log(`🔎 Diard - Page de liste : ${currentUrl}`);
    let links, nextUrl;
    try {
      ({ links, nextUrl } = await scrapeListPage(currentUrl));
    } catch (err) {
      if (!err.isRetryable) throw err; // erreur HTTP (500...) : on laisse remonter, pas de faux succès
      console.error(`❌ Diard - Échec persistant sur la page de liste ${currentUrl}: ${err.message}`);
      await insertErreur("Diard", currentUrl, String(err));
      scrapeIncomplete = true;
      break; // on passe à la ville suivante plutôt que de planter tout le scraper
    }
    console.log(`📌 Diard - ${links.length} annonces trouvées.`);

    for (const url of links) {
      if (Date.now() - scraperStart > BUDGET_MS) {
        console.warn(`⚠️ Diard - Budget de temps dépassé, arrêt anticipé (run incomplet)`);
        await insertErreur("Diard", url, `Budget de temps dépassé (run incomplet) — ${row.nom}`);
        scrapeIncomplete = true;
        break villeLoop;
      }
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
  } // fin boucle villes

  if (scrapeIncomplete) {
    console.warn("⚠️ Diard - Run incomplet : nettoyage des annonces disparues ignoré pour cette exécution.");
  } else {
    await deleteMissingAnnonces("Diard", Array.from(new Set(liensActuels)));
  }
  console.log("✅ Diard - Scraping terminé !");
};
