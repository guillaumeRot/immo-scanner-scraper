import express from 'express';
import { chromium } from 'playwright';

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Scraper API en ligne 🚀' });
});

app.post('/screenshot', async (req, res) => {
  const url = req.body.url || 'https://news.ycombinator.com';
  const finalUrl = url.startsWith('http') ? url : `https://${url}`;

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
      ],
    });

    const page = await browser.newPage();
    await page.goto(finalUrl, { timeout: 30000 });
    const screenshot = await page.screenshot({ encoding: 'base64' });
    const pageTitle = await page.title();

    const links = await page.$$eval('a', as =>
      as.map(a => ({
        href: a.href,
        text: a.textContent.trim(),
      }))
    );

    res.json({
      success: true,
      url: finalUrl,
      title: pageTitle,
      screenshot_base64: screenshot,
      links,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`✅ API active sur port ${port}`));
