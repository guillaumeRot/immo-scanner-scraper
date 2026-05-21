import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const blotScraper = async () => {
  const requestQueue = await RequestQueue.open(`blot-${Date.now()}`);

  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.blot-immobilier.fr/page-recherche-avancee/",
    userData: { label: "LIST_PAGE" },
  });

  const liensActuels = [];

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 30,
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

      // 🧭 Étape 1 — Pages de liste
      if (label === "LIST_PAGE") {
        log.info(`🔎 Blot - Page de liste : ${request.url}`);

        await page.goto(request.url);

        // Accepter cookies si présent
        try {
          await page
            .getByRole("button", { name: "Accepter", exact: true })
            .click({ timeout: 5000 });
        } catch (err) {
          log.info("Pas de bannière de cookies trouvée ou déjà acceptée");
        }

        // Si c'est la première page, appliquer les filtres
        if (request.url === "https://www.blot-immobilier.fr/page-recherche-avancee/") {
          try {
            log.info("⚙️  Blot - Application des filtres Blot...");

            // Sélectionner le type de transaction "Acheter"
            await page.waitForSelector('label[for="vente"]', { visible: true, timeout: 10000 });
            await page.check('label[for="vente"]');

            // Sélectionner le type de bien "Maison"
            await page.waitForSelector('label[for="maison"]', { visible: true, timeout: 10000 });
            await page.check('label[for="maison"]');

            // Sélectionner le type de bien "Immeuble"
            await page.waitForSelector('label[for="immeuble"]', { visible: true, timeout: 10000 });
            await page.check('label[for="immeuble"]');

            // Remplir la localisation (Vitré)
            await page.waitForSelector('input#city', { visible: true });
            await page.fill('input#city', 'Vitré');
            await page.waitForTimeout(1000);
            await page.waitForSelector('.ui-menu-item', { timeout: 5000 });
            await page.click('li:has(a:has-text("VITRE (35500)"))');

              // Remplir la localisation (Chateaugiron)
            await page.waitForSelector('input#city', { visible: true });
            await page.fill('input#city', 'Chateaugiron');
            await page.waitForTimeout(1000);
            await page.waitForSelector('.ui-menu-item', { timeout: 5000 });
            await page.click('li:has(a:has-text("CHATEAUGIRON (35410)"))');

            // Définir le prix maximum à 400 000 €
            await page.fill('input#budget', '400000');
            
            // Soumettre le formulaire
            await page.waitForTimeout(1000);
            await page.click('button#submit-search');
            
            log.info("✅ Blot - Filtres appliqués.");

          } catch (e) {
            log.error("❌ Blot - Erreur lors du chargement des résultats avec filtres", { error: String(e) });
            await insertErreur("Blot", request.url, String(e));
          }
        }

        const allLinks = new Set();
        let currentPage = 1;
        let hasNextPage = true;

        while (hasNextPage) {
          await page.waitForSelector('.search-results__item', { timeout: 15000 });
          log.info(`🔍 Blot - Traitement de la page ${currentPage}...`);
          
          // Récupération des liens de la page courante
          const pageLinks = await page.$$eval(
            '.search-results__item .estate-card__top a[href]', 
            anchors => anchors.map(a => a.href)
          );

          // Ajout des liens au Set (évite les doublons) et affichage
          pageLinks.forEach(link => allLinks.add(link));
          
          log.info(`📌 Blot - ${pageLinks.length} annonces trouvées sur la page ${currentPage}.`);
          
          // Vérification de la présence du bouton suivant
          const nextButton = await page.$('li.paginationjs-next.J-paginationjs-next:not(.disabled)');
          
          if (nextButton) {
            log.info("➡️ Blot - Passage à la page suivante...");
            await Promise.all([
              page.waitForSelector('.search-results__item', { timeout: 10000 }),
              nextButton.click(),
            ]);
            currentPage++;
          } else {
            hasNextPage = false;
            log.info("✅ Blot - Dernière page atteinte.");
          }
        }

        // Conversion du Set en tableau et affichage des liens uniques
        const uniqueLinks = Array.from(allLinks);
        log.info(`📊 Blot - Total de ${uniqueLinks.length} annonces uniques trouvées sur toutes les pages.`);

        // Ajout des liens uniques dans la file d'attente
        for (const url of uniqueLinks) {
          await requestQueue.addRequest({ 
            url,
            userData: { label: "DETAIL_PAGE" } 
          });
        }
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Blot - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 15000 });

          const annonce = await page.evaluate(() => {
            // Récupération des images du slider
            const images = Array.from(
              document.querySelectorAll('.top-realty__slider .swiper-slide:not(.swiper-slide-duplicate) img')
            ).map(img => img.src);

            // Extraction du titre
            const title = document.querySelector(".main-realty__title")?.textContent?.trim();
            
            // Extraction du prix (on prend le contenu du span .main-realty__number)
            const priceElement = document.querySelector(".main-realty__price .main-realty__number");
            const price = priceElement?.textContent?.trim() || "Prix non communiqué";
            
            // Extraction de la ville depuis .main-realty__loc-txt
            const villeElement = document.querySelector(".main-realty__loc-txt");
            const ville = villeElement?.textContent?.trim() || "";
            
            // Extraction de la référence
            const ref = document.querySelector(".main-realty__ref")?.textContent?.replace('Réf\u00A0:', '').trim() || "";
            
            // Extraction de la description complète
            const descElement = document.querySelector(".description-realty__txt");
            let description = "";
            if (descElement) {
                // On prend le texte complet en concaténant les deux parties de la description
                const firstPart = document.querySelector(".read-more-txt-first")?.textContent?.replace('Lire plus', '').trim() || "";
                const secondPart = document.querySelector(".read-more-txt-second")?.textContent?.trim() || "";
                description = (firstPart + " " + secondPart).replace(/\s+/g, ' ').trim();
            }

            // Extraction des caractéristiques
            const features = {};
            const featureItems = document.querySelectorAll('.props-realty__item');
            
            featureItems.forEach(item => {
                const icon = item.querySelector('.props-realty__icon')?.className || '';
                const text = item.textContent.replace(/\s+/g, ' ').trim();
                
                if (icon.includes('icon-type-')) {
                    features.type = text;
                } else if (icon.includes('icon-date')) {
                    features.anneeConstruction = text.replace('Construction :', '').trim();
                } else if (icon.includes('icon-rooms')) {
                    features.nbChambres = parseInt(text) || 0;
                } else if (icon.includes('icon-pieces')) {
                    features.nbPieces = parseInt(text) || 0;
                } else if (icon.includes('icon-superficie')) {
                    features.surface = text.replace('Surface :', '').replace('m²', '').trim();
                } else if (icon.includes('icon-land')) {
                    features.surfaceTerrain = text.replace('Surface terrain :', '').replace('m²', '').trim();
                } else if (icon.includes('icon-garages')) {
                    features.nbGarages = parseInt(text) || 0;
                } else if (icon.includes('icon-chauffage')) {
                    features.chauffage = text.replace('Chauffage :', '').trim();
                }
            });

            // Extraction du DPE depuis la classe CSS energy-realty__graph--dpe
            let dpe = "";
            const dpeElement = document.querySelector('.energy-realty__graph--dpe');
            if (dpeElement) {
                // Récupérer toutes les classes et trouver celle qui correspond au pattern energy-realty__graph--[LETTER]
                const classes = dpeElement.className.split(' ');
                const dpeClass = classes.find(cls => cls.match(/energy-realty__graph--[A-Z]$/));
                if (dpeClass) {
                    dpe = dpeClass.slice(-1); // Prendre la dernière lettre
                }
            }

            // Extraction du GES depuis la classe CSS energy-realty__graph--ges
            let ges = "";
            const gesElement = document.querySelector('.energy-realty__graph--ges');
            if (gesElement) {
                // Récupérer toutes les classes et trouver celle qui correspond au pattern energy-realty__graph--[LETTER]
                const classes = gesElement.className.split(' ');
                const gesClass = classes.find(cls => cls.match(/energy-realty__graph--[A-Z]$/));
                if (gesClass) {
                    ges = gesClass.slice(-1); // Prendre la dernière lettre
                }
            }

            return { 
              title: features.type, 
              price,
              ville,
              ref,
              desc: description,
              features,
              images,
              dpe,
              ges,
              // Pour rétrocompatibilité
              photos: images,
              nbPieces: features.nbPieces,
              surface: features.surface
            };
          });

          if (annonce && annonce.title) {
            await insertAnnonce({
              type: annonce.title,
              prix: annonce.price,
              ville: annonce.ville,
              pieces: annonce.nbPieces,
              surface: annonce.surface,
              description: annonce.desc,
              photos: annonce.photos,
              dpe: annonce.dpe,
              ges: annonce.ges,
              agence: "Blot",
              lien: request.url,
            });

            liensActuels.push(request.url);
            log.info(`✅ Blot - Annonce insérée : ${request.url}`);
          } else {
            log.warning(`⚠️ Blot - Données incomplètes pour ${request.url}`);
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`❌ Blot - Erreur sur la page ${request.url}`, { error: errorMessage });
          
          try {
            if (typeof insertErreur === 'function') {
              await insertErreur("Blot", request.url, errorMessage);
            } else {
              log.error("La fonction insertErreur n'est pas disponible");
            }
          } catch (dbError) {
            log.error("Erreur lors de l'enregistrement de l'erreur en base de données:", dbError);
          }
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Blot - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Blot", Array.from(new Set(liensActuels)));

  console.log("✅ Blot - Scraping Blot terminé !");
};
