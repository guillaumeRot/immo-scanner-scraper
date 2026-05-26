import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

export const figaroImmobilierScraper = async () => {
  const villeRows = await getVilleParams("figaro");
  if (!villeRows.length) {
    console.warn("⚠️ Figaro Immobilier - Aucune ville configurée en base");
    return;
  }
  // La première ville va dans le path, les suivantes en param `location`
  const [primary, ...others] = villeRows;
  const locationSuffix = others.length
    ? "&location=" + others.map(r => r.params.path_slug.replace(/\+/g, "%2B")).join(",")
    : "";
  const LIST_URL =
    `http://immobilier.lefigaro.fr/annonces/immobilier-vente-maison-${primary.params.path_slug}.html` +
    `?types=maison%2Bneuve,atelier,chalet,chambre%2Bd%2Bhote,manoir,moulin,propriete,ferme,gite,villa,immeuble` +
    `&priceMax=400000${locationSuffix}`;

  const requestQueue = await RequestQueue.open(`figaro-immobilier-${Date.now()}`);
  await requestQueue.addRequest({ url: LIST_URL, userData: { label: "LIST_PAGE" } });

  const liensActuels = [];

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 60,
    maxRequestRetries: 2,
    launchContext: {
      launcher: chromium,
      launchOptions: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process",
          "--no-zygote",
        ],
      },
    },
    preNavigationHooks: [
      async ({ blockRequests }) => {
        await blockRequests({
          urlPatterns: [
            ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
            ".css", ".woff", ".woff2", ".ttf",
            "google-analytics", "googletagmanager", "hotjar",
            "mapbox", "facebook", "doubleclick", "pubads",
          ],
        });
      },
    ],
    async requestHandler({ page, request, log }) {
      const { label } = request.userData;

      if (label === "LIST_PAGE") {
        log.info(`Figaro Immobilier - Page de liste : ${request.url}`);

        await page.waitForSelector("ul.list-annonce article.classified-card a.content__link[href]", { timeout: 20000 });

        const links = await page.$$eval(
          "ul.list-annonce article.classified-card a.content__link[href]",
          (anchors) => {
            const seen = new Set();
            return anchors
              .map(a => a.href.startsWith("http") ? a.href : `https://immobilier.lefigaro.fr${a.href}`)
              .filter(href => href.includes("/annonces/annonce-") && !seen.has(href) && seen.add(href));
          }
        );

        log.info(`📌 Figaro Immobilier - ${links.length} annonces trouvées sur cette page.`);

        for (const url of links) {
          await requestQueue.addRequest({ url, userData: { label: "DETAIL_PAGE" } });
        }

        // Pagination
        const currentPageEl = await page.$(".pagination .link--current");
        const currentPage = currentPageEl ? parseInt(await currentPageEl.textContent()) || 1 : 1;
        const hasNext = await page.$('button.btn-pagination[title="Aller à la page suivante"]:not(.disabled)');

        if (hasNext) {
          const baseUrl = request.url.split("&page=")[0];
          await requestQueue.addRequest({
            url: `${baseUrl}&page=${currentPage + 1}`,
            userData: { label: "LIST_PAGE" },
          });
        }
      }

      if (label === "DETAIL_PAGE") {
        try {
          log.info(`Figaro Immobilier - Page détail : ${request.url}`);

          await page.waitForSelector("script#__NUXT_DATA__", { state: "attached", timeout: 30000 });
          const data = await page.$eval("script#__NUXT_DATA__", el => JSON.parse(el.textContent));

          // Extract photos from __NUXT_DATA__ (Nuxt devalue flat array format)
          // Structure: classified.images = { photos: [photo_idx, ...], photosCount: N }
          // Each photo: { order: order_idx, url: sizes_idx }
          // URL sizes: { "extra-large": url_idx, large: url_idx, ... }
          const photos = [];
          if (Array.isArray(data)) {
            // Find the detail response object (has both 'classified' and 'relatedClassifieds' keys)
            let classifiedObj = null;
            for (let i = 0; i < data.length; i++) {
              const el = data[i];
              if (el && typeof el === "object" && !Array.isArray(el) &&
                  typeof el.classified === "number" && typeof el.relatedClassifieds === "number") {
                classifiedObj = data[el.classified];
                break;
              }
            }
            if (classifiedObj && typeof classifiedObj === "object" && typeof classifiedObj.images === "number") {
              const imagesObj = data[classifiedObj.images];
              if (imagesObj && typeof imagesObj === "object" && typeof imagesObj.photos === "number") {
                const photosArr = data[imagesObj.photos];
                if (Array.isArray(photosArr)) {
                  for (const photoIdx of photosArr) {
                    const photo = typeof photoIdx === "number" ? data[photoIdx] : null;
                    if (!photo || typeof photo !== "object") continue;
                    const urlObjIdx = photo.url;
                    if (typeof urlObjIdx !== "number") continue;
                    const urlObj = data[urlObjIdx];
                    if (!urlObj || typeof urlObj !== "object") continue;
                    const sizeIdx = urlObj["extra-large"] ?? urlObj.large ?? urlObj.medium ?? urlObj.small;
                    if (typeof sizeIdx !== "number") continue;
                    const urlStr = data[sizeIdx];
                    if (typeof urlStr !== "string" || !urlStr.includes("googleusercontent.com")) continue;
                    const clean = (urlStr.startsWith("//") ? "https:" + urlStr : urlStr).split("?")[0];
                    if (!photos.includes(clean)) photos.push(clean);
                  }
                }
              }
            }
          }

          const titleEl = await page.$(".classified-main-infos-title h1");
          const titleText = titleEl ? (await titleEl.textContent()).toLowerCase().trim() : "";

          const locationEl = await page.$("h1#classified-main-infos span");
          const locationText = locationEl ? (await locationEl.textContent()).trim() : "";
          const locationMatch = locationText.match(/à\s+(.+?)(?=\s*\()/);
          const ville = locationMatch ? locationMatch[1].trim() : "";

          const priceEl = await page.$(".classified-price__detail .classified-price-per-m2 strong");
          const prix = priceEl ? parseInt((await priceEl.textContent()).replace(/[^0-9]/g, "")) || 0 : 0;

          const getNum = async (sel) => {
            const el = await page.$(sel);
            if (!el) return 0;
            const m = (await el.textContent()).match(/(\d+)/);
            return m ? parseInt(m[1]) : 0;
          };

          const surface = await getNum(".features-list .ic-area ~ .feature");
          const pieces = await getNum(".features-list .ic-room ~ .feature");
          const chambres = await getNum(".features-list .ic-bedroom ~ .feature");

          const descEl = await page.$(".truncated-description span span");
          const description = descEl ? (await descEl.textContent()).trim() : "";

          const dpeEl = await page.$(".container-dpe .dpe-list .active");
          const dpe = dpeEl ? (await dpeEl.textContent()).trim() || null : null;

          const gesEl = await page.$(".container-ges .ges-list .active");
          const ges = gesEl ? (await gesEl.textContent()).trim() || null : null;

          if (titleText && prix) {
            await insertAnnonce({
              type: titleText,
              prix,
              ville,
              pieces,
              chambres,
              surface,
              description,
              photos,
              dpe,
              ges,
              agence: "Figaro Immobilier",
              lien: request.url,
            });
            liensActuels.push(request.url);
          } else {
            log.warning(`⚠️ Figaro Immobilier - Données incomplètes pour ${request.url}`);
            await insertErreur("Figaro Immobilier", request.url, "Données incomplètes (titre ou prix manquant)");
          }
        } catch (err) {
          log.error(`❌ Figaro Immobilier - Erreur sur ${request.url}: ${err.message}`);
          await insertErreur("Figaro Immobilier", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Figaro Immobilier - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  await deleteMissingAnnonces("Figaro Immobilier", Array.from(new Set(liensActuels)));
  console.log("✅ Figaro Immobilier - Scraping terminé !");
};
