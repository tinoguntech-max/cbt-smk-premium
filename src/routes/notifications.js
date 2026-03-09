const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Middleware untuk cek role
function requireTeacherOrAdmin(req, res, next) {
  if (!req.session.user) {
    req.flash('error', 'Silakan login terlebih dahulu');
    return res.redirect('/login');
  }
  
  const role = req.session.user.role.toLowerCase();
  if (role !== 'teacher' && role !== 'admin') {
    req.flash('error', 'Akses ditolak. Hanya guru dan admin yang dapat mengakses halaman ini.');
    return res.redirect('/dashboard');
  }
  
  next();
}

// ===== TEACHER/ADMIN ROUTES =====

// Halaman kelola notifikasi (teacher/admin)
router.get('/', requireTeacherOrAdmin, async (req, res) => {
  const user = req.session.user;
  
  try {
    // Admin bisa lihat semua, teacher hanya lihat miliknya
    const isAdmin = user.role.toLowerCase() === 'admin';
    
    let query, params;
    if (isAdmin) {
      query = `SELECT n.*, u.username AS sender_name,
              (SELECT COUNT(*) FROM notification_reads nr WHERE nr.notification_id = n.id) AS read_count
       FROM notifications n
       JOIN users u ON u.id = n.sender_id
       ORDER BY n.created_at DESC
       LIMIT 100`;
      params = [];
    } else {
      query = `SELECT n.*, u.username AS sender_name,
              (SELECT COUNT(*) FROM notification_reads nr WHERE nr.notification_id = n.id) AS read_count
       FROM notifications n
       JOIN users u ON u.id = n.sender_id
       WHERE n.sender_id = ?
       ORDER BY n.created_at DESC
       LIMIT 100`;
      params = [user.id];
    }
    
    const [notifications] = await pool.query(query, params);
    
    res.render('notifications/index', { 
      title: 'Kelola Notifikasi', 
      notifications 
    });
  } catch (error) {
    console.error('Error loading notifications:', error);
    req.flash('error', 'Gagal memuat notifikasi: ' + error.message);
    res.redirect('/dashboard');
  }
});

// Form buat notifikasi baru
router.get('/new', requireTeacherOrAdmin, async (req, res) => {
  try {
    // Get classes for dropdown
    const [classes] = await pool.query('SELECT id, name FROM classes ORDER BY name ASC');
    
    // Get students with class info (full_name, username, kelas)
    const [students] = await pool.query(
      `SELECT u.id, u.username, u.full_name, c.name AS class_name, u.class_id
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
       WHERE u.role = 'student'
       ORDER BY c.name ASC, u.full_name ASC, u.username ASC`
    );
    
    res.render('notifications/new', { 
      title: 'Buat Notifikasi Baru',
      classes,
      students
    });
  } catch (error) {
    console.error('Error loading form:', error);
    req.flash('error', 'Gagal memuat form: ' + error.message);
    res.redirect('/notifications');
  }
});

