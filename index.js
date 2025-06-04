const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, degrees } = require("pdf-lib");
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

  const plan = (userRecord.plan || "").toLowerCase();
  const usage = userRecord.pages_used || 0;

  // 🧠 Decrypt if needed (clean retail-style)
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
        resolve(); // fallback to original if error
      });
    });
    fs.unlinkSync("input.pdf");
    if (fs.existsSync("decrypted.pdf")) fs.unlinkSync("decrypted.pdf");
  }

  // 📄 Load decrypted (or original) PDF
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pageSize = pdfDoc.getPage(0).getSize();

  // 🖼️ Optimized logo fetch from flat root
  const { data: logoList } = await supabase.storage.from("wholesale.logos").list("", { limit: 1000 });
  if (!logoList || logoList.length === 0) {
    return res.status(404).send("No logos found");
  }

  const matchingLogos = logoList.filter((file) => file.name.startsWith(userEmail));
  if (matchingLogos.length === 0) {
    return res.status(404).send("No logo found for this user");
  }

  const latestLogo = matchingLogos.sort((a, b) =>
    (b.name.match(/-(\d+)/)?.[1] ?? 0) - (a.name.match(/-(\d+)/)?.[1] ?? 0)
  )[0];

  const { data: logoFile } = await supabase.storage.from("wholesale.logos").download(latestLogo.name);
  if (!logoFile) {
    return res.status(404).send("Logo download failed");
  }
  const logoBytes = await logoFile.arrayBuffer();

  // 🖼️ Create watermark overlay
  const watermarkDoc = await PDFDocument.create();
  const watermarkImage = await watermarkDoc.embedPng(logoBytes);
  const watermarkPage = watermarkDoc.addPage([pageSize.width, pageSize.height]);

  const logoWidth = pageSize.width * 0.2;
  const logoHeight = (logoWidth / watermarkImage.width) * watermarkImage.height;

  for (let x = 0; x < pageSize.width; x += (logoWidth + 150)) {
    for (let y = 0; y < pageSize.height; y += (logoHeight + 150)) {
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

  // 🔐 QR Code
  const today = new Date().toISOString().split("T")[0];
  const payload = encodeURIComponent(`ProtectedByAquamark|${userEmail}|${lender}|${salesperson}|${processor}|${today}`);
  const qrText = `https://aquamark.io/q.html?data=${payload}`;
  const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 0, scale: 5 });
  const qrImageBytes = Buffer.from(qrDataUrl.split(",")[1], "base64");
  const qrImage = await watermarkDoc.embedPng(qrImageBytes);

  watermarkPage.drawImage(qrImage, {
    x: pageSize.width - 35,
    y: 15,
    width: 20,
    height: 20,
    opacity: 0.4,
  });

  const watermarkPdfBytes = await watermarkDoc.save();
  const watermarkEmbed = await PDFDocument.load(watermarkPdfBytes);
  const [overlayPage] = await pdfDoc.embedPages([watermarkEmbed.getPages()[0]]);

  pdfDoc.getPages().forEach((page) => {
    page.drawPage(overlayPage, { x: 0, y: 0, width: pageSize.width, height: pageSize.height });
  });

  // 📈 Usage tracking
  const numPages = pdfDoc.getPageCount();
  const updatedPagesUsed = usage + numPages;

  await supabase
    .from(process.env.PARTNER_TABLE)
    .update({ pages_used: updatedPagesUsed })
    .eq("user_email", userEmail);

  const finalPdf = await pdfDoc.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=watermarked.pdf");
  res.send(Buffer.from(finalPdf));
});

app.listen(port, () => {
  console.log(`✅ Aquamark Wholesale running on port ${port}`);
});
