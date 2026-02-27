/**
 * ============================================
 * AUTHENTICATION ROUTES
 * ============================================
 * Login, Register, and Token management
 * ============================================
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// JWT Token generator
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// ============================================
// POST /api/auth/register
// Register a new user
// ============================================
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, fullName, phone } = req.body;

    // Validation
    if (!username || !email || !password || !fullName) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields: username, email, password, fullName'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address'
      });
    }

    // Validate password length
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long'
      });
    }

    // Validate username (alphanumeric and underscore only)
    const usernameRegex = /^[a-zA-Z0-9_]+$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username can only contain letters, numbers, and underscores'
      });
    }

    // Check if username already exists
    const existingUsername = await db.query(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existingUsername.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Username already taken'
      });
    }

    // Check if email already exists
    const existingEmail = await db.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existingEmail.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Email already registered'
      });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Generate avatar URL
    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=random&size=150`;

    // Insert new user
    const result = await db.query(
      `INSERT INTO users (username, email, password, full_name, phone, avatar_url) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [username, email, hashedPassword, fullName, phone || null, avatarUrl]
    );

    const userId = result.insertId;

    // Create default user settings
    await db.query(
      'INSERT INTO user_settings (user_id) VALUES (?)',
      [userId]
    );

    // Generate JWT token
    const token = generateToken(userId);

    // Return success response
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        user: {
          id: userId,
          username,
          email,
          fullName,
          phone,
          avatarUrl
        },
        token
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during registration'
    });
  }
});

// ============================================
// POST /api/auth/login
// Login user
// ============================================
router.post('/login', async (req, res) => {
  try {
    const { usernameOrEmail, password } = req.body;

    // Validation
    if (!usernameOrEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide username/email and password'
      });
    }

    // Find user by username or email
    const users = await db.query(
      `SELECT id, username, email, password, full_name, avatar_url, phone, 
              status, is_online, last_seen 
       FROM users 
       WHERE username = ? OR email = ?`,
      [usernameOrEmail, usernameOrEmail]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = users[0];

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Generate JWT token
    const token = generateToken(user.id);

    // Update last seen
    await db.query(
      'UPDATE users SET last_seen = NOW(), is_online = TRUE WHERE id = ?',
      [user.id]
    );

    // Return success response
    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          fullName: user.full_name,
          phone: user.phone,
          avatarUrl: user.avatar_url,
          status: user.status,
          isOnline: true,
          lastSeen: new Date().toISOString()
        },
        token
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during login'
    });
  }
});

// ============================================
// POST /api/auth/logout
// Logout user
// ============================================
router.post('/logout', verifyToken, async (req, res) => {
  try {
    // Update user online status
    await db.query(
      'UPDATE users SET is_online = FALSE, last_seen = NOW(), socket_id = NULL WHERE id = ?',
      [req.userId]
    );

    res.json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during logout'
    });
  }
});

// ============================================
// GET /api/auth/me
// Get current user info
// ============================================
router.get('/me', verifyToken, async (req, res) => {
  try {
    const users = await db.query(
      `SELECT id, username, email, full_name, avatar_url, phone, 
              status, is_online, last_seen 
       FROM users 
       WHERE id = ?`,
      [req.userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];

    res.json({
      success: true,
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
          lastSeen: user.last_seen
        }
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================
// POST /api/auth/refresh
// Refresh JWT token
// ============================================
router.post('/refresh', verifyToken, async (req, res) => {
  try {
    // Generate new token
    const token = generateToken(req.userId);

    res.json({
      success: true,
      data: { token }
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// ============================================
// PUT /api/auth/change-password
// Change user password
// ============================================
router.put('/change-password', verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide current password and new password'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long'
      });
    }

    // Get current password hash
    const users = await db.query(
      'SELECT password FROM users WHERE id = ?',
      [req.userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, users[0].password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await db.query(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, req.userId]
    );

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;