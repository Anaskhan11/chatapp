/**
 * ============================================
// Upload Routes
// ============================================
// File upload handling for images, voice messages, and files
// ============================================
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "..", "uploads");
const imagesDir = path.join(uploadsDir, "images");
const voiceDir = path.join(uploadsDir, "voice");
const filesDir = path.join(uploadsDir, "files");

[uploadsDir, imagesDir, voiceDir, filesDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const fileType = req.params.type || "files";
    let dest = filesDir;

    if (fileType === "images") {
      dest = imagesDir;
    } else if (fileType === "voice") {
      dest = voiceDir;
    }

    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

// File filter
const fileFilter = (req, file, cb) => {
  const fileType = req.params.type || "files";

  if (fileType === "images") {
    // Allow images only
    const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error("Only image files (JPEG, PNG, GIF, WebP) are allowed"),
        false,
      );
    }
  } else if (fileType === "voice") {
    // Allow audio only
    const allowedMimes = [
      "audio/mpeg",
      "audio/wav",
      "audio/ogg",
      "audio/aac",
      "audio/webm",
      "audio/m4a",
      "audio/mp4",
      "audio/x-m4a",
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Only audio files (MP3, WAV, OGG, AAC, WebM, M4A) are allowed. Got: ${file.mimetype}`,
        ),
        false,
      );
    }
  } else {
    // Allow all files for general uploads
    cb(null, true);
  }
};

// Configure multer
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024, // 10MB default
  },
});

// ============================================
// POST /api/upload/:type
// Upload a file (images, voice, or files)
// ============================================
router.post("/:type", verifyToken, upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded",
      });
    }

    const fileType = req.params.type;
    const validTypes = ["images", "voice", "files"];

    if (!validTypes.includes(fileType)) {
      // Delete uploaded file if type is invalid
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        message: "Invalid upload type. Must be images, voice, or files",
      });
    }

    // Generate file URL
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${fileType}/${req.file.filename}`;

    res.json({
      success: true,
      message: "File uploaded successfully",
      data: {
        file: {
          url: fileUrl,
          filename: req.file.filename,
          originalName: req.file.originalname,
          size: req.file.size,
          mimetype: req.file.mimetype,
        },
      },
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error during upload",
    });
  }
});

// ============================================
// POST /api/upload/base64/:type
// Upload a base64 encoded file
// ============================================
router.post("/base64/:type", verifyToken, async (req, res) => {
  try {
    const { base64Data, filename } = req.body;
    const fileType = req.params.type;

    if (!base64Data) {
      return res.status(400).json({
        success: false,
        message: "No base64 data provided",
      });
    }

    const validTypes = ["images", "voice", "files"];

    if (!validTypes.includes(fileType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid upload type. Must be images, voice, or files",
      });
    }

    // Determine destination directory
    let destDir = filesDir;
    if (fileType === "images") destDir = imagesDir;
    if (fileType === "voice") destDir = voiceDir;

    // Generate unique filename
    const ext = path.extname(filename || ".bin") || ".bin";
    const uniqueName = `${uuidv4()}${ext}`;
    const filePath = path.join(destDir, uniqueName);

    // Remove data URL prefix if present
    const base64String = base64Data.replace(/^data:[^;]+;base64,/, "");

    // Write file
    fs.writeFileSync(filePath, Buffer.from(base64String, "base64"));

    // Generate file URL
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${fileType}/${uniqueName}`;

    // Get file stats
    const stats = fs.statSync(filePath);

    res.json({
      success: true,
      message: "File uploaded successfully",
      data: {
        file: {
          url: fileUrl,
          filename: uniqueName,
          originalName: filename || uniqueName,
          size: stats.size,
          mimetype: `application/${ext.slice(1)}`,
        },
      },
    });
  } catch (error) {
    console.error("Base64 upload error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error during upload",
    });
  }
});

// ============================================
// DELETE /api/upload/:filename
// Delete an uploaded file
// ============================================
router.delete("/:type/:filename", verifyToken, (req, res) => {
  try {
    const { type, filename } = req.params;

    const validTypes = ["images", "voice", "files"];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid file type",
      });
    }

    let fileDir;
    if (type === "images") fileDir = imagesDir;
    else if (type === "voice") fileDir = voiceDir;
    else fileDir = filesDir;

    const filePath = path.join(fileDir, filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: "File not found",
      });
    }

    // Delete file
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      message: "File deleted successfully",
    });
  } catch (error) {
    console.error("Delete file error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Error handling middleware for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "File size too large",
      });
    }
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  if (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  next();
});

module.exports = router;
