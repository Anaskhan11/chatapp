/**
 * ============================================
 * USER ROUTES
 * ============================================
 * User profile, search, and management
 * ============================================
 */

const express = require("express");
const db = require("../config/database");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

// ============================================
// GET /api/users/search
// Search users by username or full name
// ============================================
router.get("/search", verifyToken, async (req, res) => {
  try {
    const { query, limit = 20, offset = 0 } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "Search query must be at least 2 characters",
      });
    }

    const searchTerm = `%${query.trim()}%`;
    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);

    // Search users excluding current user
    const users = await db.query(
      `SELECT id, username, full_name, avatar_url, status, is_online, last_seen 
       FROM users 
       WHERE (username LIKE ? OR full_name LIKE ? OR email LIKE ?)
       AND id != ?
       LIMIT ${limitNum} OFFSET ${offsetNum}`,
      [searchTerm, searchTerm, searchTerm, req.userId],
    );

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*) as total 
       FROM users 
       WHERE (username LIKE ? OR full_name LIKE ? OR email LIKE ?)
       AND id != ?`,
      [searchTerm, searchTerm, searchTerm, req.userId],
    );

    res.json({
      success: true,
      data: {
        users: users.map((user) => ({
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          avatarUrl: user.avatar_url,
          status: user.status,
          isOnline: user.is_online,
          lastSeen: user.last_seen,
        })),
        pagination: {
          total: countResult[0].total,
          limit: limitNum,
          offset: offsetNum,
          hasMore: offsetNum + users.length < countResult[0].total,
        },
      },
    });
  } catch (error) {
    console.error("Search users error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// GET /api/users/:id
// Get user by ID
// ============================================
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    const users = await db.query(
      `SELECT id, username, full_name, avatar_url, status, is_online, last_seen 
       FROM users 
       WHERE id = ?`,
      [userId],
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const user = users[0];

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          avatarUrl: user.avatar_url,
          status: user.status,
          isOnline: user.is_online,
          lastSeen: user.last_seen,
        },
      },
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// PUT /api/users/profile
// Update current user profile
// ============================================
router.put("/profile", verifyToken, async (req, res) => {
  try {
    const { fullName, status, phone, avatarUrl } = req.body;

    // Build update query dynamically
    const updates = [];
    const values = [];

    if (fullName !== undefined) {
      updates.push("full_name = ?");
      values.push(fullName);
    }

    if (status !== undefined) {
      updates.push("status = ?");
      values.push(status);
    }

    if (phone !== undefined) {
      updates.push("phone = ?");
      values.push(phone);
    }

    if (avatarUrl !== undefined) {
      updates.push("avatar_url = ?");
      values.push(avatarUrl);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    values.push(req.userId);

    await db.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
      values,
    );

    // Get updated user
    const users = await db.query(
      `SELECT id, username, email, full_name, avatar_url, phone, 
              status, is_online, last_seen 
       FROM users 
       WHERE id = ?`,
      [req.userId],
    );

    const user = users[0];

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          fullName: user.full_name,
          phone: user.phone,
          avatarUrl: user.avatar_url,
          status: user.status,
          isOnline: user.is_online,
          lastSeen: user.last_seen,
        },
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// GET /api/users
// Get all users (with pagination)
// ============================================
router.get("/", verifyToken, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);

    const users = await db.query(
      `SELECT id, username, full_name, avatar_url, status, is_online, last_seen 
       FROM users 
       WHERE id != ?
       ORDER BY full_name ASC
       LIMIT ${limitNum} OFFSET ${offsetNum}`,
      [req.userId],
    );

    const countResult = await db.query(
      "SELECT COUNT(*) as total FROM users WHERE id != ?",
      [req.userId],
    );

    res.json({
      success: true,
      data: {
        users: users.map((user) => ({
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          avatarUrl: user.avatar_url,
          status: user.status,
          isOnline: user.is_online,
          lastSeen: user.last_seen,
        })),
        pagination: {
          total: countResult[0].total,
          limit: limitNum,
          offset: offsetNum,
          hasMore: offsetNum + users.length < countResult[0].total,
        },
      },
    });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// GET /api/users/online/status
// Get online users count and list
// ============================================
router.get("/online/status", verifyToken, async (req, res) => {
  try {
    const users = await db.query(
      `SELECT id, username, full_name, avatar_url, last_seen 
       FROM users 
       WHERE is_online = TRUE AND id != ?
       ORDER BY full_name ASC`,
      [req.userId],
    );

    const countResult = await db.query(
      "SELECT COUNT(*) as total FROM users WHERE is_online = TRUE",
    );

    res.json({
      success: true,
      data: {
        onlineCount: countResult[0].total,
        users: users.map((user) => ({
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          avatarUrl: user.avatar_url,
          lastSeen: user.last_seen,
        })),
      },
    });
  } catch (error) {
    console.error("Get online users error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ============================================
// POST /api/users/push-token
// Save Expo Push Token for the user
// ============================================
router.post("/push-token", verifyToken, async (req, res) => {
  try {
    const { pushToken } = req.body;

    if (!pushToken) {
      return res.status(400).json({
        success: false,
        message: "Push token is required",
      });
    }

    await db.query("UPDATE users SET push_token = ? WHERE id = ?", [
      pushToken,
      req.userId,
    ]);

    res.json({
      success: true,
      message: "Push token saved successfully",
    });
  } catch (error) {
    console.error("Save push token error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

module.exports = router;
