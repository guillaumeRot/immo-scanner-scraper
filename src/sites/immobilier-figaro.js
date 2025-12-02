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
              const currentPageItem = await page.locator('ul.pagination .link--current').first();
              const currentPage = currentPageItem ? parseInt(await currentPageItem.textContent()) : 1;
              
              // Vérifier s'il y a une page suivante dans la numérotation
              const nextPageItem = await page.locator(`ul.pagination .link:not(.link--current)`).first();
              
              if (nextPageItem && (await nextPageItem.count()) > 0) {
                // Construire l'URL de la page suivante en incrémentant le numéro de page
                const nextPageNumber = currentPage + 1;
                const currentUrl = new URL(page.url());
                const searchParams = new URLSearchParams(currentUrl.search);
                searchParams.set('page', nextPageNumber);
                currentUrl.search = searchParams.toString();
                const fullNextUrl = currentUrl.toString();
                
                log.info(`➡️ Figaro Immobilier - Page ${nextPageNumber} détectée via la pagination: ${fullNextUrl}`);
                
                await requestQueue.addRequest({
                  url: fullNextUrl,
                  userData: { label: "LIST_PAGE" }
                });
              } else {
                log.info("✅ Figaro Immobilier - Dernière page de la pagination atteinte.");
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

          await page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 60000 });

          await page.waitForSelector('script#__NUXT_DATA__', { state: "attached" });
          const data = await page.$eval('script#__NUXT_DATA__', (el) => JSON.parse(el.textContent));
          
          // Fonction pour extraire les groupes d'images depuis les données JSON
          const extractImageGroups = (data) => {
            const imageGroups = [];
            
            try {
              // Récupérer le nombre de photos total
              let photosCount = 0;
              const findPhotosCount = (obj) => {
                if (!obj || (typeof obj !== 'object' && typeof obj !== 'string')) return;
                
                if (obj.photosCount !== undefined) {
                  photosCount = obj.photosCount;
                  return;
                }
                
                Object.values(obj).forEach(value => {
                  if (Array.isArray(value)) {
                    value.forEach(item => findPhotosCount(item));
                  } else if (value && typeof value === 'object') {
                    findPhotosCount(value);
                  }
                });
              };
              
              // Parcourir les clés du JSON
              let currentGroup = null;
              const processObject = (obj) => {
                if (!obj || (typeof obj !== 'object' && typeof obj !== 'string')) return;

                // Vérifier si c'est le début d'un groupe d'images
                if (obj.order !== undefined && obj.url !== undefined) {
                  // Vérifier si un groupe avec ce numéro d'ordre existe déjà
                  const existingGroupIndex = imageGroups.findIndex(g => g.order === obj.order);
                  
                  if (existingGroupIndex === -1) {
                    // Créer un nouveau groupe uniquement si aucun groupe avec cet ordre n'existe
                    currentGroup = {
                      order: obj.order,
                      urls: []
                    };
                    imageGroups.push(currentGroup);
                  } else {
                    // Ne pas traiter ce groupe car il existe déjà
                    currentGroup = null;
                  }
                } 
                // Si on a un groupe en cours et qu'on trouve une URL d'image
                // else if (currentGroup && typeof obj === 'string' && 
                //         obj.includes('googleusercontent.com')) {
                else if (currentGroup && currentGroup.order <= photosCount && typeof obj === 'string' && 
                        obj.includes('googleusercontent.com')) {
                  let url = obj;
                  if (url.startsWith('//')) {
                    url = 'https:' + url;
                  }
                  // Nettoyer les paramètres de requête pour éviter les doublons
                  url = url.split('?')[0];
                  if (!url.includes('logo') && !url.includes('icon')) {
                    currentGroup.urls.push(url);
                  }
                }
                
                // Parcourir les valeurs de l'objet
                Object.values(obj).forEach(value => {
                  if (Array.isArray(value)) {
                    value.forEach(item => processObject(item));
                  } else if (value && (typeof value === 'object' 
                    || (typeof value === 'string' && value.includes('googleusercontent.com')))) {
                    processObject(value);
                  }
                });
              };
              
              // D'abord trouver le nombre total de photos
              findPhotosCount(data);
              
              // Ensuite traiter les images
              processObject(data);
              
              // Filtrer les groupes vides
              return imageGroups.filter(group => group.urls.length > 0);
              
            } catch (error) {
              console.error('Erreur lors de l\'extraction des groupes d\'images:', error);
              return [];
            }
          };
          
          // Extraire les groupes d'images
          let imageGroups = extractImageGroups(data);
          
          // 1. Supprimer les entrées avec un tableau d'URLs vide
          // 2. Extraire uniquement la première URL de chaque groupe
          const imageUrls = imageGroups
            .filter(group => group.urls.length > 0)
            .map(group => group.urls[0]);

          // Extraction des informations principales
          // Fonction pour nettoyer le texte
          const cleanText = async (selector) => {
            const element = await page.$(selector);
            return element ? (await element.textContent()).trim() : '';
          };
          
          // Fonction pour extraire un nombre d'une chaîne de caractères
          const extractNumber = async (selector) => {
            const element = await page.$(selector);
            if (!element) return 0;
            const text = await element.textContent();
            const match = text?.match(/(\d+)/);
            return match ? parseInt(match[1]) : 0;
          };
          
          // Titre et type de bien
          const titleElement = await page.$('.classified-main-infos-title h1');
          const titleText = titleElement ? (await titleElement.textContent()).toLowerCase() : '';
          
          // Extraction de la ville depuis le h1 > span (format: "à NomDeLaVille (CodePostal)")
          const locationElement = await page.$('h1#classified-main-infos span');
          const locationText = locationElement ? (await locationElement.textContent()).trim() : '';
          // On extrait le texte après "à " et avant la parenthèse
          const locationMatch = locationText.match(/à\s+(.+?)(?=\s*\()/);
          const propertyLocation = locationMatch ? locationMatch[1].trim() : '';
          
          // Prix
          const priceElement = await page.$('.classified-price__detail .classified-price-per-m2 strong');
          const priceText = priceElement ? (await priceElement.textContent()).trim() : '';
          const price = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
          
          // Extraction des caractéristiques
          const features = {};
          
          // Fonction utilitaire pour trouver un élément frère
          const findSiblingWithSelector = async (element, selector) => {
            if (!element) return null;
            const parent = await element.$('xpath=..');
            return parent ? parent.$(selector) : null;
          };

          // Surface habitable (icône .ic-area)
          const surfaceIcon = await page.$('.features-list .ic-area');
          const surfaceElement = surfaceIcon ? await findSiblingWithSelector(surfaceIcon, '.feature') : null;
          const surface = surfaceElement ? await extractNumber('.features-list .ic-area') : 0;
          
          // Surface du terrain (classe .area-ground)
          const groundSurfaceElement = await page.$('.features-list .area-ground .feature');
          const groundSurface = groundSurfaceElement ? await extractNumber('.features-list .area-ground .feature') : 0;
          
          // Nombre de pièces (icône .ic-room)
          const roomsIcon = await page.$('.features-list .ic-room');
          const roomsElement = roomsIcon ? await findSiblingWithSelector(roomsIcon, '.feature') : null;
          const rooms = roomsElement ? await extractNumber('.features-list .ic-room') : 0;
          
          // Nombre de chambres (icône .ic-bedroom)
          const bedroomsIcon = await page.$('.features-list .ic-bedroom');
          const bedroomsElement = bedroomsIcon ? await findSiblingWithSelector(bedroomsIcon, '.feature') : null;
          const bedrooms = bedroomsElement ? await extractNumber('.features-list .ic-bedroom') : 0;
          
          // Description
          const descriptionElement = await page.$('.truncated-description span span');
          const description = descriptionElement ? (await descriptionElement.textContent()).trim() : '';
            
          // Localisation (on prend le texte du premier strong et on enlève les 6 premiers caractères)
          const location = propertyLocation;
          
          // Référence
          const reference = await cleanText('.field--name-field-realty-reference .field__item');
            
          // Extraction des détails supplémentaires
          const details = { pieces: 0, chambres: 0, sdb: 0 };
          
          // Récupérer tous les éléments de caractéristiques
          const featureItems = await page.$$('.field--name-field-realty-features .field__item');
          
          for (const item of featureItems) {
            const text = (await item.textContent()).trim();
            if (text.includes('Pièce(s)')) {
              details.pieces = parseInt(text) || 0;
            } else if (text.includes('Chambre(s)')) {
              details.chambres = parseInt(text) || 0;
            } else if (text.includes('Salle(s) de bain')) {
              details.sdb = parseInt(text) || 0;
            } else if (text.includes('Surface terrain')) {
              const landSurface = parseInt(text.replace(/[^0-9]/g, ''));
              if (!isNaN(landSurface)) details.landSurface = landSurface;
            }
          }

          // Extraction du DPE (Diagnostic de Performance Énergétique)
          let dpe = '';
          try {
            const dpeActiveElement = await page.$('.container-dpe .dpe-list .active');
            if (dpeActiveElement) {
              dpe = await dpeActiveElement.textContent();
              dpe = dpe.trim();
            }
          } catch (error) {
            log.warning('DPE non trouvé ou erreur lors de l\'extraction');
          }

          // Extraction du GES (Indice d'émission de gaz à effet de serre)
          let ges = '';
          try {
            const gesActiveElement = await page.$('.container-ges .ges-list .active');
            if (gesActiveElement) {
              ges = await gesActiveElement.textContent();
              ges = ges.trim();
            }
          } catch (error) {
            log.warning('GES non trouvé ou erreur lors de l\'extraction');
          }

          // Construire l'objet property
          const property = {
            titleText,
            price,
            surface,
            landSurface: details.landSurface || null,
            bedrooms: details.chambres || bedrooms,
            pieces: details.pieces || bedrooms + 1, // On suppose que le nombre de pièces = chambres + séjour
            sdb: details.sdb || 0,
            description,
            location,
            reference,
            photos: imageUrls,
            url: request.url,
            source: 'Figaro Immobilier',
            timestamp: new Date().toISOString(),
            dpe,
            ges
          };
          
          // Vérifier les données et insérer dans la base de données
          if (property.titleText && property.price) {
            await insertAnnonce({
              type: property.titleText,
              prix: property.price,
              ville: property.location,
              pieces: property.pieces,
              chambres: property.bedrooms,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "Figaro Immobilier",
              lien: request.url,
              dpe: property.dpe,
              ges: property.ges
            });
            liensActuels.push(request.url);
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
