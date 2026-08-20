import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD manquants dans les variables d'environnement");
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
  return transporter;
}

function formatMontant(valeur, suffixe) {
  const n = parseInt(valeur, 10);
  if (!n) return "";
  return `${n.toLocaleString("fr-FR")} €${suffixe}`;
}

function annonceCardHtml(a, { estLocation }) {
  const prix = estLocation ? formatMontant(a.loyer, "/mois") : formatMontant(a.prix, "");
  const photo = Array.isArray(a.photos) ? a.photos[0] : (a.photos ? JSON.parse(a.photos)[0] : null);
  return `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e5e5e5;">
        ${photo ? `<img src="${photo}" width="120" style="border-radius:6px;display:block;margin-bottom:8px;object-fit:cover;height:90px;" alt="">` : ""}
        <div style="font-weight:600;font-size:15px;color:#111;">${a.type || "Bien"} — ${a.ville || ""}</div>
        <div style="color:#444;font-size:14px;">${prix}${a.surface ? ` · ${a.surface} m²` : ""}${a.pieces ? ` · ${a.pieces} pièce(s)` : ""}</div>
        <div style="color:#888;font-size:13px;margin:2px 0 6px;">${a.agence || ""}</div>
        <a href="${a.lien}" style="color:#2563eb;font-size:13px;text-decoration:none;">Voir l'annonce →</a>
      </td>
    </tr>`;
}

function buildDigestHtml(ventes, locations) {
  const sections = [];
  if (ventes.length) {
    sections.push(`
      <h2 style="font-size:16px;color:#111;margin:24px 0 8px;">🏠 Ventes (${ventes.length})</h2>
      <table width="100%" cellpadding="0" cellspacing="0">${ventes.map((a) => annonceCardHtml(a, { estLocation: false })).join("")}</table>
    `);
  }
  if (locations.length) {
    sections.push(`
      <h2 style="font-size:16px;color:#111;margin:24px 0 8px;">🔑 Locations (${locations.length})</h2>
      <table width="100%" cellpadding="0" cellspacing="0">${locations.map((a) => annonceCardHtml(a, { estLocation: true })).join("")}</table>
    `);
  }

  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:16px;">
      <h1 style="font-size:18px;color:#111;">Nouvelles annonces — Vitré / Châteaugiron</h1>
      ${sections.join("")}
    </div>`;
}

/**
 * Envoie un email récapitulatif pour un lot d'annonces nouvellement détectées.
 * Ne fait rien (et ne lève pas d'erreur) si le lot est vide.
 */
export async function sendNewAnnoncesEmail(ventes, locations) {
  const total = ventes.length + locations.length;
  if (total === 0) return;

  const dest = process.env.NOTIFY_EMAIL || process.env.GMAIL_USER;
  const sujet = `🏡 ${total} nouvelle${total > 1 ? "s" : ""} annonce${total > 1 ? "s" : ""} — Vitré / Châteaugiron`;

  await getTransporter().sendMail({
    from: `"Immo Scanner" <${process.env.GMAIL_USER}>`,
    to: dest,
    subject: sujet,
    html: buildDigestHtml(ventes, locations),
  });

  console.log(`✅ Email envoyé (${ventes.length} vente(s), ${locations.length} location(s)) à ${dest}`);
}

function erreurRowHtml(e) {
  const date = new Date(e.date_erreur).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e5e5e5;font-size:13px;">
        <div style="font-weight:600;color:#111;">${e.scraper} <span style="font-weight:400;color:#888;">— ${date}</span></div>
        <div style="color:#b91c1c;margin:2px 0;">${e.message}</div>
        <div style="color:#888;word-break:break-all;">${e.url}</div>
      </td>
    </tr>`;
}

function buildErrorReportHtml(erreurs) {
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:16px;">
      <h1 style="font-size:18px;color:#111;">⚠️ ${erreurs.length} erreur${erreurs.length > 1 ? "s" : ""} scraper — Vitré / Châteaugiron</h1>
      <table width="100%" cellpadding="0" cellspacing="0">${erreurs.map(erreurRowHtml).join("")}</table>
    </div>`;
}

/**
 * Envoie un email récapitulatif des erreurs de scraping pas encore notifiées.
 * Ne fait rien (et ne lève pas d'erreur) si le lot est vide.
 */
export async function sendErrorReportEmail(erreurs) {
  if (erreurs.length === 0) return;

  const dest = process.env.NOTIFY_EMAIL || process.env.GMAIL_USER;
  const sujet = `⚠️ ${erreurs.length} erreur${erreurs.length > 1 ? "s" : ""} scraper — Vitré / Châteaugiron`;

  await getTransporter().sendMail({
    from: `"Immo Scanner" <${process.env.GMAIL_USER}>`,
    to: dest,
    subject: sujet,
    html: buildErrorReportHtml(erreurs),
  });

  console.log(`✅ Email d'erreurs envoyé (${erreurs.length} erreur(s)) à ${dest}`);
}
