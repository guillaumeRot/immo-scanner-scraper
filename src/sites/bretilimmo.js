import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const bretilimmoScraper = async () => {
  const requestQueue = await RequestQueue.open(`bretilimmo-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://bretilimmo.com/a-vendre/?sort=&type_bien%5B%5D=immeuble&type_bien%5B%5D=maison-villa&localisation%5B%5D=vitre&pieces=&chambres=&minBudget=&maxBudget=400000&minSurface=&maxSurface=&minTerrain=&maxTerrain=&reference=&submit=",
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
        log.info(` Bretil'Immo - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info(" Bretil'Immo - Page chargée.");

        // Attendre que les annonces soient chargées
        await page.waitForSelector(".iwp__item a[href*='/propriete/']", { timeout: 10000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          ".iwp__item a[href*='/propriete/']",
          (anchors) => {
            return anchors
              .map(a => a.href)
              .filter(url => !url.includes('vendu') && !url.includes('estimation-gratuite')); // Exclure les annonces vendues et les pages d'estimation
        });

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(` Bretil'Immo - ${uniqueLinks.length} annonces uniques trouvées sur cette page.`);

        // Vérifier s'il y a une page suivante
        const nextPageUrl = await page.evaluate(() => {
          const nextBtn = document.querySelector('a.next.page-numbers');
          return nextBtn ? nextBtn.href.split('#')[0] : null; // Nettoyer l'URL en retirant tout ce qui suit #
        });
        
        if (nextPageUrl && nextPageUrl !== request.url.split('#')[0]) {
          log.info(` Bretil'Immo - Page suivante détectée : ${nextPageUrl}`);
          await requestQueue.addRequest({
            url: nextPageUrl,
            userData: { label: "LIST_PAGE" },
          });
        } 
        log.info(" Bretil'Immo - Traitement de la page unique terminé.");

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of uniqueLinks) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }
      }

      // Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(` Bretil'Immo - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Extraction des informations principales
          const property = await page.evaluate(() => {
            // Fonction pour nettoyer le texte
            const cleanText = (selector) => 
              document.querySelector(selector)?.textContent.trim() || '';
                        
            // Ville
            const cityElement = document.querySelector('.iwp__header-title__address span');
            const city = cityElement ? Array.from(cityElement.childNodes)
              .find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '')
              ?.textContent.trim() || '' : '';
            
            // Récupération des éléments de la liste d'aperçu
            const overviewItems = Array.from(document.querySelectorAll('.iwp__overview-list li .iwp__overview-item'));
            
            // Type de bien - ciblage par l'ID du SVG
            const typeElement = document.querySelector('svg#g5ere_text-editor')?.closest('.iwp__overview-item')?.querySelector('strong');
            const type = typeElement ? typeElement.textContent.trim() : 'Autre';
            
            // Surface - ciblage par l'ID du SVG
            const surfaceElement = document.querySelector('svg#g5ere_house-plan')?.closest('.iwp__overview-item')?.querySelector('strong');
            const surfaceText = surfaceElement ? surfaceElement.textContent.match(/\d+/)?.[0] || '0' : '0';
            const surface = parseInt(surfaceText) || 0;
            
            // Prix - dernier élément de la liste
            const priceElement = overviewItems[overviewItems.length - 1]?.querySelector('strong');
            const priceText = priceElement ? priceElement.textContent : '';
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;

            // Photos - Récupération depuis la galerie
            const photos = Array.from(document.querySelectorAll('.iwp__header-gallery .figure-item a')).map(link => {
              // Utiliser data-pswp-src si disponible, sinon href, avec une URL absolue
              const imgUrl = link.getAttribute('data-pswp-src') || link.getAttribute('href');
              return imgUrl.startsWith('http') ? imgUrl : `https://bretilimmo.com${imgUrl}`;
            }).filter(url => url); // Filtrer les URLs vides
            
            // Nombre de chambres - ciblage par l'ID du SVG
            const bedroomsElement = document.querySelector('svg#g5ere_bed')?.closest('.iwp__overview-item')?.querySelector('strong');
            const bedroomsText = bedroomsElement ? bedroomsElement.textContent.trim() : '0';
            const bedrooms = parseInt(bedroomsText) || 0;
            
            // Nombre de salles de bain - ciblage par l'ID du SVG
            const bathroomElement = document.querySelector('svg#g5ere_bath')?.closest('.iwp__overview-item')?.querySelector('strong');
            const bathroomText = bathroomElement ? bathroomElement.textContent.trim() : '0';
            const sdb = parseInt(bathroomText) || 0;
            
            // Surface du terrain - ciblage par l'ID du SVG
            const landElement = document.querySelector('svg#g5ere_interface')?.closest('.iwp__overview-item')?.querySelector('strong');
            const landText = landElement ? landElement.textContent.match(/\d+/)?.[0] || '0' : '0';
            const landSurface = parseInt(landText) || null;
            
            // Description
            const descriptionElement = document.querySelector('.iwp__block-description .iwp__card-body');
            const description = descriptionElement ? 
              Array.from(descriptionElement.querySelectorAll('p'))
                .map(p => p.textContent.trim())
                .filter(p => !p.includes('honoraires') && !p.includes('RSAC') && !p.includes('BRETIL'))
                .join('\n\n') 
              : '';
            

            return {
              type,
              price,
              surface,
              landSurface: landSurface,
              bedrooms: bedrooms,
              pieces: bedrooms + 1, // On suppose que le nombre de pièces = chambres + séjour
              sdb: sdb,
              description,
              city,
              photos,
              url: window.location.href,
              source: 'Bretil\'Immo',
              timestamp: new Date().toISOString()
            };
          });
          
          // Vérifier les données et insérer dans la base de données
          if (property.type && property.price) {
            await insertAnnonce({
              type: property.type,
              prix: property.price,
              ville: property.city,
              pieces: property.pieces,
              chambres: property.bedrooms,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "Bretil'Immo",
              lien: request.url,
            });
            liensActuels.push(request.url);
          } else {
            log.warning(`⚠️ Bretil'Immo - Données incomplètes pour ${request.url}`);
            await insertErreur("Bretil'Immo", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`🚨 Bretil'Immo - Erreur pour ${request.url}: ${err.message}`);
          await insertErreur("Bretil'Immo", request.url, err.message);
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Bretil'Immo - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Bretil'Immo", Array.from(new Set(liensActuels)));

  console.log("✅ Bretil'Immo - Scraping Bretil'Immo terminé !");
};
