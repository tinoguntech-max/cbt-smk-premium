const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/login', { title: 'Login' });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [[user]] = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.class_id, u.password_hash, u.profile_photo,
              c.name AS class_name, c.code AS class_code
       FROM users u
       LEFT JOIN classes c ON c.id = u.class_id
       WHERE u.username = :username AND u.is_active=1
       LIMIT 1;`,
      { username }
    );

    if (!user) {
      req.flash('error', 'Username tidak ditemukan atau akun nonaktif.');
      return res.redirect('/login');
    }

    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) {
      req.flash('error', 'Password salah.');
      return res.redirect('/login');
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      class_id: user.class_id,
      class_name: user.class_name,
      class_code: user.class_code,
      profile_photo: user.profile_photo
    };

    req.flash('success', `Selamat datang, ${user.full_name}!`);
    return res.redirect('/dashboard');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Terjadi kesalahan saat login.');
    return res.redirect('/login');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
