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

  // 🧠 Decrypt if needed
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

  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  // 🖼️ Fetch logo using exact filename = userEmail
  const logoFilename = `${userEmail}.png`;
  const { data: logoUrlData } = supabase.storage.from("wholesale.logos").getPublicUrl(logoFilename);
  const logoRes = await fetch(logoUrlData.publicUrl);
  if (!logoRes.ok) {
    return res.status(404).send("Logo fetch from CDN failed");
  }

  const logoBytes = await logoRes.arrayBuffer();

  // 🖼️ Embed watermark logo
  const watermarkImage = await pdfDoc.embedPng(logoBytes);

  const today = new Date().toISOString().split("T")[0];
  const payload = encodeURIComponent(`ProtectedByAquamark|${userEmail}|${lender}|${salesperson}|${processor}|${today}`);
  const qrText = `https://aquamark.io/q.html?data=${payload}`;
  const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 0, scale: 5 });
  const qrImageBytes = Buffer.from(qrDataUrl.split(",")[1], "base64");
  const qrImage = await pdfDoc.embedPng(qrImageBytes);

  // 🖊️ Draw on each page
  const pages = pdfDoc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    const logoWidth = width * 0.2;
    const logoHeight = (logoWidth / watermarkImage.width) * watermarkImage.height;

    for (let x = 0; x < width; x += (logoWidth + 150)) {
      for (let y = 0; y < height; y += (logoHeight + 150)) {
        page.drawImage(watermarkImage, {
          x,
          y,
          width: logoWidth,
          height: logoHeight,
          opacity: 0.15,
          rotate: degrees(45),
        });
      }
    }

    page.drawImage(qrImage, {
      x: width - 35,
      y: 15,
      width: 20,
      height: 20,
      opacity: 0.4,
    });
  }

  // 📈 Update usage
  const numPages = pages.length;
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
