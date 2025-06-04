const express = require("express");
const multer = require("multer");
const { PDFDocument, rgb, degrees, StandardFonts } = require("pdf-lib");
const { createCanvas, loadImage } = require("canvas");
const qrcode = require("qrcode");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.post("/watermark", upload.single("pdf"), async (req, res) => {
  const apiKey = req.headers.authorization?.split(" ")[1];
  const userEmail = req.body.user_email;
  const salesperson = req.body.salesperson || "unknown";
  const processor = req.body.processor || "unknown";
  const lender = req.body.lender || "unknown";

  console.log("🔥 /watermark hit");
  console.log("API key received:", apiKey);
  console.log("User email:", userEmail);

  if (apiKey !== process.env.AQUAMARK_API_KEY) {
    return res.status(403).send("Unauthorized");
  }

  const { data: userRecord, error: userErr } = await supabase
    .from(process.env.PARTNER_TABLE)
    .select("*")
    .eq("user_email", userEmail)
    .single();

  if (userErr || !userRecord) {
    return res.status(401).send("Invalid user");
  }

  const file = req.file;
  if (!file) {
    return res.status(400).send("No file uploaded");
  }

  const logoUrl = `https://dvzmnikrvkvgragzhrof.supabase.co/storage/v1/object/public/wholesale.logos/${userEmail}/logo.jpg`;

  let logoImage;
  try {
    logoImage = await loadImage(logoUrl);
  } catch (e) {
    return res.status(404).send("Logo not found for this user");
  }

  const pdfDoc = await PDFDocument.load(file.buffer);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const dateStr = new Date().toISOString().split("T")[0];

  const qrPayload = `https://aquamark.io/q.html?e=${encodeURIComponent(userEmail)}&l=${encodeURIComponent(lender)}&s=${encodeURIComponent(salesperson)}&p=${encodeURIComponent(processor)}&d=${encodeURIComponent(dateStr)}`;
  const qrCanvas = createCanvas(200, 200);
  await qrcode.toCanvas(qrCanvas, qrPayload);
  const qrImage = await pdfDoc.embedPng(qrCanvas.toBuffer());

  const watermarkCanvas = createCanvas(400, 400);
  const ctx = watermarkCanvas.getContext("2d");

  ctx.translate(watermarkCanvas.width / 2, watermarkCanvas.height / 2);
  ctx.rotate((-45 * Math.PI) / 180);
  ctx.translate(-watermarkCanvas.width / 2, -watermarkCanvas.height / 2);
  ctx.globalAlpha = 0.12;
  const scale = 0.25;
  const scaledWidth = logoImage.width * scale;
  const scaledHeight = logoImage.height * scale;

  for (let x = -scaledWidth; x < watermarkCanvas.width + scaledWidth; x += scaledWidth * 2) {
    for (let y = -scaledHeight; y < watermarkCanvas.height + scaledHeight; y += scaledHeight * 2) {
      ctx.drawImage(logoImage, x, y, scaledWidth, scaledHeight);
    }
  }

  const watermarkImage = await pdfDoc.embedPng(watermarkCanvas.toBuffer());

  for (const page of pages) {
    const { width, height } = page.getSize();
    page.drawImage(watermarkImage, {
      x: 0,
      y: 0,
      width,
      height,
    });

    page.drawImage(qrImage, {
      x: width - 35,
      y: 15,
      width: 20,
      height: 20,
      opacity: 0.4,
    });
  }

  const pdfBytes = await pdfDoc.save();

  const monthKey = new Date().toISOString().slice(0, 7);
  const pagesUsed = pages.length;

  await supabase
    .from(process.env.PARTNER_USAGE_TABLE)
    .update({
      pages_used: userRecord.pages_used + pagesUsed,
    })
    .eq("user_email", userEmail);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=watermarked.pdf");
  res.send(pdfBytes);
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`✅ Aquamark Wholesale server running on port ${port}`);
});
