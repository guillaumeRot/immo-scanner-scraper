import * as cheerio from "cheerio";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

const BASE_URL = "https://www.blot-immobilier.fr";
const AJAX_URL = `${BASE_URL}/wp-admin/admin-ajax.php`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Le plugin WordPress "blot-search" pilote toute la recherche via admin-ajax.php,
// sans protection anti-bot. On rejoue ici les 3 appels utilisés par le formulaire JS
// (town_search -> search_form_validate -> search_form_get_results) puis view_result
// pour le rendu des cartes, au lieu de simuler le formulaire dans un navigateur.

// Reproduit jQuery $.param() : sérialise un objet/tableau imbriqué en x-www-form-urlencoded
// (notation crochets, seule forme comprise par le endpoint PHP côté serveur)
function serialize(obj, prefix) {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) {
        value.forEach((v, i) => {
          if (v !== null && typeof v === "object") parts.push(serialize(v, `${fullKey}[${i}]`));
          else parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(v)}`);
        });
      } else {
        parts.push(serialize(value, fullKey));
      }
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value ?? "")}`);
    }
  }
  return parts.join("&");
}

async function postAjax(body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000 * i));
    const res = await fetch(AJAX_URL, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.ok) return res.json();
  }
  throw new Error(`AJAX fetch failed sur admin-ajax.php`);
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

// Résout la ville en id/lat/long via l'autocomplete, lance la recherche (rayon
// autour de la ville, pas un filtre strict) et retourne les ids d'annonces correspondants.
async function searchIds(nomInput, label) {
  const towns = await postAjax(
    `action=town_search&term=${encodeURIComponent(nomInput)}&type=habitation`
  );
  const town = towns.find((t) => `${t.label} (${t.cp})` === label);
  if (!town) return { ids: [], transaction: "Vente" };

  const form = [
    { name: "action", value: "blot_search" },
    { name: "transaction_principale", value: "" },
    { name: "estate_transaction_type", value: "Vente" },
    { name: "estate_type", value: "maison" },
    { name: "estate_type", value: "immeuble" },
    { name: "estate_address_city", value: town.label },
    { name: `estate_lat_${town.label}`, value: town.lat },
    { name: `estate_lon_${town.label}`, value: town.long },
    { name: "estate_cp", value: town.cp },
    { name: "estate_sell_pricemax", value: "400000" },
  ];
  const validateRes = await postAjax(
    `action=search_form_validate&${serialize({ form, sort: "", only_saled_estate: false, clean_vendu: false })}`
  );
  const getResultsRes = await postAjax(
    `action=search_form_get_results&${serialize({ data: validateRes })}`
  );
  const rawIds = getResultsRes.data?.ids || [];

  // search_form_get_results renvoie aussi les biens déjà vendus (index non nettoyé côté site) :
  // clean_vendus filtre la liste pour ne garder que les biens réellement disponibles.
  const cleanRes = await postAjax(`action=clean_vendus&${serialize({ results: rawIds })}`);
  const ids = cleanRes.data?.results || rawIds;

  return { ids, transaction: validateRes.data?.transaction || "Vente" };
}

// La recherche couvre un rayon (communes voisines incluses) : le tri par ville exacte
// se fait à la fiche détail, comme pour Bretil'Immo. Les biens déjà vendus restent dans
// les résultats de recherche (pas filtrés côté serveur) mais portent un badge
// ".estate-card__flag" = "Déjà vendu par blot" qu'on peut exclure sans charger la fiche.
async function fetchLinksForIds(ids, transaction) {
  const links = new Set();
  for (let i = 0; i < ids.length; i += 21) {
    const page = ids.slice(i, i + 21);
    const viewRes = await postAjax(
      `action=view_result&${serialize({ data: page })}&transaction=${encodeURIComponent(transaction)}`
    );
    const htmlArr = Array.isArray(viewRes.data?.html) ? viewRes.data.html : [viewRes.data?.html || ""];
    const $ = cheerio.load(htmlArr.join(""));
    $(".search-results__item").each((_, el) => {
      const flag = $(el).find(".estate-card__flag").text().trim().toLowerCase();
      if (flag.includes("vendu")) return;
      const href = $(el).find(".estate-card__top a[href]").first().attr("href");
      if (href) links.add(href.startsWith("http") ? href : `${BASE_URL}${href}`);
    });
  }
  return [...links];
}

