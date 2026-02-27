/**
 * ============================================
 * CHAT APPLICATION BACKEND SERVER
 * ============================================
 * Features:
 * - Express REST API
 * - Socket.io for real-time messaging
 * - WebRTC signaling for audio/video calls
 * - MySQL database integration
 * - JWT authentication
 * - File upload support
 * ============================================
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Load environment variables
dotenv.config();

// Import database connection
const db = require('./config/database');

// Import Socket.io handler
const socketHandler = require('./socket/socketHandler');

// Import routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const conversationRoutes = require('./routes/conversationRoutes');
const messageRoutes = require('./routes/messageRoutes');
const callRoutes = require('./routes/callRoutes');
const uploadRoutes = require('./routes/uploadRoutes');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.io
const io = require('socket.io')(server, {
  cors: {
    origin: process.env.SOCKET_CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  credentials: true
}));

// Compression middleware
app.use(compression());

// Body parsing middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Request logging middleware (development only)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
}

// ============================================
// API ROUTES
// ============================================

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/upload', uploadRoutes);

// ============================================
// SOCKET.IO HANDLER
// ============================================

// Pass io instance to socket handler
socketHandler(io);

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'API endpoint not found'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ============================================
// SERVER STARTUP
// ============================================

const PORT = process.env.PORT || 5000;

// Test database connection before starting server
db.testConnection()
  .then(() => {
    console.log('✅ Database connected successfully');
    
    server.listen(PORT, () => {
      console.log('========================================');
      console.log('🚀 Chat App Server is running!');
      console.log(`📡 Port: ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log('========================================');
      console.log('API Endpoints:');
      console.log(`  - Health: http://localhost:${PORT}/api/health`);
      console.log(`  - Auth: http://localhost:${PORT}/api/auth`);
      console.log(`  - Users: http://localhost:${PORT}/api/users`);
      console.log(`  - Conversations: http://localhost:${PORT}/api/conversations`);
      console.log(`  - Messages: http://localhost:${PORT}/api/messages`);
      console.log(`  - Calls: http://localhost:${PORT}/api/calls`);
      console.log('========================================');
    });
  })
  .catch((err) => {
    console.error('❌ Failed to connect to database:', err.message);
    console.error('Please check your database configuration in .env file');
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    db.closeConnection();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    db.closeConnection();
    process.exit(0);
  });
});

module.exports = { app, server, io };