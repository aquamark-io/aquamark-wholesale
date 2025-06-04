const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, degrees } = require("pdf-lib");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
const QRCode = require("qrcode"); // ✅ Added for QR code generation

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

const { user_id, user_email } = req.body;
if (!user_id || !user_email) {
  return res.status(400).send("Missing user_id or user_email.");
}


// Validate user
const { data: user, error: userErr } = await supabase
  .from(process.env.PARTNER_TABLE)
  .select("id, email")
  .eq("id", user_id)
  .eq("email", user_email)
  .single();
if (userErr || !user) {
  return res.status(403).send("Invalid user_id or user_email.");
}
  if (!req.files || !req.files.file) {
  return res.status(400).send("Missing file");
}
  const userEmail = req.body.user_email;
  const lender = req.body.lender || "N/A";
  const salesperson = req.body.salesperson || "N/A";
  const processor = req.body.processor || "N/A";

const file = Array.isArray(req.files.file) ? req.files.file[0] : req.files.file;

  try {
    // 🗄️ Decrypt if needed
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

    // 📊 Usage
   const numPages = pdfDoc.getPageCount();

// 🔁 Fetch user's current usage and plan
const { data: userUsage, error: usageErr } = await supabase
  .from(process.env.PARTNER_TABLE)
  .select("pages_used, plan")
  .eq("id", user_id)
  .single();

if (usageErr || !userUsage) throw new Error("Usage record not found");

const updatedPagesUsed = userUsage.pages_used + numPages;
const plan = (userUsage.plan || "").toLowerCase();
let limit = Infinity;

if (plan === "core") limit = 25000;
else if (plan === "pro") limit = 50000;

// ❗ Log only, do not block access
if (updatedPagesUsed > limit) {
  console.warn(`⚠️ User ${user_id} exceeded usage limit for plan "${plan}"`);
  // Optional: email, webhook, or flag if you want
}

// 📈 Update pages_used in Supabase
await supabase
  .from(process.env.PARTNER_TABLE)
  .update({ pages_used: updatedPagesUsed })
  .eq("id", user_id);


// 🖼️ Get logo from wholesale bucket (flat: user_email.png or .jpg)
const possibleExtensions = [".png", ".jpg", ".jpeg"];
let logoBytes = null;

for (const ext of possibleExtensions) {
  const logoPath = `${userEmail}${ext}`;
  const { data: logoUrlData } = supabase.storage.from("wholesale.logos").getPublicUrl(logoPath);
  const logoRes = await fetch(logoUrlData.publicUrl);
  if (logoRes.ok) {
    logoBytes = await logoRes.arrayBuffer();
    break;
  }
}

if (!logoBytes) {
  throw new Error("No logo found in wholesale bucket for provided email.");
}


// 🔁 Create combined watermark page (logo + QR)
const watermarkDoc = await PDFDocument.create();
const watermarkImage = await watermarkDoc.embedPng(logoBytes);
const { width, height } = pdfDoc.getPages()[0].getSize();
const watermarkPage = watermarkDoc.addPage([width, height]);

// 🔢 Logo tiling
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

// 🔐 QR Code generation
const today = new Date().toISOString().split("T")[0];
const payload = encodeURIComponent(`ProtectedByAquamark|${userEmail}|${lender}|${salesperson}|${processor}|${today}`);
const qrText = `https://aquamark.io/q.html?data=${payload}`;
const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 0, scale: 5 });
const qrImageBytes = Buffer.from(qrDataUrl.split(",")[1], "base64");
const qrImage = await watermarkDoc.embedPng(qrImageBytes);

// 🧷 Add QR to same watermark page (bottom-right)
const qrSize = 20;
watermarkPage.drawImage(qrImage, {
  x: width - qrSize - 15,
  y: 15,
  width: qrSize,
  height: qrSize,
  opacity: 0.4,
});

// ✅ Save unified watermark page
const watermarkPdfBytes = await watermarkDoc.save();
const watermarkEmbed = await PDFDocument.load(watermarkPdfBytes);
const [embeddedPage] = await pdfDoc.embedPages([watermarkEmbed.getPages()[0]]);

    pdfDoc.getPages().forEach((page) => {
  page.drawPage(embeddedPage, { x: 0, y: 0, width, height });
});

    const finalPdf = await pdfDoc.save();

    // 📜 Optional: Add state disclaimer if applicable
const stateInput = (req.body.state || "").toLowerCase().replace(/\s/g, "");
const stateMap = {
  ca: "Disclaimer: Disclosure and CFL license required.",
  california: "Disclaimer: Disclosure and CFL license required.",
  ct: "Disclaimer: Registration and compensation disclosure required for deals under $250K.",
  connecticut: "Disclaimer: Registration and compensation disclosure required for deals under $250K.",
  fl: "Disclaimer: Advertising must include address and phone number. Compensation must be disclosed.",
  florida: "Disclaimer: Advertising must include address and phone number. Compensation must be disclosed.",
  ga: "Disclaimer: Disclosure required.",
  georgia: "Disclaimer: Disclosure required.",
  mo: "Disclaimer: Registration and disclosure required.",
  missouri: "Disclaimer: Registration and disclosure required.",
  ny: "Disclaimer: Disclosure required.",
  newyork: "Disclaimer: Disclosure required.",
  ut: "Disclaimer: License, registration and disclosure required.",
  utah: "Disclaimer: License, registration and disclosure required.",
  va: "Disclaimer: Registration and disclosure required.",
  virginia: "Disclaimer: Registration and disclosure required.",
};

const disclaimer = stateMap[stateInput];
if (disclaimer) {
  res.setHeader("X-State-Disclaimer", disclaimer);
}
    
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
  console.log(`🚀 Server running on port ${PORT}`);
});
