import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce } from "../db.js";

export const immonotScraper = async () => {
  const requestQueue = await RequestQueue.open(`immonot-${Date.now()}`);

  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.immonot.com/immobilier.do",
    userData: { label: "LIST_PAGE" },
  });

  const liensActuels = [];

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1, // équilibre vitesse / RAM
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 30,
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

      // 🧭 Étape 1 — Pages de liste
      if (label === "LIST_PAGE") {
        log.info(`🔎 Immonot - Page de liste : ${request.url}`);

        await page.goto(request.url);
        await page.waitForLoadState("networkidle", { timeout: 60000 });

        // Accepter cookies si présent
        await page
          .getByRole("button", { name: "Accepter", exact: true })
          .click({ timeout: 5000 })
          .catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 30000 });

        // Si c’est la première page, appliquer les filtres
        if (request.url === "https://www.immonot.com/immobilier.do") {
          try {

            log.info("⚙️  Immonot - Application des filtres Immonot...");

            // Zone de recherche
            await page.waitForTimeout(6000);
            await page.locator("#js-search").getByText("Toute la France").click();

            let input = page.getByRole("textbox", { name: "Ville, département, code" });
            await input.click();
            await input.fill("");

            const city = "Vitré";
            for (const ch of city) {
              await input.type(ch, { delay: 120 });
              await page.waitForTimeout(100);
            }

            // Attendre l'apparition des suggestions et sélectionner la bonne
            const suggestion = page
              .locator('li[data-type="commune"]', { hasText: "Vitré" })
              .first();
            await suggestion.waitFor({ state: "visible", timeout: 10000 });
            await suggestion.click();

            // Ajouter Châteaugiron
            input = page.getByRole("textbox", { name: "Ville, département, code" });
            await input.click();
            await input.fill("");

            const city2 = "Chateaugiron";
            for (const ch of city2) {
              await input.type(ch, { delay: 120 });
              await page.waitForTimeout(100);
            }

            const suggestion2 = page
              .locator('li[data-type="commune"]', { hasText: "Châteaugiron" })
              .first();
            await suggestion2.waitFor({ state: "visible", timeout: 10000 });
            await suggestion2.click();

            // Type d'annonce
            await page.getByText('Aucune sélection').nth(3).click();
            await page.locator('#js-search').getByText('Achat').click();

            // Type de bien
            await page.locator('#js-search').getByText('Aucune sélection').click();
            await page.locator('#js-search').getByText('Maisons').click();
            await page.locator('#js-search').getByText('Afficher plus').click();
            await page.locator('#js-search').getByText('Immeubles').click();

            // Filtre prix max
            await page.locator('span.il-search-item-resume[data-rel="prix"]').click();
            await page.waitForTimeout(1000);
            
            // Remplir le prix maximum
            const maxPriceInput = page.locator('.il-search-box.visible .x-form-slider[data-rel="prix"] input.js-max[type="number"]');
            await maxPriceInput.click();
            await maxPriceInput.fill('400000');
            await maxPriceInput.press('Enter');
            await page.waitForTimeout(1000);
            
            // Lancer la recherche
            await page.locator('button.il-search-btn.js-search-update').click();
            // await page.waitForLoadState("networkidle", { timeout: 60000 });
            log.info("✅ Immonot - Filtres appliqués et résultats chargés.");

          } catch (e) {
            log.error("❌ Immonot - Erreur lors du chargement des résultats avec filtres", { error: String(e) });
            await insertErreur("Immonot", request.url, String(e));
          }
        }

        // Récupération des annonces de la page
        const links = await page.$$eval(".il-card a.js-mirror-link", (els) =>
          els.map((a) => a.href)
        );

        for(var link of links){
          log.info("Immonot - Ajout dans la queue du lien : ", link) 
        }

        log.info(`📌 Immonot - ${links.length} annonces trouvées sur cette page.`);

        // Ajoute chaque lien dans la file pour traitement détail
        for (const url of links) {
          await requestQueue.addRequest({ url, userData: { label: "DETAIL_PAGE" } });
        }

        // Gestion pagination
        const nextUrl = await page
          .$eval("a.page-link[rel='next']", (el) => el?.href)
          .catch(() => null);

        if (nextUrl) {
          log.info("➡️ Immonot - Page suivante détectée, ajout dans la file...");
          await requestQueue.addRequest({ url: nextUrl, userData: { label: "LIST_PAGE" } });
        } else {
          log.info("✅ Immonot - Fin de la pagination détectée.");
        }
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Immonot - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 15000 });

          const annonce = await page.evaluate(() => {
            const title = document.querySelector(".id-title-type")?.textContent?.trim();
            const price = document.querySelector(".id-price-amount")?.textContent?.trim();
            const ville = document.querySelector(".id-title-location")?.textContent?.trim();
            const desc =
              document.querySelector(".id-desc-body")?.textContent?.trim() || "";

            const photos = Array.from(document.querySelectorAll("#js-lightgallery a"))
              .map((a) => a.getAttribute("href"))
              .filter((u) => !!u)
              .map((u) => (u.startsWith("//") ? "https:" + u : u));

            return { title, price, ville, desc, photos };
          });

          if (annonce && annonce.title) {
            await insertAnnonce({
              type: annonce.title,
              prix: annonce.price,
              ville: annonce.ville,
              description: annonce.desc,
              photos: annonce.photos,
              agence: "Immonot",
              lien: request.url,
            });

            liensActuels.push(request.url);
            log.info(`✅ Immonot - Annonce insérée : ${request.url}`);
          } else {
            log.warning(`⚠️ Immonot - Données incomplètes pour ${request.url}`);
          }
        } catch (err) {
          log.error(`❌ Immonot - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Immonot", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Immonot - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Immonot", Array.from(new Set(liensActuels)));

  console.log("✅ Immonot - Scraping Immonot terminé !");
};
