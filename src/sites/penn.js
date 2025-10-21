import { PlaywrightCrawler, RequestQueue } from "crawlee";
import { chromium } from "playwright";
import { deleteMissingAnnonces, insertAnnonce, insertErreur } from "../db.js";

export const pennScraper = async () => {
  const requestQueue = await RequestQueue.open(`penn-${Date.now()}`);
  
  // On démarre par la première page des annonces
  await requestQueue.addRequest({
    url: "https://www.penn-immobilier.com/nos-biens/xdpemrqtp4buydnf99nh9kerfqiayzh3imfyje44jebrsyzmou7q6h3enzade8wot9r54jszgx4f537jrwf9kf5rqbkty9a8jmajdyhn8t4w3m6tqdyctxcdxj8jad1cpogj5htn3hfuuqq1zginiqb6nshgcag1n1obpshr9k8mphp5e3wjzmpgswqdam7ndrscscbef6xiu4z5rpp8anyimf7jpmamm6idfckcb6t66wguh4398s8j3qqutopgtu1d5cz5a9o83889eeahnitqdkwgnhizy3qwsqr6yko7x7auozr8pde1e1fcp7b9s68cupbjum5uwin4oxpnxm464gw8xcdktpkn4apgg6w9m96i6rxgwoy9mg8ocxk8n8exx1ydmf3fd4s84ydiht1cfonw558djn3rh686ygmoumga/1",
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
        log.info(`🔎 Penn - Page de liste : ${request.url}`);

        await page.goto(request.url);
        log.info("✅ Penn - Page chargée.");
        
        // Popup cookies
        const cookiePopup = page.locator("#didomi-popup");
        if (await cookiePopup.isVisible({ timeout: 5000 }).catch(() => false)) {
            await page.click("button#didomi-notice-agree-button");
        }

        // Attendre que les annonces soient chargées
        await page.waitForSelector(".property-listing-v3__item", { timeout: 15000 });

        // Extraire les liens des annonces avec gestion des URLs relatives
        const links = await page.$$eval(
          ".property-listing-v3__item .item__drawing > a[href]",
          (anchors, baseUrl) => {
            const uniqueLinks = new Set();
            anchors.forEach(a => {
              let href = a.getAttribute('href');
              if (href && !href.includes('/i/') && !href.includes('javascript:')) {
                // Convertir les URLs relatives en absolues
                if (href.startsWith('/')) {
                  href = `${baseUrl}${href}`;
                } else if (!href.startsWith('http')) {
                  href = `${baseUrl}/${href}`;
                }
                uniqueLinks.add(href);
              }
            });
            return Array.from(uniqueLinks);
          },
          'https://www.penn-immobilier.com' // Passer l'URL de base comme argument
        );

        log.info(`📌 Penn - ${links.length} annonces uniques trouvées sur cette page.`);

        // Ajouter chaque lien dans la file pour traitement détaillé
        for (const url of links) {
          if (url && !url.includes('javascript:')) {
            await requestQueue.addRequest({
              url,
              userData: { label: "DETAIL_PAGE" },
              skipNavigation: true
            });
            log.debug(`✅ Annonce ajoutée à la file : ${url}`);
          }
        }

        log.info("✅ Penn - Extraction des annonces terminée pour cette page.");
      }

      // 🏡 Étape 2 — Pages de détail
      if (label === "DETAIL_PAGE") {
        try {
          log.info(`📄 Penn - Page détail : ${request.url}`);

          await page.goto(request.url, { waitUntil: "domcontentloaded" });

          // Gérer la popup cookies si elle apparaît
          const cookiePopup = page.locator("#didomi-popup");
          if (await cookiePopup.isVisible({ timeout: 5000 }).catch(() => false)) {
              await page.click("button#didomi-notice-agree-button");
          }

          // Fonction utilitaire pour extraire les données du tableau
          const getTableValue = async (title) => {
            const rows = await page.$$('.table-aria__tr');
            for (const row of rows) {
              const titleEl = await row.$('.table-aria__td--title');
              if (titleEl) {
                const text = await titleEl.textContent();
                if (text.trim() === title) {
                  const valueEl = await row.$('.table-aria__td--value');
                  return valueEl ? (await valueEl.textContent()).trim() : '';
                }
              }
            }
            return '';
          };

          const venteLi = page.locator('li:has-text("Vente")');

          // Extraire le titre
          const secondAfter = venteLi.locator('xpath=following-sibling::li[2]');
          let title = await secondAfter.textContent();
          
          // Extraire la localisation
          const firstAfter = venteLi.locator('xpath=following-sibling::li[1]');
          let location = await firstAfter.textContent();
          
          // Extraire les prix et caractéristiques
          const priceText = (await getTableValue('Prix de vente honoraires TTC inclus')).replace(/[^0-9]/g, '');
          const price = parseInt(priceText) || 0;
          
          const feesText = (await getTableValue('Honoraires TTC à la charge acquéreur')).replace(/[^0-9,]/g, '').replace(',', '.');
          const fees = parseFloat(feesText) || 0;
          
          const netPriceText = (await getTableValue('Prix de vente honoraires TTC exclus')).replace(/[^0-9]/g, '');
          const netPrice = parseInt(netPriceText) || 0;

          const surfaceText = (await getTableValue('Surface habitable (m²)')).replace(' m²', '').replace(',', '.');
          const surface = parseFloat(surfaceText) || null;
          
          const bedroomsText = await getTableValue('Nombre de pièces');
          const bedrooms = parseInt(bedroomsText) || 0;
          
          const bathrooms = 0; // Non disponible dans le tableau fourni
          const parking = (await getTableValue('Cave')) === 'OUI' ? 1 : 0;
          
          // Extraire la description
          const descriptionEl = await page.$('.main-info__text-block p');
          const description = descriptionEl ? (await descriptionEl.textContent()).trim() : '';

          // Extraire les photos
          const photoLinks = await page.$$eval('.slider-img__swiper-slide a[href*="/original/"]', anchors => 
            anchors.map(a => {
              let href = a.getAttribute('href');
              return href.startsWith('//') ? `https:${href}` : href;
            })
          );

          // Si pas de photos, essayer avec les miniatures
          if (photoLinks.length === 0) {
            const thumbnails = await page.$$('.slider-img__img[data-src]');
            for (const img of thumbnails) {
              let src = await img.getAttribute('data-src');
              if (src) {
                src = src
                  .replace('/580xauto/', '/original/')
                  .replace('/980xauto/', '/original/')
                  .replace('/1600xauto/', '/original/');
                const fullUrl = src.startsWith('//') ? `https:${src}` : src;
                if (!photoLinks.includes(fullUrl)) {
                  photoLinks.push(fullUrl);
                }
              }
            }
          }

          // Extraire la référence
          const refEl = await page.$(".item__info-id");
          const reference = refEl ? (await refEl.textContent()).replace('Réf :', '').trim() : '';

          // Construire l'objet property
          const property = {
            title,
            price,
            surface,
            bedrooms,
            bathrooms,
            parking,
            location,
            description,
            photos: photoLinks,
            reference,
            netPrice,
            fees,
            url: page.url()
          };

          // Enregistrer l'annonce en base de données
          try {
            await insertAnnonce({
              type: property.title,
              prix: property.price,
              ville: property.location,
              pieces: property.bedrooms + 1,
              chambres: property.bedrooms,
              surface: property.surface,
              description: property.description,
              photos: property.photos,
              agence: "Penn",
              lien: request.url,
            });
            log.info(`✅ Annonce ${property.reference} enregistrée avec succès.`);
          } catch (error) {
            log.error(`❌ Erreur lors de l'enregistrement de l'annonce:`, error);
            throw error;
          }

          liensActuels.push(request.url);
        } catch (error) {
          log.error(`❌ Penn - Erreur sur la page ${request.url}`, { error: error.message });
          
          // Enregistrer l'erreur en base de données
          try {
            await insertErreur(
              "penn",
              request.url,
              `Erreur lors du scraping: ${error.message}`,
              new Date()
            );
            log.info("⚠️ Erreur enregistrée pour Penn:", error);
          } catch (dbError) {
            log.error("❌ Impossible d'enregistrer l'erreur en base de données:", dbError);
          }
        }
      }
    },
  });

  await crawler.run();

  // Nettoyer les annonces manquantes
  await deleteMissingAnnonces("Penn", Array.from(new Set(liensActuels)));

  console.log("✅ Penn - Scraping Penn terminé !");
};