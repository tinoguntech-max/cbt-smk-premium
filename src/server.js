require('dotenv').config();

// Set timezone to Asia/Jakarta (WIB)
process.env.TZ = 'Asia/Jakarta';

const path = require('path');
const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');
const flash = require('connect-flash');
const morgan = require('morgan');
const helmet = require('helmet');
const methodOverride = require('method-override');
const expressLayouts = require('express-ejs-layouts');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const teacherRoutes = require('./routes/teacher');
const studentRoutes = require('./routes/student');
const principalRoutes = require('./routes/principal');
const notificationRoutes = require('./routes/notifications');
const liveClassesRoutes = require('./routes/live-classes');
const quizApiRoutes = require('./routes/quiz-api');
const questionBankRoutes = require('./routes/question_bank');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(expressLayouts);
app.set('layout', 'layout');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ===== REDIS CLIENT CONFIGURATION =====
const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    // Reconnection strategy
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('❌ Redis: Too many reconnection attempts, giving up');
        return new Error('Too many retries');
      }
      // Exponential backoff: 100ms, 200ms, 400ms, 800ms, ...
      const delay = Math.min(retries * 100, 3000);
      console.log(`🔄 Redis: Reconnecting in ${delay}ms (attempt ${retries})`);
      return delay;
    },
    // Connection timeout
    connectTimeout: 10000
  },
  password: process.env.REDIS_PASSWORD || undefined,
  // Disable offline queue to prevent memory issues
  disableOfflineQueue: false
});

// Redis Event Listeners
redisClient.on('error', (err) => {
  console.error('❌ Redis Client Error:', err.message);
  // Don't crash the app on Redis errors
});

redisClient.on('connect', () => {
  console.log('✅ Redis connecting to: ' + process.env.REDIS_HOST);
});

redisClient.on('ready', () => {
  console.log('✅ Redis ready to use');
});

redisClient.on('reconnecting', () => {
  console.log('🔄 Redis reconnecting...');
});

redisClient.on('end', () => {
  console.log('⚠️  Redis connection closed');
});

// Connect to Redis with retry
(async () => {
  try {
    await redisClient.connect();
    console.log('✅ Redis connected successfully');
  } catch (err) {
    console.error('❌ Redis connection failed:', err.message);
    console.log('⚠️  Application will continue without Redis session store');
    console.log('⚠️  Sessions will be stored in memory (not recommended for production)');
  }
})();

// ===== SESSION CONFIGURATION =====
app.use(
  session({
    store: new RedisStore({ 
      client: redisClient,
      prefix: 'lms:sess:',
      ttl: 60 * 60 * 24 * 7 // 7 hari dalam detik
    }),
    secret: process.env.SESSION_SECRET || 'change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 hari
      secure: false // Set false untuk development tanpa HTTPS
    }
  })
);
console.log('✅ Session configured with Redis store');

app.use(flash());

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = {
    error: req.flash('error'),
    success: req.flash('success'),
    info: req.flash('info')
  };
  next();
});

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.redirect('/dashboard');
});

app.use(authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/profile', require('./routes/profile'));
app.use('/admin', adminRoutes);
app.use('/teacher', teacherRoutes);
app.use('/teacher/question-bank', questionBankRoutes);
app.use('/api/question-bank', questionBankRoutes);
app.use('/notifications', require('./routes/notifications'));
app.use('/api/subjects', async (req, res) => {
  try {
    const pool = require('./db/pool');
    const [subjects] = await pool.query('SELECT id, name FROM subjects ORDER BY name ASC;');
    res.json(subjects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.use('/student', studentRoutes);
app.use('/principal', principalRoutes);
app.use(notificationRoutes);
app.use(liveClassesRoutes);
app.use(quizApiRoutes);

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Halaman tidak ditemukan',
    message: 'URL yang Anda tuju tidak tersedia.',
    user: req.session.user
  });
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`LMS SMKN 1 Kras running on http://localhost:${port}`);
});

// Initialize Socket.io
const { initializeSocket } = require('./socket');
initializeSocket(server);

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  
  // Close HTTP server
  server.close(() => {
    console.log('✅ HTTP server closed');
  });
  
  // Close Redis connection
  try {
    await redisClient.quit();
    console.log('✅ Redis connection closed');
  } catch (err) {
    console.error('❌ Error closing Redis:', err.message);
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, shutting down gracefully...');
  
  server.close(() => {
    console.log('✅ HTTP server closed');
  });
  
  try {
    await redisClient.quit();
    console.log('✅ Redis connection closed');
  } catch (err) {
    console.error('❌ Error during shutdown:', err.message);
  }
  
  process.exit(0);
});