function getSpec($, iconClass) {
  let value = "";
  $(".props-realty__item").each((_, el) => {
    if ($(el).find(`.props-realty__icon.${iconClass}`).length) {
      // Retirer <sup>2</sup> (exposant de m²) avant lecture du texte, sinon "98 m²" -> "982" après nettoyage
      const txt = $(el).find(".props-realty__txt").clone();
      txt.find("sup").remove();
      value = txt.text().replace(/\s+/g, " ").trim();
    }
  });
  return value;
}

// DPE et GES sont encodés dans la classe CSS du graphe : energy-realty__graph--dpe|ges energy-realty__graph--{LETTRE}
function getDiagClasse($, keyword) {
  const el = $(`[class*="energy-realty__graph--${keyword}"]`).first();
  const classes = (el.attr("class") || "").split(" ");
  const letterClass = classes.find((c) => /^energy-realty__graph--[A-G]$/.test(c));
  return letterClass ? letterClass.slice(-1) : null;
}

async function scrapeDetailPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const titleText = $(".main-realty__title").first().text().trim();
  const type = titleText.split(" ")[0] || "Non spécifié";
  const prix = parseInt($(".main-realty__price .main-realty__number").first().text().replace(/[^0-9]/g, "")) || 0;
  const ville = $(".main-realty__loc-txt").first().text().trim();
  const description = $(".description-realty__txt").first().text().replace(/\s+/g, " ").trim();

  const surface = parseFloat(getSpec($, "icon-superficie").replace(/[^0-9,.]/g, "").replace(",", ".")) || 0;
  const chambres = parseInt(getSpec($, "icon-rooms")) || 0;
  const pieces = parseInt(getSpec($, "icon-pieces")) || 0;

  const photos = [];
  $(".top-realty__slider img.top-realty__img").each((_, el) => {
    const src = $(el).attr("src");
    if (src && !photos.includes(src)) photos.push(src);
  });

  const dpe = getDiagClasse($, "dpe");
  const ges = getDiagClasse($, "ges");

  return { type, prix, ville, surface, pieces, chambres, description, photos, dpe, ges };
}

export const blotScraper = async () => {
  const villeRows = await getVilleParams("blot");
  if (!villeRows.length) {
    console.warn("⚠️ Blot - Aucune ville configurée en base");
    return;
  }

  const liensActuels = [];

  for (const row of villeRows) {
    console.log(`🔎 Blot - Recherche pour ${row.params.nom_input}...`);
    const { ids, transaction } = await searchIds(row.params.nom_input, row.params.label);
    console.log(`📌 Blot - ${ids.length} annonces trouvées dans le rayon de recherche.`);

    const links = await fetchLinksForIds(ids, transaction);

    for (const url of links) {
      try {
        console.log(`📄 Blot - Page détail : ${url}`);
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
            agence: "Blot",
            lien: url,
          });
          liensActuels.push(url);
        } else {
          console.warn(`⚠️ Blot - Données incomplètes pour ${url}`);
          await insertErreur("Blot", url, "Données incomplètes (ville ou prix manquant)");
        }
      } catch (err) {
        console.error(`❌ Blot - Erreur sur ${url}:`, err.message);
        await insertErreur("Blot", url, String(err));
      }
    }
  }

  await deleteMissingAnnonces("Blot", Array.from(new Set(liensActuels)));
  console.log("✅ Blot - Scraping terminé !");
};
