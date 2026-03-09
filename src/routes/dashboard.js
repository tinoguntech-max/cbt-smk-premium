const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'PRINCIPAL') {
    return res.redirect('/principal');
  }
  try {
    let stats = {};
    if (user.role === 'ADMIN') {
      const [[uCnt]] = await pool.query(`SELECT COUNT(*) AS c FROM users;`);
      const [[eCnt]] = await pool.query(`SELECT COUNT(*) AS c FROM exams;`);
      const [[qCnt]] = await pool.query(`SELECT COUNT(*) AS c FROM questions;`);
      stats = { users: uCnt.c, exams: eCnt.c, questions: qCnt.c };
    }

    if (user.role === 'TEACHER') {
      const [[eCnt]] = await pool.query(`SELECT COUNT(*) AS c FROM exams WHERE teacher_id=:id;`, { id: user.id });
      const [[aCnt]] = await pool.query(
        `SELECT COUNT(*) AS c FROM attempts a
         JOIN exams e ON e.id=a.exam_id
         WHERE e.teacher_id=:id;`,
        { id: user.id }
      );
      stats = { exams: eCnt.c, attempts: aCnt.c };
    }

    if (user.role === 'STUDENT') {
      const [[aCnt]] = await pool.query(`SELECT COUNT(*) AS c FROM attempts WHERE student_id=:id;`, { id: user.id });
      const [[last]] = await pool.query(
        `SELECT a.id, a.score, a.status, a.finished_at, e.title
         FROM attempts a
         JOIN exams e ON e.id=a.exam_id
         WHERE a.student_id=:id
         ORDER BY a.id DESC
         LIMIT 1;`,
        { id: user.id }
      );
      const [[mCnt]] = await pool.query(`SELECT COUNT(*) AS c FROM material_reads WHERE student_id=:id;`, { id: user.id });
      stats = { attempts: aCnt.c, last_attempt: last || null, materials: mCnt.c };
    }

    res.render('dashboard/index', { title: 'Dashboard', stats });
  } catch (e) {
    console.error(e);
    res.render('dashboard/index', { title: 'Dashboard', stats: {} });
  }
});

module.exports = router;
