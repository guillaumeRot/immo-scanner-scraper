import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur, getVilleParams } from "../db.js";

export const logicImmoScraper = async () => {
  const villeRows = await getVilleParams("logic-immo");
  if (!villeRows.length) {
    console.warn("⚠️ Logic-immo - Aucune ville configurée en base");
    return;
  }
  const locations = villeRows.map(r => r.params.location_code).join(",");

  const requestQueue = await RequestQueue.open(`logic-immo-${Date.now()}`);

  // On démarre par les deux pages de recherche (maison + immeuble)
  await requestQueue.addRequest({
    url: `https://www.logic-immo.com/classified-search?distributionTypes=Buy&estateTypes=House&locations=${locations}&priceMax=400000`,
    userData: { label: "LIST_PAGE" },
  });

  await requestQueue.addRequest({
    url: `https://www.logic-immo.com/classified-search?distributionTypes=Buy&estateTypes=Building&locations=${locations}&priceMax=400000`,
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

      // Étape 1 — Pages de liste
      if (label === "LIST_PAGE") {
        log.info(`Logic-immo - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info("Logic-immo - Page chargée.");

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          "div[data-testid^='serp-core-classified-card-testid'] button[data-base]",
          (buttons) => buttons.map(button => {
            // Extraire l'URL de base et les paramètres
            const baseUrl = decodeURIComponent(button.getAttribute('data-base'));
            const plusParams = button.getAttribute('data-plus') ? 
              decodeURIComponent(button.getAttribute('data-plus')) : '';
            
            // Construire l'URL complète
            return baseUrl + (plusParams ? plusParams : '');
          })
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`📌 Logic-immo - ${uniqueLinks.length} annonces uniques trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of uniqueLinks) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Gestion de la pagination
        try {
          // Vérifier s'il y a un bouton de page suivante
          const nextPageButton = await page.locator('button[aria-label="page suivante"]').first();
          
          if (await nextPageButton.count() > 0) {
            // Récupérer l'URL actuelle
            const currentUrl = new URL(page.url());
            const currentPage = parseInt(currentUrl.searchParams.get('page') || '1');
            
            // Construire l'URL de la page suivante
            currentUrl.searchParams.set('page', (currentPage + 1).toString());
            const nextPageUrl = currentUrl.toString();
            
            log.info(`➡️ Logic-immo - Page suivante détectée: ${nextPageUrl}`);
            
            // Ajouter la page suivante à la file d'attente
            await requestQueue.addRequest({ 
              url: nextPageUrl,
              userData: { label: "LIST_PAGE" }
            });
          } else {
            // Vérifier s'il y a une pagination active mais pas de bouton suivant (dernière page)
            const pagination = await page.locator('nav[aria-label="pagination navigation"]').count();
            if (pagination > 0) {
              log.info("✅ Logic-immo - Dernière page de la pagination atteinte.");
            } else {
              log.info("ℹ️ Logic-immo - Aucune pagination détectée.");
            }
          }
        } catch (error) {
          log.error(`❌ Logic-immo - Erreur lors de la gestion de la pagination: ${error.message}`);
        }
      }

      // Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Logic-immo - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Extraction des informations principales
          const property = await page.evaluate(async () => {
            // Fonction pour nettoyer le texte
            const cleanText = (selector) => {
              const element = document.querySelector(selector);
              return element ? element.textContent.replace(/\s+/g, ' ').trim() : '';
            };
            
            // Titre et type de bien
            const title = cleanText('h1[data-testid="cdp-seo-wrapper"] .css-1nxshv1');
            
            // Prix
            const priceElement = document.querySelector('.css-13l2ek9');
            const priceText = priceElement ? priceElement.textContent : '';
            const price = parseInt(priceText.replace(/\D/g, '')) || 0;
            
            // Extraction des caractéristiques
            let surface = 0;
            let landSurface = 0;
            let pieces = 0;
            let bedrooms = 0;
            
            // Extraire la surface habitable
            const surfaceElement = document.querySelector('.css-7tj8u span:last-child');
            if (surfaceElement) {
              surface = parseInt(surfaceElement.textContent.replace(/[^0-9]/g, '')) || 0;
            }
            
            // Parcourir les éléments de caractéristiques pour les autres infos
            const featureElements = document.querySelectorAll('.css-74uxa4');
            featureElements.forEach(el => {
              const text = el.textContent.trim();
              if (text.includes('m² de terrain')) {
                landSurface = parseInt(text.replace(/[^0-9]/g, '')) || 0;
              } else if (text.includes('chambre')) {
                bedrooms = parseInt(text) || 0;
              } else if (text.includes('pièce') && !text.includes('chambre')) {
                pieces = parseInt(text) || 0;
              }
            });
            
            // Si les pièces ne sont pas trouvées, on les estime
            if (pieces === 0 && bedrooms > 0) {
              pieces = bedrooms + 1; // On suppose séjour + chambres
            }
            
            // Description
            const descriptionElement = document.querySelector('#description + .DescriptionTexts');
            const description = descriptionElement ? descriptionElement.textContent.trim() : '';
            
            // Localisation
            const location = cleanText('button[data-testid="cdp-location-address"] .css-15nnadp');
            
            // Référence
            const referenceMatch = document.querySelector('[data-testid="cdp-classified-keys"]')?.textContent.match(/Référence annonce[^0-9]*([0-9]+)/);
            const reference = referenceMatch ? referenceMatch[1] : '';
            
            // Photos - Fonction pour récupérer toutes les images en faisant défiler
            const getPhotos = async () => {
              const photos = new Set();
              const nextButton = document.querySelector('button[aria-label="aller à la slide suivante"]');
              const pagination = document.querySelector('.css-5e1v2l');
              
              if (!nextButton || !pagination) {
                return [];
              }
              
              // Fonction pour extraire les URLs des photos
              const extractPhotos = () => {
                document.querySelectorAll('img[src*="mms.logic-immo.com"][src*="w=1024"][src*="h=576"]').forEach(img => {
                  const url = img.src;
                  if (url) photos.add(url);
                });
                return Array.from(photos);
              };
              
              // Vérifier s'il y a plusieurs pages de photos
              const paginationText = pagination.textContent || '';
              const match = paginationText.match(/(\d+)\s*\/\s*(\d+)/);
              
              if (match) {
                const current = parseInt(match[1]);
                const total = parseInt(match[2]);
                
                // Si on a déjà toutes les photos, on les retourne
                if (current === total) {
                  return extractPhotos();
                }
                
                // Sinon, on clique sur le bouton suivant jusqu'à avoir tout vu
                let attempts = 0;
                let lastCount = 0;
                
                while (attempts < 20) { // Limite de sécurité
                  // Extraire les photos actuelles
                  const currentPhotos = extractPhotos();
                  
                  // Si on n'a pas trouvé de nouvelles photos, on arrête
                  if (currentPhotos.length > 0 && currentPhotos.length === lastCount) {
                    break;
                  }
                  
                  lastCount = currentPhotos.length;
                  
                  // Vérifier si on a atteint la dernière page
                  const currentPagination = document.querySelector('.css-5e1v2l')?.textContent || '';
                  const currentMatch = currentPagination.match(/(\d+)\s*\/\s*(\d+)/);
                  
                  if (currentMatch && parseInt(currentMatch[1]) >= parseInt(currentMatch[2])) {
                    break;
                  }
                  
                  // Cliquer sur le bouton suivant
                  nextButton.click();
                  await new Promise(resolve => setTimeout(resolve, 500)); // Attendre le chargement
                  attempts++;
                }
              }
              
              return extractPhotos();
            };
            
            const photos = await getPhotos();

            return {
              title: title || 'Bien non spécifié',
              price,
              surface,
              landSurface: landSurface || null,
              bedrooms,
              pieces: pieces || bedrooms + 1,
              sdb: 1,
              description,
              location,
              reference,
              photos,
              url: window.location.href,
              source: 'Logic-immo',
              timestamp: new Date().toISOString()
            };
          });

          console.log(property);
          
          // Vérifier les données et insérer dans la base de données
          if (property.title && property.price) {
            await insertAnnonce({
              type: property.title.split(' ')[0] || 'Non spécifié',
              prix: property.price,
              ville: property.location,
              pieces: property.pieces,
              chambres: property.bedrooms,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "Logic-immo",
              lien: request.url,
            });
          } else {
            log.warning(`⚠️ Logic-immo - Données incomplètes pour ${request.url}`);
            await insertErreur("Logic-immo", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(`❌ Logic-immo - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Logic-immo", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(`🚨 Logic-immo - Échec permanent pour ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Logic-immo", Array.from(new Set(liensActuels)));

  console.log("✅ Logic-immo - Scraping terminé !");
};
