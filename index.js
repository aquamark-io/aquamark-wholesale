const express = require("express");
const multer = require("multer");
const { PDFDocument, rgb } = require("pdf-lib");
const { createClient } = require("@supabase/supabase-js");
const QRCode = require("qrcode");
const fs = require("fs");
const { execSync } = require("child_process");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const port = 10000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(express.json());

app.post("/watermark", upload.array("pdfs"), async (req, res) => {
  try {
    const { apiKey, userEmail, salesperson, processor, lender } = req.body;

    if (apiKey !== process.env.PARTNER_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { data: userRecord, error: usageError } = await supabase
      .from("users_brokersync360")
      .select("*")
      .eq("user_email", userEmail)
      .single();

    if (!userRecord || usageError) {
      return res.status(404).json({ error: "User not found" });
    }

    // ⬇️ LOGO FETCH — Wholesale bucket, filename = email
    const exts = [".png", ".jpg", ".jpeg"];
    let logoBytes = null;
    for (const ext of exts) {
      const { data: blob } = await supabase.storage
        .from("wholesale.logos")
        .download(`${userEmail}${ext}`);
      if (blob) {
        logoBytes = Buffer.from(await blob.arrayBuffer());
        break;
      }
    }

    if (!logoBytes) {
      return res.status(400).json({ error: "Logo not found for user" });
    }

    // ⬇️ QR CODE (generated once)
    const qrText = `Lender: ${lender}\nSalesperson: ${salesperson}\nProcessor: ${processor}\nDate: ${new Date().toLocaleString()}`;
    const qrDataUrl = await QRCode.toDataURL(qrText);
    const qrBytes = Buffer.from(qrDataUrl.split(",")[1], "base64");

    const outputFiles = [];

    for (const file of req.files) {
      // 🧨 Decrypt (if needed)
      fs.writeFileSync("input.pdf", file.buffer);
      try {
        execSync(`qpdf --password="" --decrypt input.pdf decrypted.pdf`);
      } catch {
        fs.unlinkSync("input.pdf");
        return res.status(400).json({ error: "Failed to decrypt PDF" });
      }

      const pdfBytes = fs.readFileSync("decrypted.pdf");
      fs.unlinkSync("input.pdf");
      fs.unlinkSync("decrypted.pdf");

      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const logoImage = await pdfDoc.embedPng(logoBytes);
      const qrImage = await pdfDoc.embedPng(qrBytes);

      const pages = pdfDoc.getPages();

      for (const page of pages) {
        const { width, height } = page.getSize();

        // 💠 Watermark tiling (same as retail)
        const spacing = 250;
        const logoDims = logoImage.scale(0.2);
        for (let y = 0; y < height + spacing; y += spacing) {
          for (let x = -width / 2; x < width + spacing; x += spacing) {
            page.drawImage(logoImage, {
              x,
              y,
              width: logoDims.width,
              height: logoDims.height,
              rotate: { type: "degrees", angle: 45 },
              opacity: 0.2,
            });
          }
        }

        // 📎 QR Code (bottom right)
        const qrDims = qrImage.scale(0.5);
        page.drawImage(qrImage, {
          x: width - qrDims.width - 20,
          y: 20,
          width: qrDims.width,
          height: qrDims.height,
        });
      }

      const finalPdf = await pdfDoc.save();
      outputFiles.push({
        filename: file.originalname.replace(".pdf", " - protected.pdf"),
        content: finalPdf.toString("base64"),
      });
    }

    res.json({ files: outputFiles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(port, () => {
  console.log(`✅ Aquamark Wholesale server running on port ${port}`);
});
