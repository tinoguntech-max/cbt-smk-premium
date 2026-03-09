const express = require('express');
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('PRINCIPAL'));

router.get('/', async (req, res) => {
  const user = req.session.user;
  try {
    const [[sCnt]] = await pool.query(`SELECT COUNT(*) AS c FROM users WHERE role='STUDENT' AND is_active=1;`);
    const [[tCnt]] = await pool.query(`SELECT COUNT(*) AS c FROM users WHERE role='TEACHER' AND is_active=1;`);
    const [[eCnt]] = await pool.query(`SELECT COUNT(*) AS c FROM exams;`);
    const [[ePub]] = await pool.query(`SELECT COUNT(*) AS c FROM exams WHERE is_published=1;`);
    const [[mCnt]] = await pool.query(`SELECT COUNT(*) AS c FROM materials;`);
    const [[mPub]] = await pool.query(`SELECT COUNT(*) AS c FROM materials WHERE is_published=1;`);
    const [[doneAny]] = await pool.query(`SELECT COUNT(DISTINCT student_id) AS c FROM attempts;`);
    const [[readAny]] = await pool.query(`SELECT COUNT(DISTINCT student_id) AS c FROM material_reads;`);

    const [examProgress] = await pool.query(
      `SELECT e.id, e.title, e.is_published,
              (SELECT GROUP_CONCAT(c.name SEPARATOR ', ') 
               FROM exam_classes ec 
               JOIN classes c ON c.id=ec.class_id 
               WHERE ec.exam_id=e.id) AS class_names,
              (SELECT COUNT(DISTINCT a.student_id) FROM attempts a WHERE a.exam_id=e.id) AS done_count,
              (SELECT COUNT(*) FROM users u
                WHERE u.role='STUDENT' AND u.is_active=1
                  AND (
                    NOT EXISTS (SELECT 1 FROM exam_classes ec WHERE ec.exam_id=e.id)
                    OR EXISTS (SELECT 1 FROM exam_classes ec WHERE ec.exam_id=e.id AND ec.class_id=u.class_id)
                  )
              ) AS eligible_count,
              (SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) AS question_count,
              u2.full_name AS teacher_name
       FROM exams e
       JOIN users u2 ON u2.id=e.teacher_id
       ORDER BY e.id DESC
       LIMIT 10;`
    );

    const [materialProgress] = await pool.query(
      `SELECT m.id, m.title, m.is_published, c.name AS class_name,
              (SELECT COUNT(DISTINCT mr.student_id) FROM material_reads mr WHERE mr.material_id=m.id) AS read_count,
              (SELECT COUNT(DISTINCT mr.student_id) FROM material_reads mr WHERE mr.material_id=m.id AND mr.completed_at IS NOT NULL) AS completed_count,
              (SELECT COUNT(*) FROM users u
                WHERE u.role='STUDENT' AND u.is_active=1
                  AND (m.class_id IS NULL OR u.class_id=m.class_id)
              ) AS eligible_count,
              u2.full_name AS teacher_name,
              s.name AS subject_name
       FROM materials m
       JOIN users u2 ON u2.id=m.teacher_id
       JOIN subjects s ON s.id=m.subject_id
       LEFT JOIN classes c ON c.id=m.class_id
       ORDER BY m.id DESC
       LIMIT 10;`
    );

    const [teacherActivity] = await pool.query(
      `SELECT u.id, u.full_name,
              (SELECT COUNT(*) FROM exams e WHERE e.teacher_id=u.id) AS exams_count,
              (SELECT COUNT(*) FROM materials m WHERE m.teacher_id=u.id) AS materials_count
       FROM users u
       WHERE u.role='TEACHER' AND u.is_active=1
       ORDER BY (exams_count + materials_count) DESC, u.full_name ASC;`
    );

    return res.render('principal/index', {
      title: 'Dashboard Kepala Sekolah',
      summary: {
        students: sCnt.c,
        teachers: tCnt.c,
        exams: eCnt.c,
        exams_published: ePub.c,
        materials: mCnt.c,
        materials_published: mPub.c,
        students_done_any_exam: doneAny.c,
        students_read_any_material: readAny.c
      },
      examProgress,
      materialProgress,
      teacherActivity,
      user
    });
  } catch (e) {
    console.error(e);
    return res.status(500).render('error', {
      title: 'Error',
      message: 'Gagal memuat dashboard kepala sekolah.',
      user
    });
  }
});

