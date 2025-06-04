const express = require("express");
const multer = require("multer");
const { PDFDocument, rgb } = require("pdf-lib");
const { createClient } = require("@supabase/supabase-js");
const QRCode = require("qrcode");
const fs = require("fs");
const sharp = require("sharp");
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

    // Lookup user
    const { data: userRecord, error: usageError } = await supabase
      .from("users_brokersync360")
      .select("*")
      .eq("user_email", userEmail)
      .single();

    if (!userRecord || usageError) {
      return res.status(404).json({ error: "User not found" });
    }

    // Find logo (no timestamp, just userEmail.png|jpg|jpeg)
    const { data: logoList } = await supabase.storage
      .from("wholesale.logos")
      .list("", { limit: 100 });

    const match = logoList.find((f) =>
      f.name.toLowerCase().startsWith(userEmail.toLowerCase())
    );

    if (!match) {
      return res.status(400).json({ error: "Logo not found" });
    }

    const { data: logoFile } = await supabase.storage
      .from("wholesale.logos")
      .download(match.name);

    if (!logoFile) {
      return res.status(400).json({ error: "Failed to fetch logo" });
    }

    const logoBuffer = Buffer.from(await logoFile.arrayBuffer());
    const logoJpg = await sharp(logoBuffer).jpeg().toBuffer();

    // Generate QR once per batch
    const qrData = `Lender: ${lender}\nSalesperson: ${salesperson}\nProcessor: ${processor}\nDate: ${new Date().toLocaleString()}`;
    const qrBase64 = await QRCode.toDataURL(qrData);
    const qrBuffer = Buffer.from(qrBase64.split(",")[1], "base64");

    const outputFiles = [];

    for (const file of req.files) {
      const inputPath = "input.pdf";
      const outputPath = "decrypted.pdf";
      fs.writeFileSync(inputPath, file.buffer);

      try {
        execSync(`qpdf --password="" --decrypt ${inputPath} ${outputPath}`);
      } catch {
        fs.unlinkSync(inputPath);
        return res.status(400).json({ error: "Failed to decrypt PDF" });
      }

      const decrypted = fs.readFileSync(outputPath);
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);

      const pdfDoc = await PDFDocument.load(decrypted, {
        ignoreEncryption: true,
      });

      const logoImage = await pdfDoc.embedJpg(logoJpg);
      const qrImage = await pdfDoc.embedPng(qrBuffer);

      const pages = pdfDoc.getPages();
      for (const page of pages) {
        const { width, height } = page.getSize();

        // Tile watermark
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

        // QR code bottom right
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
  console.log(`Aquamark Wholesale server running on port ${port}`);
});
