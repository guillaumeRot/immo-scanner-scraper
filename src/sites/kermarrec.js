import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const kermarrecScraper = async () => {
  const requestQueue = await RequestQueue.open(`kermarrec-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.kermarrec-habitation.fr/achat/?post_type=achat&false-select=on&1d04ea34=chateaugiron&ville%5B%5D=vitre-35500&ville%5B%5D=chateaugiron-35410&typebien%5B%5D=immeuble&typebien%5B%5D=maison&budget_max=400000&reference=&rayon=0&avec_carte=false&tri=pertinence",
    userData: { label: "LIST_PAGE" },
  });

  const liensActuels = [];

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1, // équilibre vitesse / RAM
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 30,
    maxRequestRetries: 1,
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
        log.info(`🔎 Kermarrec - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info("✅ Kermarrec - Page chargée.");
        
        // Popup cookies
        const cookiePopup = page.locator("#didomi-popup");
        if (await cookiePopup.isVisible({ timeout: 5000 }).catch(() => false)) {
            await page.click("button#didomi-notice-agree-button");
        }

        // Attendre que les annonces soient chargées
        await page.waitForSelector("article.list-bien", { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval("article.list-bien a.link-full", (els) =>
          els.map((a) => a.href)
        );

        log.info(`📌 Kermarrec - ${links.length} annonces trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of links) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Gestion pagination
        const nextButton = page.locator("a.next.page-numbers");
        if ((await nextButton.count()) > 0) {
          const nextUrl = await nextButton.getAttribute("href");
          if (nextUrl) {
            log.info("➡️ Kermarrec - Page suivante détectée, ajout dans la file...");
            await requestQueue.addRequest({ 
              url: nextUrl, 
              userData: { label: "LIST_PAGE" } 
            });
          }
        } else {
          log.info("✅ Kermarrec - Fin de la pagination détectée.");
        }
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Kermarrec - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Gérer la popup cookies si elle apparaît
          const cookiePopup = page.locator("#didomi-popup");
          if (await cookiePopup.isVisible({ timeout: 5000 }).catch(() => false)) {
              await page.click("button#didomi-notice-agree-button");
          }

          const annonce = await page.evaluate(() => {
            const title = document.querySelector("h1.entry-title")?.textContent?.trim();
            const price = document.querySelector("span.entry-price")?.textContent?.trim();
            const ville = document.querySelector("span.entry-ville")?.textContent?.trim();
            const pieces = document.querySelector("span.entry-pieces")?.textContent?.trim();
            const surface = document.querySelector("span.entry-surface")?.textContent?.trim();
            
            // Récupérer la description
            let description = '';
            const descElement = document.querySelector("#description p");
            if (descElement) {
              description = descElement.textContent?.trim() || '';
            }

            // Récupérer les photos
            const photos = Array.from(document.querySelectorAll(".entry-medias img"))
              .map(img => img.src)
              .filter(src => src);

            return { 
              title, 
              price, 
              ville, 
              pieces, 
              surface, 
              description, 
              photos 
            };
          });

          if (annonce && annonce.title) {
            await insertAnnonce({
              type: annonce.title,
              prix: annonce.price,
              ville: annonce.ville,
              pieces: annonce.pieces,
              surface: annonce.surface,
              description: annonce.description,
              photos: annonce.photos,
              agence: "Kermarrec",
              lien: request.url,
            });

            liensActuels.push(request.url);
            log.info(`✅ Kermarrec - Annonce insérée : ${request.url}`);
          } else {
            log.warning(`⚠️ Kermarrec - Données incomplètes pour ${request.url}`);
            await insertErreur("Kermarrec", request.url, String("Données incomplètes pour ${request.url}"));
          }
        } catch (err) {
          log.error(`❌ Kermarrec - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Kermarrec", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Kermarrec - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Kermarrec", Array.from(new Set(liensActuels)));

  console.log("✅ Kermarrec - Scraping Kermarrec terminé !");
};
