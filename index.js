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
    files: (userRecord.files || 0) + 1
    })
    .eq("user_email", userEmail);

  const finalPdf = await pdfDoc.save();

    // 📜 Optional: Add state disclaimer if applicable
const stateInput = (req.body.state || "").toLowerCase().replace(/\s/g, "");
const stateMap = {
  ca: "License and Disclosure required",
  california: "License and Disclosure required",
  ct: "Registration and Disclosure required",
  connecticut: "Registration and Disclosure required",
  fl: "Comply with Broker Code of Conduct",
  florida: "Comply with Broker Code of Conduct",
  ga: "Disclosure required",
  georgia: "Disclosure required",
  ks: "Disclosure required",
  kansas: "Disclosure required",
  mo: "Registration required",
  missouri: "Registration required",
  ny: "Provider will supply broker commission disclosure",
  newyork: "Provider will supply broker commission disclosure",
  ut: "Provider will supply broker commission disclosure",
  utah: "Provider will supply broker commission disclosure",
  va: "Registration required",
  virginia: "Registration required",
};

let disclaimer = stateMap[stateInput] || "No current requirements";
res.setHeader("X-State-Disclaimer", disclaimer);


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
