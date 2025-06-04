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
const port = process.env.PORT || 3000;

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

  // 🔍 Fetch user from the correct partner table
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
  fs.writeFileSync("input.pdf", file.data);
  exec(`qpdf --decrypt input.pdf decrypted.pdf`, async (err) => {
    const inputPath = err ? "input.pdf" : "decrypted.pdf";
    const fileData = fs.readFileSync(inputPath);
    const pdfDoc = await PDFDocument.load(fileData);
    const logoExts = [".png", ".jpg", ".jpeg"];
    let logoImage;

    for (const ext of logoExts) {
      const { data: imageData } = await supabase
        .storage
        .from("wholesale.logos")
        .download(`${userEmail}${ext}`);
      if (imageData) {
        const imgBytes = await imageData.arrayBuffer();
        try {
          logoImage = ext === ".png" 
            ? await pdfDoc.embedPng(imgBytes) 
            : await pdfDoc.embedJpg(imgBytes);
          break;
        } catch {}
      }
    }

    if (!logoImage) {
      return res.status(404).send("Logo not found for this user.");
    }

    // 📎 Generate QR Code
    const qrData = `Lender: ${lender}\nSalesperson: ${salesperson}\nProcessor: ${processor}\nEmail: ${userEmail}`;
    const qrImageBytes = await QRCode.toBuffer(qrData);
    const qrImage = await pdfDoc.embedPng(qrImageBytes);

    const numPages = pdfDoc.getPageCount();
    for (let i = 0; i < numPages; i++) {
      const page = pdfDoc.getPage(i);
      const { width, height } = page.getSize();

      // Tile watermark
      const cols = 3;
      const rows = 4;
      const scale = 0.2;
      const logoDims = logoImage.scale(scale);

      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const x = (width / cols) * col + 10;
          const y = (height / rows) * row + 10;
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

      // QR bottom right
      page.drawImage(qrImage, {
        x: width - 70,
        y: 20,
        width: 50,
        height: 50,
      });

      // Compliance header (top margin)
      page.drawText("State-specific compliance may apply. Broker assumes all responsibility.", {
        x: 30,
        y: height - 30,
        size: 8,
        color: rgb(0.5, 0.5, 0.5),
      });
    }

    // 🔁 Usage tracking
    const updatedPagesUsed = usage + numPages;

    await supabase
      .from(process.env.PARTNER_TABLE)
      .update({ pages_used: updatedPagesUsed })
      .eq("user_email", userEmail);

    if ((plan === "core" && updatedPagesUsed > 25000) || (plan === "pro" && updatedPagesUsed > 50000)) {
      console.log(`Plan exceeded for ${userEmail} (${plan}) — ${updatedPagesUsed} pages used`);
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=watermarked.pdf");
    res.send(Buffer.from(pdfBytes));

    fs.unlinkSync("input.pdf");
    if (fs.existsSync("decrypted.pdf")) fs.unlinkSync("decrypted.pdf");
  });
});

app.listen(port, () => {
  console.log(`Aquamark Wholesale server running on port ${port}`);
});
