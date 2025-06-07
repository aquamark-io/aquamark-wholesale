const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PDFDocument, degrees } = require("pdf-lib");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
const QRCode = require("qrcode");

const app = express();
const port = process.env.PORT;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors());
app.use(fileUpload());

app.post("/watermark", async (req, res) => {
  const apiKey = req.headers.authorization?.split(" ")[1];
  const userEmail = req.body.user_email;
  const salesperson = req.body.salesperson || "unknown";
  const processor = req.body.processor || "unknown";
  const lender = req.body.lender || "unknown";

  if (apiKey !== process.env.AQUAMARK_API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  if (!req.files || !req.files.file || !userEmail) {
    return res.status(400).send("Missing file or user_email");
  }

  const file = req.files.file;

  // 🔍 Fetch user from partner table
  const { data: userRecord, error: userErr } = await supabase
    .from(process.env.PARTNER_TABLE)
    .select("*")
    .eq("user_email", userEmail)
    .single();

  if (userErr || !userRecord) {
    return res.status(401).send("Invalid user");
  }

  const usage = userRecord.pages_used || 0;

  // 🔓 Decrypt if needed
  let pdfBytes = file.data;
  try {
    await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  } catch {
    fs.writeFileSync("input.pdf", pdfBytes);
    await new Promise((resolve) => {
      exec(`qpdf --decrypt input.pdf decrypted.pdf`, (err) => {
        if (!err) {
          pdfBytes = fs.readFileSync("decrypted.pdf");
        }
        resolve();
      });
    });
    fs.unlinkSync("input.pdf");
    if (fs.existsSync("decrypted.pdf")) fs.unlinkSync("decrypted.pdf");
  }

  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  // 🖼️ Fetch logo
  const logoFilename = `${userEmail}.png`;
  const { data: logoUrlData } = supabase.storage.from("wholesale.logos").getPublicUrl(logoFilename);
  const logoRes = await fetch(logoUrlData.publicUrl);
  if (!logoRes.ok) return res.status(404).send("Logo fetch failed");

  const logoBytes = await logoRes.arrayBuffer();

  // 🔐 Generate QR code
  const today = new Date().toISOString().split("T")[0];
  const payload = encodeURIComponent(`ProtectedByAquamark|${userEmail}|${lender}|${salesperson}|${processor}|${today}`);
  const qrText = `https://aquamark.io/q.html?data=${payload}`;
  const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 0, scale: 5 });
  const qrImageBytes = Buffer.from(qrDataUrl.split(",")[1], "base64");

  // ➕ Create watermark overlay page
  const watermarkDoc = await PDFDocument.create();
  const watermarkImage = await watermarkDoc.embedPng(logoBytes);
  const qrImage = await watermarkDoc.embedPng(qrImageBytes);

  const { width, height } = pdfDoc.getPages()[0].getSize();
  const watermarkPage = watermarkDoc.addPage([width, height]);

  const logoWidth = width * 0.2;
  const logoHeight = (logoWidth / watermarkImage.width) * watermarkImage.height;

  for (let x = 0; x < width; x += (logoWidth + 150)) {
    for (let y = 0; y < height; y += (logoHeight + 150)) {
      watermarkPage.drawImage(watermarkImage, {
        x,
        y,
        width: logoWidth,
        height: logoHeight,
        opacity: 0.15,
        rotate: degrees(45),
      });
    }
  }

  watermarkPage.drawImage(qrImage, {
    x: width - 35,
    y: 15,
    width: 20,
    height: 20,
    opacity: 0.4,
  });

  const watermarkPdfBytes = await watermarkDoc.save();
  const watermarkEmbedDoc = await PDFDocument.load(watermarkPdfBytes);
  const [embeddedPage] = await pdfDoc.embedPages([watermarkEmbedDoc.getPages()[0]]);

  // 🧷 Overlay watermark on each page
  pdfDoc.getPages().forEach((page) => {
    page.drawPage(embeddedPage, { x: 0, y: 0, width, height });
  });

  // 📈 Update usage
  const numPages = pdfDoc.getPageCount();
  const updatedPagesUsed = usage + numPages;

  await supabase
    .from(process.env.PARTNER_TABLE)
    .update({ pages_used: updatedPagesUsed })
    .eq("user_email", userEmail);

  const finalPdf = await pdfDoc.save();

    // 📜 Optional: Add state disclaimer if applicable
const stateInput = (req.body.state || "").toLowerCase().replace(/\s/g, "");
const stateMap = {
  ca: "Disclaimer: CFL license required to broker loans. Disclosure must be signed by the recipient before the transaction is finalized - funding amount, finance charge, total repayment, prepayment policies, APR.",
  california: "Disclaimer: CFL license required to broker loans. Disclosure must be signed by the recipient before the transaction is finalized - funding amount, finance charge, total repayment, prepayment policies, APR.",
  ct: "Disclaimer: Providers and brokers must register with the state. For transactions ≤ $250,000 - must disclose total funding, cost of borrowing, repayment schedule, and broker compensation. APR is not required.",
  connecticut: "Disclaimer: Providers and brokers must register with the state. For transactions ≤ $250,000 - must disclose total funding, cost of borrowing, repayment schedule, and broker compensation. APR is not required.",
  fl: "Disclaimer: Providers must disclose terms for deals ≤ $500,000 - funding amount, finance charge, total repayment, prepayment policies, APR. Brokers must comply with code of conduct: no false adverstising or upfront fees, address and phone number must be included in all advertising.",
  florida: "Disclaimer: Providers must disclose terms for deals ≤ $500,000 - funding amount, finance charge, total repayment, prepayment policies, APR. Brokers must comply with code of conduct: no false adverstising or upfront fees, address and phone number must be included in all advertising.",
  ga: "Disclaimer: Providers and brokers must disclouse terms for deals ≤ $500,000 - total funding amount, net funds disbursed, total repayment, total dollar cost, and payment schedule. APR is not required.",
  georgia: "Disclaimer: Providers and brokers must disclouse terms for deals ≤ $500,000 - total funding amount, net funds disbursed, total repayment, total dollar cost, and payment schedule. APR is not required.",
  ks: "Disclaimer: Registration is not required. For transactions ≤ $500,000 - terms must be clearly disclosed before closing - total funds provided and disbursed, total repayment, cost of financing, payment frequency and schedule.",
  kansas: "Disclaimer: Registration is not required. For transactions ≤ $500,000 - terms must be clearly disclosed before closing - total funds provided and disbursed, total repayment, cost of financing, payment frequency and schedule.",
  mo: "Disclaimer: Brokers must be registered. For transactions ≤ $500,000 - provider much provide disclosure of terms - total funding amount, finance charge, total repayment, APR.",
  missouri: "Disclaimer: Brokers must be registered. For transactions ≤ $500,000 - provider much provide disclosure of terms - total funding amount, finance charge, total repayment, APR.",
  ny: "Disclaimer: Registration is not required for brokers or providers. For transactions ≤ $2.5 million, provider must provide disclosure including broker commission, total financing amount, amount disbursed, finance charge, APR.",
  newyork: "Disclaimer: Registration is not required for brokers or providers. For transactions ≤ $2.5 million, provider must provide disclosure including broker commission, total financing amount, amount disbursed, finance charge, APR.",
  ut: "Disclaimer: For transactions ≤ $1 million, provider must maintain CFL license, register with state, and disclose broker commission, total amount funded, amount disbursed, total repayment, manner and frequency of payments. APR not required.",
  utah: "Disclaimer: For transactions ≤ $1 million, provider must maintain CFL license, register with state, and disclose broker commission, total amount funded, amount disbursed, total repayment, manner and frequency of payments. APR not required.",
  va: "Disclaimer: Brokers and Providers must register. For transactions ≤ $500,000 - provider must disclose funding amount, payment method, finance charges, total repayment, any additional fees, APR not required. Dispute rules: lawsuits must be in VA, provider pays arbitration costs, must occur locally.",
  virginia: "Disclaimer: Brokers and Providers must register. For transactions ≤ $500,000 - provider must disclose funding amount, payment method, finance charges, total repayment, any additional fees, APR not required. Dispute rules: lawsuits must be in VA, provider pays arbitration costs, must occur locally.",
};

const disclaimer = stateMap[stateInput];
if (disclaimer) {
  res.setHeader("X-State-Disclaimer", disclaimer);
}

res.setHeader("Content-Type", "application/pdf");
res.setHeader(
  "Content-Disposition",
  `attachment; filename="${file.name.replace(".pdf", "")} - protected.pdf"`
);
res.send(Buffer.from(finalPdf));

});

app.listen(port, () => {
  console.log(`✅ Aquamark Wholesale running on port ${port}`);
});
