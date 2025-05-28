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
const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(fileUpload());

app.post("/watermark", async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send("Missing or invalid authorization token.");
  }

  const token = authHeader.split(" ")[1];
  if (token !== process.env.AQUAMARK_API_KEY) {
    return res.status(401).send("Invalid API key.");
  }

  if (!req.files || !req.files.file || !req.body.user_email) {
    return res.status(400).send("Missing file or user_email");
  }

  const userEmail = req.body.user_email;
  const lender = req.body.lender || "N/A";
  const file = Array.isArray(req.files.file) ? req.files.file[0] : req.files.file;

  try {
    // 🧩 Decrypt if needed
    let pdfBytes = file.data;
    try {
      await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
    } catch {
      const tempId = Date.now();
      const inPath = path.join(__dirname, `temp-${tempId}.pdf`);
      const outPath = path.join(__dirname, `temp-${tempId}-dec.pdf`);
      fs.writeFileSync(inPath, file.data);
      await new Promise((resolve, reject) => {
        exec(`qpdf --decrypt "${inPath}" "${outPath}"`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      pdfBytes = fs.readFileSync(outPath);
      fs.unlinkSync(inPath);
      fs.unlinkSync(outPath);
    }

    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

    const numPages = pdfDoc.getPageCount();

    // 👤 Get partner user info
    const { data: userRecord, error: userErr } = await supabase
      .from("partner_users")
      .select("id, partner_id, company")
      .eq("email", userEmail)
      .single();

    if (userErr || !userRecord) {
      throw new Error("Partner user not found");
    }

    // 🖼️ Get logo from Supabase
    const { data: logoList } = await supabase.storage.from("logos").list(userEmail);
    if (!logoList || logoList.length === 0) throw new Error("No logo found");

    const latestLogo = logoList.sort((a, b) =>
      parseInt(b.name.split("-")[1]) - parseInt(a.name.split("-")[1])
    )[0];
    const logoPath = `${userEmail}/${latestLogo.name}`;
    const { data: logoUrlData } = supabase.storage.from("logos").getPublicUrl(logoPath);
    const logoRes = await fetch(logoUrlData.publicUrl);
    const logoBytes = await logoRes.arrayBuffer();

    // 🔁 Create watermark overlay
    const watermarkDoc = await PDFDocument.create();
    const watermarkImage = await watermarkDoc.embedPng(logoBytes);
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

    // 🔐 QR Code
    const today = new Date().toISOString().split("T")[0];
    const payload = encodeURIComponent(`ProtectedByAquamark|${userEmail}|${lender}|${today}`);
    const qrText = `https://aquamark.io/q.html?data=${payload}`;
    const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 0, scale: 5 });
    const qrImageBytes = Buffer.from(qrDataUrl.split(",")[1], "base64");
    const qrImage = await watermarkDoc.embedPng(qrImageBytes);

    const qrSize = 20;
    watermarkPage.drawImage(qrImage, {
      x: width - qrSize - 15,
      y: 15,
      width: qrSize,
      height: qrSize,
      opacity: 0.4,
    });

    // ✅ Overlay on every page
    const watermarkPdfBytes = await watermarkDoc.save();
    const watermarkEmbed = await PDFDocument.load(watermarkPdfBytes);
    const [embeddedPage] = await pdfDoc.embedPages([watermarkEmbed.getPages()[0]]);

    pdfDoc.getPages().forEach((page) => {
      page.drawPage(embeddedPage, { x: 0, y: 0, width, height });
    });

    // 📈 Track usage by user/month
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    await supabase
      .from("partner_usage_history")
      .upsert({
        user_id: userRecord.id,
        partner_id: userRecord.partner_id,
        company_name: userRecord.company,
        month,
        pages_used: numPages,
      }, { onConflict: ['user_id', 'month'] });

    // 📤 Return watermarked file
    const finalPdf = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.name.replace(".pdf", "")}-protected.pdf"`
    );
    res.send(Buffer.from(finalPdf));
  } catch (err) {
    console.error("❌ Watermark error:", err);
    res.status(500).send("Failed to process watermark: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Wholesale API running on port ${PORT}`);
});