// Create notifikasi
router.post('/new', requireTeacherOrAdmin, async (req, res) => {
  const user = req.session.user;
  const { title, message, type, target_type, target_id, expires_hours } = req.body;
  
  try {
    let expiresAt = null;
    if (expires_hours && Number(expires_hours) > 0) {
      expiresAt = new Date(Date.now() + Number(expires_hours) * 60 * 60 * 1000);
    }
    
    // Validasi target_id
    let finalTargetId = null;
    if (target_type !== 'all' && target_id) {
      const parsed = parseInt(target_id);
      if (!isNaN(parsed)) {
        finalTargetId = parsed;
      }
    }
    
    await pool.query(
      `INSERT INTO notifications (title, message, type, sender_id, sender_role, target_type, target_id, is_active, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
      [
        title,
        message,
        type || 'info',
        user.id,
        user.role.toLowerCase(),
        target_type || 'all',
        finalTargetId,
        expiresAt
      ]
    );
    
    req.flash('success', 'Notifikasi berhasil dibuat dan akan tampil ke siswa');
    res.redirect('/notifications');
  } catch (error) {
    console.error('Error creating notification:', error);
    req.flash('error', 'Gagal membuat notifikasi: ' + error.message);
    res.redirect('/notifications/new');
  }
});

// Form edit notifikasi
router.get('/:id/edit', requireTeacherOrAdmin, async (req, res) => {
  const user = req.session.user;
  const notifId = req.params.id;
  
  try {
    // Get notification
    const [[notification]] = await pool.query(
      `SELECT * FROM notifications WHERE id = ?`,
      [notifId]
    );
    
    if (!notification) {
      req.flash('error', 'Notifikasi tidak ditemukan');
      return res.redirect('/notifications');
    }
    
    // Check permission (teacher can only edit their own)
    if (user.role.toLowerCase() !== 'admin' && notification.sender_id !== user.id) {
      req.flash('error', 'Anda tidak memiliki akses untuk mengedit notifikasi ini');
      return res.redirect('/notifications');
    }
    
    // Get classes for dropdown
    const [classes] = await pool.query('SELECT id, name FROM classes ORDER BY name ASC');
    
    // Get students with class info
    const [students] = await pool.query(
      `SELECT u.id, u.username, u.full_name, c.name AS class_name, u.class_id
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
       WHERE u.role = 'student'
       ORDER BY c.name ASC, u.full_name ASC, u.username ASC`
    );
    
    res.render('notifications/edit', { 
      title: 'Edit Notifikasi',
      notification,
      classes,
      students
    });
  } catch (error) {
    console.error('Error loading edit form:', error);
    req.flash('error', 'Gagal memuat form edit: ' + error.message);
    res.redirect('/notifications');
  }
});

// Update notifikasi
router.post('/:id/edit', requireTeacherOrAdmin, async (req, res) => {
  const user = req.session.user;
  const notifId = req.params.id;
  const { title, message, type, target_type, target_id, expires_hours } = req.body;
  
  try {
    // Check permission
    const [[notification]] = await pool.query(
      `SELECT sender_id FROM notifications WHERE id = ?`,
      [notifId]
    );
    
    if (!notification) {
      req.flash('error', 'Notifikasi tidak ditemukan');
      return res.redirect('/notifications');
    }
    
    if (user.role.toLowerCase() !== 'admin' && notification.sender_id !== user.id) {
      req.flash('error', 'Anda tidak memiliki akses untuk mengedit notifikasi ini');
      return res.redirect('/notifications');
    }
    
    let expiresAt = null;
    if (expires_hours && Number(expires_hours) > 0) {
      expiresAt = new Date(Date.now() + Number(expires_hours) * 60 * 60 * 1000);
    }
    
    // Validasi target_id
    let finalTargetId = null;
    if (target_type !== 'all' && target_id) {
      const parsed = parseInt(target_id);
      if (!isNaN(parsed)) {
        finalTargetId = parsed;
      }
    }
    
    await pool.query(
      `UPDATE notifications 
       SET title = ?, message = ?, type = ?, target_type = ?, target_id = ?, expires_at = ?
       WHERE id = ?`,
      [title, message, type || 'info', target_type || 'all', finalTargetId, expiresAt, notifId]
    );
    
    req.flash('success', 'Notifikasi berhasil diupdate');
    res.redirect('/notifications');
  } catch (error) {
    console.error('Error updating notification:', error);
    req.flash('error', 'Gagal mengupdate notifikasi: ' + error.message);
    res.redirect(`/notifications/${notifId}/edit`);
  }
});

// Toggle active status
router.post('/:id/toggle', requireTeacherOrAdmin, async (req, res) => {
  const notifId = req.params.id;
  
  try {
    await pool.query(
      `UPDATE notifications SET is_active = NOT is_active WHERE id = ?`,
      [notifId]
    );
    
    req.flash('success', 'Status notifikasi berhasil diubah');
    res.redirect('/notifications');
  } catch (error) {
    console.error('Error toggling notification:', error);
    req.flash('error', 'Gagal mengubah status');
    res.redirect('/notifications');
  }
});

// Delete notifikasi
router.post('/:id/delete', requireTeacherOrAdmin, async (req, res) => {
  const notifId = req.params.id;
  
  try {
    await pool.query(`DELETE FROM notifications WHERE id = ?`, [notifId]);
    
    req.flash('success', 'Notifikasi berhasil dihapus');
    res.redirect('/notifications');
  } catch (error) {
    console.error('Error deleting notification:', error);
    req.flash('error', 'Gagal menghapus notifikasi');
    res.redirect('/notifications');
  }
});

// ===== STUDENT ROUTES =====

// API untuk get notifikasi aktif (untuk siswa)
router.get('/active', async (req, res) => {
  const user = req.session.user;
  
  if (!user || user.role.toLowerCase() !== 'student') {
    return res.json({ notifications: [] });
  }
  
  try {
    // Get student's class
    const [[studentData]] = await pool.query(
      `SELECT class_id FROM users WHERE id = ?`,
      [user.id]
    );
    
    const classId = studentData?.class_id;
    
    // Get active notifications yang belum dibaca
    const [notifications] = await pool.query(
      `SELECT n.id, n.title, n.message, n.type, n.created_at
       FROM notifications n
       WHERE n.is_active = TRUE
         AND (n.expires_at IS NULL OR n.expires_at > NOW())
         AND (
           n.target_type = 'all'
           OR (n.target_type = 'class' AND n.target_id = ?)
           OR (n.target_type = 'student' AND n.target_id = ?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM notification_reads nr 
           WHERE nr.notification_id = n.id AND nr.student_id = ?
         )
       ORDER BY n.created_at DESC
       LIMIT 5`,
      [classId, user.id, user.id]
    );
    
    res.json({ notifications });
  } catch (error) {
    console.error('Error getting active notifications:', error);
    res.json({ notifications: [] });
  }
});

// Mark notifikasi as read
router.post('/:id/read', async (req, res) => {
  const user = req.session.user;
  const notifId = req.params.id;
  
  if (!user || user.role.toLowerCase() !== 'student') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  try {
    await pool.query(
      `INSERT IGNORE INTO notification_reads (notification_id, student_id)
       VALUES (?, ?)`,
      [notifId, user.id]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

module.exports = router;
