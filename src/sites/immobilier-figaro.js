import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const figaroImmobilierScraper = async () => {
  const requestQueue = await RequestQueue.open(`figaro-immobilier-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "http://immobilier.lefigaro.fr/annonces/immobilier-vente-maison-vitre+35500.html?types=maison%2Bneuve,atelier,chalet,chambre%2Bd%2Bhote,manoir,moulin,propriete,ferme,gite,villa,immeuble&priceMax=400000&location=chateaugiron%2B35410",
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
        log.info(` Figaro Immobilier - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info(" Figaro Immobilier - Page chargée.");

        // Attendre que les annonces soient chargées
        await page.waitForSelector("ul.list-annonce article.classified-card a.content__link[href]", { timeout: 15000 });

        // Récupérer les liens des annonces de la page
        const links = await page.$$eval(
          "ul.list-annonce article.classified-card a.content__link[href]",
          (anchors) => {
            // Créer un ensemble pour éviter les doublons
            const uniqueLinks = new Set();
            anchors.forEach(a => {
              if (a.href && a.href.includes('/annonces/annonce-')) {
                // S'assurer que l'URL est complète
                const fullUrl = a.href.startsWith('http') ? a.href : `https://immobilier.lefigaro.fr${a.href}`;
                uniqueLinks.add(fullUrl);
              }
            });
            return Array.from(uniqueLinks);
          }
        );

        // Filtrer les doublons
        const uniqueLinks = [...new Set(links)];
        log.info(`📌 Figaro Immobilier - ${uniqueLinks.length} annonces uniques trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of uniqueLinks) {
          await requestQueue.addRequest({ 
            url, 
            userData: { label: "DETAIL_PAGE" } 
          });
        }

        // Gestion de la pagination
        try {
          // Vérifier s'il y a un lien "Suivant" non désactivé
          const nextLink = await page.locator('a.btn-pagination[rel="next"]:not(.disabled)').first();
          
          if (await nextLink.count() > 0) {
            // Récupérer l'URL de la page suivante
            const nextPageUrl = await nextLink.getAttribute('href');
            
            if (nextPageUrl) {
              // Construire l'URL complète si nécessaire
              const fullNextUrl = nextPageUrl.startsWith('http') 
                ? nextPageUrl 
                : `https://immobilier.lefigaro.fr${nextPageUrl}`;
              
              log.info(`➡️ Figaro Immobilier - Page suivante détectée: ${fullNextUrl}`);
              
              // Ajouter la page suivante à la file d'attente
              await requestQueue.addRequest({ 
                url: fullNextUrl,
                userData: { label: "LIST_PAGE" }
              });
            } else {
              log.info("✅ Figaro Immobilier - Dernière page de la pagination atteinte (pas d'URL suivante).");
            }
          } else {
            // Vérifier s'il y a une pagination avec des numéros de page
            const hasPagination = await page.locator('ul.pagination').count() > 0;
            
            if (hasPagination) {
              // Récupérer le numéro de page actuel
              const currentPageItem = await page.locator('ul.pagination .pagination__link--current').first();
              const currentPage = currentPageItem ? parseInt(await currentPageItem.textContent()) : 1;
              
              // Vérifier s'il y a une page suivante dans la numérotation
              const nextPageItem = await page.locator(`ul.pagination .pagination__link[title="Aller à la page ${currentPage + 1}"]`).first();
              
              if (nextPageItem && (await nextPageItem.count()) > 0) {
                const nextPageUrl = await nextPageItem.getAttribute('href');
                if (nextPageUrl) {
                  const fullNextUrl = nextPageUrl.startsWith('http')
                    ? nextPageUrl
                    : `https://immobilier.lefigaro.fr${nextPageUrl}`;
                  
                  log.info(`➡️ Figaro Immobilier - Page ${currentPage + 1} détectée via la pagination: ${fullNextUrl}`);
                  
                  await requestQueue.addRequest({
                    url: fullNextUrl,
                    userData: { label: "LIST_PAGE" }
                  });
                } else {
                  log.info("✅ Figaro Immobilier - Dernière page de la pagination atteinte (pas de page suivante dans la numérotation).");
                }
              } else {
                log.info("✅ Figaro Immobilier - Dernière page de la pagination atteinte (pas de page suivante).");
              }
            } else {
              log.info("ℹ️ Figaro Immobilier - Aucune pagination détectée.");
            }
          }
        } catch (error) {
          log.error(` Figaro Immobilier - Erreur lors de la gestion de la pagination: ${error.message}`);
          await insertErreur("Figaro Immobilier", "N/A", `Erreur inattendue: ${error.message}`);
        }
      }

      // Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(` Figaro Immobilier - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Extraction des informations principales
          const property = await page.evaluate(async () => {
            // Fonction pour nettoyer le texte
            const cleanText = (selector) => 
              document.querySelector(selector)?.textContent.trim() || '';
            
            // Titre et type de bien
            const titleElement = document.querySelector('.classified-main-infos-title h1');
            const titleText = titleElement ? titleElement.textContent.toLowerCase() : '';
            
            let type = 'Autre';
            if (titleText.includes('maison')) {
              type = 'Maison';
            } else if (titleText.includes('appartement')) {
              type = 'Appartement';
            } else if (titleText.includes('immeuble')) {
              type = 'Immeuble';
            } else if (titleText.includes('terrain')) {
              type = 'Terrain';
            } else if (titleText.includes('local') || titleText.includes('bureau')) {
              type = 'Local professionnel';
            }
            
            // Extraction de la ville depuis le h1 > span (format: "à NomDeLaVille (CodePostal)")
            const locationElement = document.querySelector('h1#classified-main-infos span');
            const locationText = locationElement ? locationElement.textContent.trim() : '';
            // On extrait le texte après "à " et avant la parenthèse
            const locationMatch = locationText.match(/à\s+(.+?)(?=\s*\()/);
            const propertyLocation = locationMatch ? locationMatch[1].trim() : '';
            const title = `${type} à ${propertyLocation}`;
            
            // Prix
            const priceElement = document.querySelector('.classified-price__detail .classified-price-per-m2 strong');
            const priceText = priceElement ? priceElement.textContent.trim() : '';
            const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
            
            // Extraction des caractéristiques
            const features = {};
            
            // Fonction pour extraire un nombre d'une chaîne de caractères
            const extractNumber = (text) => {
              const match = text?.match(/(\d+)/);
              return match ? parseInt(match[1]) : 0;
            };
            
            // Surface habitable (icône .ic-area)
            const surfaceElement = document.querySelector('.features-list .ic-area')?.closest('li')?.querySelector('.feature');
            const surface = extractNumber(surfaceElement?.textContent);
            
            // Surface du terrain (classe .area-ground)
            const groundSurfaceElement = document.querySelector('.features-list .area-ground .feature');
            const groundSurface = extractNumber(groundSurfaceElement?.textContent);
            
            // Nombre de pièces (icône .ic-room)
            const roomsElement = document.querySelector('.features-list .ic-room')?.closest('li')?.querySelector('.feature');
            const rooms = extractNumber(roomsElement?.textContent);
            
            // Nombre de chambres (icône .ic-bedroom)
            const bedroomsElement = document.querySelector('.features-list .ic-bedroom')?.closest('li')?.querySelector('.feature');
            const bedrooms = extractNumber(bedroomsElement?.textContent);
            
            // Description
            const descriptionElement = document.querySelector('.truncated-description span span');
            const description = descriptionElement ? descriptionElement.textContent.trim() : '';
            
            // Localisation (on prend le texte du premier strong et on enlève les 6 premiers caractères)
            const location = propertyLocation;
            
            // Référence
            const reference = cleanText('.field--name-field-realty-reference .field__item');
            
            // Récupération des images depuis la galerie
            let photos = [];
            try {
              // Fonction pour extraire les images de la galerie
              photos = await page.evaluate(() => {
                const images = [];

                console.log('images', images);
                
                // Essayer de trouver le bouton "Voir les photos"
                const viewPhotosButton = document.querySelector('.button-container .btn-secondary');
                if (viewPhotosButton) {
                  viewPhotosButton.click();
                  // Ne pas attendre ici, la galerie se chargera en arrière-plan
                }
                
                // D'abord essayer de récupérer les images de la galerie
                const galleryImages = Array.from(document.querySelectorAll('.classified-medias-gallery img[src]'));
                if (galleryImages.length > 0) {
                  return galleryImages.map(img => ({
                    url: img.src,
                    alt: img.alt || ''
                  }));
                }
                
                // Sinon, essayer de récupérer les miniatures
                const thumbnails = Array.from(document.querySelectorAll('.classified-medias__picture img[src]'));
                if (thumbnails.length > 0) {
                  return thumbnails.map(img => ({
                    url: img.src,
                    alt: img.alt || ''
                  }));
                }
                
                return [];
              });
            } catch (error) {
              console.error('Erreur lors de l\'extraction des images:', error);
            }

            // Fallback sur la méthode classique si pas d'images trouvées
            if (photos.length === 0) {
              const fallbackImages = document.querySelectorAll('.popup-galerie a.image-galerie[href*="/sites/default/files/"]');
              if (fallbackImages.length > 0) {
                photos = Array.from(fallbackImages).map(a => {
                  const href = a.getAttribute('href');
                  return {
                    url: href,
                    alt: ''
                  };
                }).filter(Boolean);
              }
            }

            // Extraction des détails supplémentaires
            const details = {};
            document.querySelectorAll('.field--name-field-realty-features .field__item').forEach(item => {
              const text = item.textContent.trim();
              if (text.includes('Pièce(s)')) details.pieces = parseInt(text) || 0;
              if (text.includes('Chambre(s)')) details.chambres = parseInt(text) || 0;
              if (text.includes('Salle(s) de bain')) details.sdb = parseInt(text) || 0;
              if (text.includes('Surface terrain')) {
                const landSurface = parseInt(text.replace(/[^0-9]/g, ''));
                if (!isNaN(landSurface)) details.landSurface = landSurface;
              }
            });

            return {
              title,
              price,
              surface,
              landSurface: details.landSurface || null,
              bedrooms: details.chambres || bedrooms,
              pieces: details.pieces || bedrooms + 1, // On suppose que le nombre de pièces = chambres + séjour
              sdb: details.sdb || 0,
              description,
              location,
              reference,
              photos,
              url: window.location.href,
              source: 'Figaro Immobilier',
              timestamp: new Date().toISOString()
            };
          });

          log.info(` Figaro Immobilier - Extraction des données : `, property);
          
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
              agence: "Figaro Immobilier",
              lien: request.url,
            });
          } else {
            log.warning(` Figaro Immobilier - Données incomplètes pour ${request.url}`);
            await insertErreur("Figaro Immobilier", request.url, "Données incomplètes");
          }
        } catch (err) {
          log.error(` Figaro Immobilier - Erreur sur la page ${request.url}`, { error: String(err) });
          await insertErreur("Figaro Immobilier", request.url, String(err));
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.error(` Figaro Immobilier - Erreur lors du scraping: ${request.url}`);
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Figaro Immobilier", Array.from(new Set(liensActuels)));

  console.log(" Figaro Immobilier - Scraping terminé.");
};
