import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { addExtra } from "playwright-extra";
import { chromium as baseChromium } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

// Le Chromium headless "nu" se fait bloquer par le challenge anti-bot du site
// (headless: false passe, headless: true reste bloqué sur "Challenge Validation").
// Le plugin stealth masque les traces d'automatisation détectées par le challenge.
const chromium = addExtra(baseChromium);
chromium.use(StealthPlugin());

export const ouestFranceScraper = async () => {
  const villeRows = await getVilleParams("ouest-france");
  if (!villeRows.length) {
    console.warn("⚠️ Ouest-France Immo - Aucune ville configurée en base");
    return;
  }
  const lieux = villeRows.map(r => r.params.lieu_id).join(",");

  const requestQueue = await RequestQueue.open(`ouest-france-${Date.now()}`);
  await requestQueue.addRequest({
    url: `https://www.ouestfrance-immo.com/acheter/?prix=0_400000&types=maison,immeuble&lieux=${lieux}`,
    userData: { label: "LIST_PAGE" },
  });

  const liensActuels = [];

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 30,
    maxRequestRetries: 1,
    preNavigationHooks: [
      async ({ blockRequests }) => {
        await blockRequests({
          urlPatterns: [
            ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
            ".css", ".woff", ".woff2", ".ttf",
            "google-analytics", "googletagmanager", "hotjar",
            "mapbox", "facebook", "doubleclick",
          ],
        });
      },
    ],
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
    async requestHandler({ page, request, log }) {
      const { label } = request.userData;

      // Bannière cookies Didomi (peut apparaître sur liste ou détail)
      try {
        const acceptButton = await page
          .waitForSelector("#didomi-notice-agree-button", { timeout: 5000 })
          .catch(() => null);
        if (acceptButton) {
          await acceptButton.click();
        }
      } catch (err) {
        log.warn(`⚠️ Ouest-France Immo - Erreur bannière cookies: ${err.message}`);
      }

      // Étape 1 — Pages de liste
      if (label === "LIST_PAGE") {
        log.info(`🔎 Ouest-France Immo - Page de liste : ${request.url}`);

        await page.goto(request.url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("article.card-annonce", { timeout: 15000 });

        const links = await page.$$eval(
          "article.card-annonce a[href*='/immobilier/vente/'], article.card-annonce a[href*='/vente-maison/']",
          (anchors) => [...new Set(anchors.map((a) => a.href.split("?")[0]))]
        );

        log.info(`📌 Ouest-France Immo - ${links.length} annonces trouvées sur cette page.`);

        for (const url of links) {
          await requestQueue.addRequest({ url, userData: { label: "DETAIL_PAGE" } });
        }

        const nextHref = await page
          .$eval('a[data-t="page-suivante"]', (a) => a.getAttribute("href"))
          .catch(() => null);

        if (nextHref) {
          const nextUrl = nextHref.startsWith("http") ? nextHref : `https://www.ouestfrance-immo.com${nextHref}`;
          log.info(`➡️ Ouest-France Immo - Page suivante détectée : ${nextUrl}`);
          await requestQueue.addRequest({ url: nextUrl, userData: { label: "LIST_PAGE" } });
        }
      }

      // Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Ouest-France Immo - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          const property = await page.evaluate(() => {
            const titleElement = document.querySelector("h2.detail-page__title");
            let type = "Non spécifié";
            let ville = "";
            if (titleElement) {
              const [typeRaw, ...villeParts] = titleElement.textContent.trim().split(" ");
              type = typeRaw.toLowerCase().includes("immeuble") ? "immeuble" : "maison";
              ville = villeParts.join(" ").trim();
            }

            const getInfoValue = (labelText) => {
              const labelEl = Array.from(document.querySelectorAll(".detail-info__label")).find((el) =>
                el.textContent.trim().toLowerCase().includes(labelText.toLowerCase())
              );
              return labelEl?.closest(".detail-info")?.querySelector(".detail-info__value")?.textContent.trim() || "";
            };

            const surface = parseInt(getInfoValue("Surface habitable").replace(/[^0-9]/g, "")) || 0;
            const pieces = parseInt(getInfoValue("Pièces")) || 0;
            const chambres = parseInt(getInfoValue("Chambres")) || 0;
            const prix = parseInt(getInfoValue("Prix").split("€")[0].replace(/[^0-9]/g, "")) || 0;

            const description = Array.from(document.querySelectorAll(".detail-description .detail-description__text-part"))
              .map((p) => p.textContent.trim())
              .filter((t) => t && !t.includes("georisques.gouv.fr"))
              .join("\n");

            const photos = Array.from(document.querySelectorAll(".detail-slider-annonce__photo img[srcset]"))
              .map((img) => {
                const srcset = img.getAttribute("srcset");
                if (!srcset) return null;
                return srcset
                  .split(",")
                  .map((s) => s.trim().split(" "))
                  .filter((parts) => parts.length >= 2)
                  .reduce((largest, current) => (parseInt(current[1]) > parseInt(largest[1] || "0") ? current : largest), ["", "0"])[0];
              })
              .filter(Boolean);

            return { type, ville, prix, surface, pieces, chambres, description, photos };
          });

          if (property.ville && property.prix) {
            await insertAnnonce({
              type: property.type,
              prix: property.prix,
              ville: property.ville,
              pieces: property.pieces,
              chambres: property.chambres,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              dpe: null,
              ges: null,
              agence: "Ouest-France Immo",
              lien: request.url,
            });
            liensActuels.push(request.url);
          } else {
            log.warning(`⚠️ Ouest-France Immo - Données incomplètes pour ${request.url}`);
            await insertErreur("Ouest-France Immo", request.url, "Données incomplètes (ville ou prix manquant)");
          }
        } catch (err) {
          log.error(`❌ Ouest-France Immo - Erreur sur ${request.url}: ${err.message}`);
          await insertErreur("Ouest-France Immo", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Ouest-France Immo - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  await deleteMissingAnnonces("Ouest-France Immo", Array.from(new Set(liensActuels)));
  console.log("✅ Ouest-France Immo - Scraping terminé !");
};