router.get('/exams', async (req, res) => {
  const user = req.session.user;
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const classFilter = req.query.class || '';
    const statusFilter = req.query.status || '';

    const [classes] = await pool.query(`SELECT id, name FROM classes ORDER BY name;`);
    
    // Build WHERE clause
    let whereConditions = [];
    let queryParams = {};
    
    if (search) {
      whereConditions.push('(e.title LIKE :search OR s.name LIKE :search OR u.full_name LIKE :search)');
      queryParams.search = `%${search}%`;
    }
    
    if (classFilter) {
      whereConditions.push('EXISTS (SELECT 1 FROM exam_classes ec WHERE ec.exam_id=e.id AND ec.class_id = :classId)');
      queryParams.classId = classFilter;
    }
    
    if (statusFilter) {
      whereConditions.push('e.is_published = :status');
      queryParams.status = statusFilter === 'published' ? 1 : 0;
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    // Get total count
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM exams e
       JOIN users u ON u.id=e.teacher_id
       JOIN subjects s ON s.id=e.subject_id
       ${whereClause}`,
      queryParams
    );
    
    const [exams] = await pool.query(
      `SELECT e.id, e.title, e.is_published, e.start_at, e.duration_minutes, e.pass_score,
              (SELECT GROUP_CONCAT(c.name SEPARATOR ', ') 
               FROM exam_classes ec 
               JOIN classes c ON c.id=ec.class_id 
               WHERE ec.exam_id=e.id) AS class_names,
              s.name AS subject_name,
              u.full_name AS teacher_name,
              (SELECT COUNT(DISTINCT a.student_id) FROM attempts a WHERE a.exam_id=e.id AND a.status='SUBMITTED') AS done_count,
              (SELECT COUNT(*) FROM users u2
                WHERE u2.role='STUDENT' AND u2.is_active=1
                  AND (
                    NOT EXISTS (SELECT 1 FROM exam_classes ec WHERE ec.exam_id=e.id)
                    OR EXISTS (SELECT 1 FROM exam_classes ec WHERE ec.exam_id=e.id AND ec.class_id=u2.class_id)
                  )
              ) AS eligible_count,
              (SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) AS question_count,
              (SELECT AVG(a.score) FROM attempts a WHERE a.exam_id=e.id AND a.status='SUBMITTED') AS avg_score
       FROM exams e
       JOIN users u ON u.id=e.teacher_id
       JOIN subjects s ON s.id=e.subject_id
       ${whereClause}
       ORDER BY e.id DESC
       LIMIT :limit OFFSET :offset;`,
      { ...queryParams, limit, offset }
    );

    const totalPages = Math.ceil(total / limit);

    return res.render('principal/exams', {
      title: 'Rekap Ujian',
      exams,
      classes,
      pagination: {
        page,
        limit,
        total,
        totalPages
      },
      filters: {
        search,
        class: classFilter,
        status: statusFilter
      },
      user
    });
  } catch (e) {
    console.error(e);
    return res.status(500).render('error', {
      title: 'Error',
      message: 'Gagal memuat rekap ujian.',
      user
    });
  }
});

router.get('/materials', async (req, res) => {
  const user = req.session.user;
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const classFilter = req.query.class || '';
    const subjectFilter = req.query.subject || '';
    const statusFilter = req.query.status || '';

    const [classes] = await pool.query(`SELECT id, name FROM classes ORDER BY name;`);
    const [subjects] = await pool.query(`SELECT id, name FROM subjects ORDER BY name;`);
    
    // Build WHERE clause
    let whereConditions = [];
    let queryParams = {};
    
    if (search) {
      whereConditions.push('(m.title LIKE :search OR s.name LIKE :search OR u.full_name LIKE :search)');
      queryParams.search = `%${search}%`;
    }
    
    if (classFilter) {
      whereConditions.push('m.class_id = :classId');
      queryParams.classId = classFilter;
    }
    
    if (subjectFilter) {
      whereConditions.push('m.subject_id = :subjectId');
      queryParams.subjectId = subjectFilter;
    }
    
    if (statusFilter) {
      whereConditions.push('m.is_published = :status');
      queryParams.status = statusFilter === 'published' ? 1 : 0;
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    // Get total count
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM materials m
       JOIN users u ON u.id=m.teacher_id
       JOIN subjects s ON s.id=m.subject_id
       ${whereClause}`,
      queryParams
    );
    
    const [materials] = await pool.query(
      `SELECT m.id, m.title, m.is_published, m.embed_type, m.created_at,
              c.id AS class_id, c.name AS class_name,
              s.id AS subject_id, s.name AS subject_name,
              u.full_name AS teacher_name,
              (SELECT COUNT(DISTINCT mr.student_id) FROM material_reads mr WHERE mr.material_id=m.id) AS read_count,
              (SELECT COUNT(DISTINCT mr.student_id) FROM material_reads mr WHERE mr.material_id=m.id AND mr.completed_at IS NOT NULL) AS completed_count,
              (SELECT COUNT(*) FROM users u2
                WHERE u2.role='STUDENT' AND u2.is_active=1
                  AND (m.class_id IS NULL OR u2.class_id=m.class_id)
              ) AS eligible_count
       FROM materials m
       JOIN users u ON u.id=m.teacher_id
       JOIN subjects s ON s.id=m.subject_id
       LEFT JOIN classes c ON c.id=m.class_id
       ${whereClause}
       ORDER BY m.id DESC
       LIMIT :limit OFFSET :offset;`,
      { ...queryParams, limit, offset }
    );

    const totalPages = Math.ceil(total / limit);

    return res.render('principal/materials', {
      title: 'Rekap Materi',
      materials,
      classes,
      subjects,
      pagination: {
        page,
        limit,
        total,
        totalPages
      },
      filters: {
        search,
        class: classFilter,
        subject: subjectFilter,
        status: statusFilter
      },
      user
    });
  } catch (e) {
    console.error(e);
    return res.status(500).render('error', {
      title: 'Error',
      message: 'Gagal memuat rekap materi.',
      user
    });
  }
});

module.exports = router;
