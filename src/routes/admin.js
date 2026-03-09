const express = require('express');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('ADMIN'));

// Upload config for admin imports
const importDir = path.join(__dirname, '..', 'public', 'uploads', 'imports');
fs.mkdirSync(importDir, { recursive: true });

const storageImport = multer.diskStorage({
  destination: (req, file, cb) => cb(null, importDir),
  filename: (req, file, cb) => {
    const safe = String(file.originalname || 'file')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 180);
    cb(null, `${Date.now()}_${safe}`);
  }
});

const uploadImport = multer({
  storage: storageImport,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

function pickRowValue(row, keys) {
  const lowered = {};
  for (const k of Object.keys(row || {})) lowered[String(k).trim().toLowerCase()] = row[k];
  for (const k of keys) {
    const v = lowered[String(k).trim().toLowerCase()];
    if (v !== undefined) return v;
  }
  return '';
}

function normalizeClassKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildStudentImportPreview(rows, classesMap, existingUsernamesSet) {
  const preview = [];
  const errors = [];

  rows.forEach((row, idx) => {
    const rowNo = idx + 2;
    const reasons = [];

    const username = String(pickRowValue(row, ['username', 'user', 'nis', 'nisn'])).trim();
    const full_name = String(pickRowValue(row, ['full_name', 'nama', 'name', 'nama_lengkap'])).trim();
    const classRaw = pickRowValue(row, ['class', 'kelas', 'class_code', 'kelas_kode', 'class_name', 'kelas_nama']);
    const classText = String(classRaw || '').trim();
    const passwordRaw = pickRowValue(row, ['password', 'pwd', 'pass']);
    const password = String(passwordRaw || '').trim();

    if (!username) reasons.push('Kolom username/nis wajib diisi');
    if (!full_name) reasons.push('Kolom full_name/nama wajib diisi');

    let class_id = null;
    if (classText) {
      const key = normalizeClassKey(classText);
      const hit = classesMap.get(key);
      if (hit) class_id = hit.id;
      else reasons.push(`Kelas tidak ditemukan: "${classText}" (gunakan kode/nama yang ada di menu Kelas)`);
    }

    const action = existingUsernamesSet.has(username) ? 'UPDATE' : 'INSERT';

    const item = {
      rowNo,
      username,
      full_name,
      classText: classText || '-',
      class_id,
      passwordProvided: Boolean(password),
      action
    };

    if (reasons.length) errors.push({ rowNo, reasons, snapshot: item });
    else preview.push({ ...item, password });
  });

  return { preview, errors };
}

function buildCodeNameImportPreview(rows, existingCodesSet) {
  const preview = [];
  const errors = [];

  rows.forEach((row, idx) => {
    const rowNo = idx + 2;
    const reasons = [];

    const code = String(pickRowValue(row, ['code', 'kode'])).trim();
    const name = String(pickRowValue(row, ['name', 'nama'])).trim();

    if (!code) reasons.push('Kolom code/kode wajib diisi');
    if (!name) reasons.push('Kolom name/nama wajib diisi');

    const action = existingCodesSet.has(code) ? 'UPDATE' : 'INSERT';
    const item = { rowNo, code, name, action };

    if (reasons.length) errors.push({ rowNo, reasons, snapshot: item });
    else preview.push(item);
  });

  return { preview, errors };
}

function buildTeacherImportPreview(rows, existingUsernamesSet) {
  const preview = [];
  const errors = [];

  rows.forEach((row, idx) => {
    const rowNo = idx + 2;
    const reasons = [];

    const username = String(pickRowValue(row, ['username', 'user', 'nip', 'nuptk', 'email'])).trim();
    const full_name = String(pickRowValue(row, ['full_name', 'nama', 'name', 'nama_lengkap'])).trim();
    const passwordRaw = pickRowValue(row, ['password', 'pwd', 'pass']);
    const password = String(passwordRaw || '').trim();

    if (!username) reasons.push('Kolom username/nip wajib diisi');
    if (!full_name) reasons.push('Kolom full_name/nama wajib diisi');

    const action = existingUsernamesSet.has(username) ? 'UPDATE' : 'INSERT';
    const item = { rowNo, username, full_name, passwordProvided: Boolean(password), action };

    if (reasons.length) errors.push({ rowNo, reasons, snapshot: item });
    else preview.push({ ...item, password });
  });

  return { preview, errors };
}

router.get('/', (req, res) => {
  res.render('admin/index', { title: 'Panel Admin' });
});

// ===== CLASSES =====
router.get('/classes', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';

  let whereClause = '';
  let queryParams = {};
  
  if (search) {
    whereClause = 'WHERE code LIKE :search OR name LIKE :search';
    queryParams.search = `%${search}%`;
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM classes ${whereClause}`,
    queryParams
  );

  const [classes] = await pool.query(
    `SELECT * FROM classes ${whereClause} ORDER BY id DESC LIMIT :limit OFFSET :offset;`,
    { ...queryParams, limit, offset }
  );

  const totalPages = Math.ceil(total / limit);

  res.render('admin/classes', { 
    title: 'Kelola Kelas', 
    classes,
    pagination: {
      page,
      limit,
      total,
      totalPages
    },
    filters: {
      search
    }
  });
});

// Download classes as Excel
router.get('/classes/download', async (req, res) => {
  try {
    const [classes] = await pool.query(`SELECT id, code, name, created_at FROM classes ORDER BY id DESC;`);
    
    // Format data for Excel
    const data = classes.map(c => ({
      'ID': c.id,
      'Kode': c.code,
      'Nama': c.name,
      'Dibuat': new Date(c.created_at).toLocaleString('id-ID')
    }));
    
    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    
    // Set column widths
    ws['!cols'] = [
      { wch: 8 },  // ID
      { wch: 15 }, // Kode
      { wch: 30 }, // Nama
      { wch: 20 }  // Dibuat
    ];
    
    XLSX.utils.book_append_sheet(wb, ws, 'Kelas');
    
    // Generate buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    // Send file
    res.setHeader('Content-Disposition', `attachment; filename="data_kelas_${Date.now()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal mengunduh data kelas.');
    res.redirect('/admin/classes');
  }
});

router.get('/classes/import', async (req, res) => {
  res.render('admin/classes_import', { title: 'Import Masal Kelas' });
});

router.post('/classes/import/preview', uploadImport.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    req.flash('error', 'File import belum dipilih.');
    return res.redirect('/admin/classes/import');
  }

  try {
    const wb = XLSX.readFile(file.path, { cellDates: true });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) {
      req.flash('error', 'File kosong / tidak ada data.');
      return res.redirect('/admin/classes/import');
    }

    const [existing] = await pool.query(`SELECT code FROM classes;`);
    const existingCodesSet = new Set((existing || []).map((x) => x.code));

    const { preview, errors } = buildCodeNameImportPreview(rows, existingCodesSet);
    const importId = nanoid(12);

    req.session.classImportPreview = { importId, preview, errors, createdAt: Date.now() };
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}

    return res.render('admin/classes_import_preview', {
      title: 'Preview Import Kelas',
      importId,
      preview,
      errors
    });
  } catch (e) {
    console.error(e);
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}
    req.flash('error', 'Gagal membaca file. Pastikan format Excel/CSV sesuai template.');
    return res.redirect('/admin/classes/import');
  }
});

router.get('/classes/import/errors.csv', async (req, res) => {
  const sess = req.session.classImportPreview;
  if (!sess || !Array.isArray(sess.errors)) return res.status(404).send('Tidak ada data error.');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="import_kelas_errors.csv"');
  res.write('row_no,reasons\n');
  for (const e of sess.errors) {
    const reasons = (e.reasons || []).join(' | ').replace(/\r?\n/g, ' ').replace(/"/g, '""');
    res.write(`${e.rowNo},"${reasons}"\n`);
  }
  res.end();
});

router.post('/classes/import/commit', async (req, res) => {
  const { importId } = req.body;
  const sess = req.session.classImportPreview;

  if (!sess || sess.importId !== importId) {
    req.flash('error', 'Sesi preview tidak valid / sudah kedaluwarsa. Silakan upload ulang.');
    return res.redirect('/admin/classes/import');
  }

  const items = Array.isArray(sess.preview) ? sess.preview : [];
  if (!items.length) {
    req.flash('error', 'Tidak ada data valid untuk di-import (periksa error).');
    return res.redirect('/admin/classes/import');
  }

  const conn = await pool.getConnection();
  let inserted = 0;
  let updated = 0;
  try {
    await conn.beginTransaction();
    for (const it of items) {
      await conn.query(
        `INSERT INTO classes (code, name)
         VALUES (:code,:name)
         ON DUPLICATE KEY UPDATE
           name=VALUES(name);`,
        { code: it.code, name: it.name }
      );
      if (it.action === 'UPDATE') updated += 1;
      else inserted += 1;
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error(e);
    req.flash('error', 'Gagal commit import kelas. Coba ulangi / pecah file.');
    return res.redirect('/admin/classes/import');
  } finally {
    conn.release();
  }

  req.session.classImportPreview = null;
  req.flash('success', `Import kelas berhasil. Insert: ${inserted}, Update: ${updated}.`);
  return res.redirect('/admin/classes');
});

router.post('/classes', async (req, res) => {
  const { code, name } = req.body;
  try {
    await pool.query(`INSERT INTO classes (code, name) VALUES (:code,:name);`, { code, name });
    req.flash('success', 'Kelas ditambahkan.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menambahkan kelas (mungkin kode sudah ada).');
  }
  res.redirect('/admin/classes');
});

router.post('/classes/:id/update', async (req, res) => {
  const { code, name } = req.body;
  try {
    await pool.query(`UPDATE classes SET code=:code, name=:name WHERE id=:id;`, {
      id: req.params.id,
      code,
      name
    });
    req.flash('success', 'Kelas diperbarui.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal memperbarui kelas (mungkin kode sudah dipakai).');
  }
  res.redirect('/admin/classes');
});

// JSON endpoint untuk modal edit kelas (AJAX)
router.get('/classes/:id/json', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id, code, name FROM classes WHERE id=:id LIMIT 1;`, {
      id: req.params.id
    });
    const item = rows && rows[0];
    if (!item) return res.status(404).json({ ok: false, message: 'Kelas tidak ditemukan.' });
    return res.json({ ok: true, item });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'Gagal memuat data kelas.' });
  }
});

// Update via AJAX untuk modal edit kelas
router.post('/classes/:id/ajax-update', async (req, res) => {
  const { code, name } = req.body || {};
  try {
    await pool.query(`UPDATE classes SET code=:code, name=:name WHERE id=:id;`, {
      id: req.params.id,
      code: String(code || '').trim(),
      name: String(name || '').trim()
    });
    const [rows] = await pool.query(`SELECT id, code, name FROM classes WHERE id=:id LIMIT 1;`, { id: req.params.id });
    return res.json({ ok: true, item: rows && rows[0] });
  } catch (e) {
    console.error(e);
    if (String(e && e.code) === 'ER_DUP_ENTRY') {
      return res.status(409).json({ ok: false, message: 'Kode kelas sudah dipakai.' });
    }
    return res.status(500).json({ ok: false, message: 'Gagal menyimpan perubahan kelas.' });
  }
});

router.delete('/classes/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM classes WHERE id=:id;`, { id: req.params.id });
    req.flash('success', 'Kelas dihapus.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menghapus kelas.');
  }
  res.redirect('/admin/classes');
});

// Bulk delete classes
router.post('/classes/bulk-delete', async (req, res) => {
  let class_ids = req.body.class_ids;
  
  if (typeof class_ids === 'string') {
    try {
      class_ids = JSON.parse(class_ids);
    } catch (e) {
      req.flash('error', 'Format data tidak valid.');
      return res.redirect('/admin/classes');
    }
  }
  
  if (!class_ids || !Array.isArray(class_ids) || class_ids.length === 0) {
    req.flash('error', 'Tidak ada kelas yang dipilih untuk dihapus.');
    return res.redirect('/admin/classes');
  }

  const validIds = class_ids.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
  
  if (validIds.length === 0) {
    req.flash('error', 'Tidak ada ID kelas yang valid.');
    return res.redirect('/admin/classes');
  }

  const conn = await pool.getConnection();
  let deleted = 0;
  
  try {
    await conn.beginTransaction();
    
    const placeholders = validIds.map(() => '?').join(',');
    
    // Delete related data
    await conn.query(`UPDATE users SET class_id = NULL WHERE class_id IN (${placeholders});`, validIds);
    await conn.query(`DELETE FROM exam_classes WHERE class_id IN (${placeholders});`, validIds);
    await conn.query(`DELETE FROM material_classes WHERE class_id IN (${placeholders});`, validIds);
    
    // Delete classes
    const [result] = await conn.query(`DELETE FROM classes WHERE id IN (${placeholders});`, validIds);
    deleted = result.affectedRows || 0;
    
    await conn.commit();
    req.flash('success', `Berhasil menghapus ${deleted} kelas dan data terkait.`);
  } catch (e) {
    await conn.rollback();
    console.error(e);
    req.flash('error', 'Gagal menghapus kelas. Terjadi kesalahan pada database.');
  } finally {
    conn.release();
  }
  
  res.redirect('/admin/classes');
});

// ===== SUBJECTS =====
router.get('/subjects', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';

  let whereClause = '';
  let queryParams = {};
  
  if (search) {
    whereClause = 'WHERE code LIKE :search OR name LIKE :search';
    queryParams.search = `%${search}%`;
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM subjects ${whereClause}`,
    queryParams
  );

  const [subjects] = await pool.query(
    `SELECT * FROM subjects ${whereClause} ORDER BY id DESC LIMIT :limit OFFSET :offset;`,
    { ...queryParams, limit, offset }
  );

  const totalPages = Math.ceil(total / limit);

  res.render('admin/subjects', { 
    title: 'Kelola Mapel', 
    subjects,
    pagination: {
      page,
      limit,
      total,
      totalPages
    },
    filters: {
      search
    }
  });
});

// Download subjects as Excel
router.get('/subjects/download', async (req, res) => {
  try {
    const [subjects] = await pool.query(`SELECT id, code, name, created_at FROM subjects ORDER BY id DESC;`);
    
    // Format data for Excel
    const data = subjects.map(s => ({
      'ID': s.id,
      'Kode': s.code,
      'Nama': s.name,
      'Dibuat': new Date(s.created_at).toLocaleString('id-ID')
    }));
    
    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    
    // Set column widths
    ws['!cols'] = [
      { wch: 8 },  // ID
      { wch: 15 }, // Kode
      { wch: 40 }, // Nama
      { wch: 20 }  // Dibuat
    ];
    
    XLSX.utils.book_append_sheet(wb, ws, 'Mata Pelajaran');
    
    // Generate buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    // Send file
    res.setHeader('Content-Disposition', `attachment; filename="data_mata_pelajaran_${Date.now()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal mengunduh data mata pelajaran.');
    res.redirect('/admin/subjects');
  }
});

router.get('/subjects/import', async (req, res) => {
  res.render('admin/subjects_import', { title: 'Import Masal Mapel' });
});

router.post('/subjects/import/preview', uploadImport.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    req.flash('error', 'File import belum dipilih.');
    return res.redirect('/admin/subjects/import');
  }

  try {
    const wb = XLSX.readFile(file.path, { cellDates: true });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) {
      req.flash('error', 'File kosong / tidak ada data.');
      return res.redirect('/admin/subjects/import');
    }

    const [existing] = await pool.query(`SELECT code FROM subjects;`);
    const existingCodesSet = new Set((existing || []).map((x) => x.code));

    const { preview, errors } = buildCodeNameImportPreview(rows, existingCodesSet);
    const importId = nanoid(12);

    req.session.subjectImportPreview = { importId, preview, errors, createdAt: Date.now() };
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}

    return res.render('admin/subjects_import_preview', {
      title: 'Preview Import Mapel',
      importId,
      preview,
      errors
    });
  } catch (e) {
    console.error(e);
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}
    req.flash('error', 'Gagal membaca file. Pastikan format Excel/CSV sesuai template.');
    return res.redirect('/admin/subjects/import');
  }
});

router.get('/subjects/import/errors.csv', async (req, res) => {
  const sess = req.session.subjectImportPreview;
  if (!sess || !Array.isArray(sess.errors)) return res.status(404).send('Tidak ada data error.');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="import_mapel_errors.csv"');
  res.write('row_no,reasons\n');
  for (const e of sess.errors) {
    const reasons = (e.reasons || []).join(' | ').replace(/\r?\n/g, ' ').replace(/"/g, '""');
    res.write(`${e.rowNo},"${reasons}"\n`);
  }
  res.end();
});

router.post('/subjects/import/commit', async (req, res) => {
  const { importId } = req.body;
  const sess = req.session.subjectImportPreview;

  if (!sess || sess.importId !== importId) {
    req.flash('error', 'Sesi preview tidak valid / sudah kedaluwarsa. Silakan upload ulang.');
    return res.redirect('/admin/subjects/import');
  }

  const items = Array.isArray(sess.preview) ? sess.preview : [];
  if (!items.length) {
    req.flash('error', 'Tidak ada data valid untuk di-import (periksa error).');
    return res.redirect('/admin/subjects/import');
  }

  const conn = await pool.getConnection();
  let inserted = 0;
  let updated = 0;
  try {
    await conn.beginTransaction();
    for (const it of items) {
      await conn.query(
        `INSERT INTO subjects (code, name)
         VALUES (:code,:name)
         ON DUPLICATE KEY UPDATE
           name=VALUES(name);`,
        { code: it.code, name: it.name }
      );
      if (it.action === 'UPDATE') updated += 1;
      else inserted += 1;
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error(e);
    req.flash('error', 'Gagal commit import mapel. Coba ulangi / pecah file.');
    return res.redirect('/admin/subjects/import');
  } finally {
    conn.release();
  }

  req.session.subjectImportPreview = null;
  req.flash('success', `Import mapel berhasil. Insert: ${inserted}, Update: ${updated}.`);
  return res.redirect('/admin/subjects');
});

router.post('/subjects', async (req, res) => {
  const { code, name } = req.body;
  try {
    await pool.query(`INSERT INTO subjects (code, name) VALUES (:code,:name);`, { code, name });
    req.flash('success', 'Mapel ditambahkan.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menambahkan mapel (mungkin kode sudah ada).');
  }
  res.redirect('/admin/subjects');
});

router.post('/subjects/:id/update', async (req, res) => {
  const { code, name } = req.body;
  try {
    await pool.query(`UPDATE subjects SET code=:code, name=:name WHERE id=:id;`, {
      id: req.params.id,
      code,
      name
    });
    req.flash('success', 'Mapel diperbarui.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal memperbarui mapel (mungkin kode sudah dipakai).');
  }
  res.redirect('/admin/subjects');
});

// JSON endpoint untuk modal edit mapel (AJAX)
router.get('/subjects/:id/json', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id, code, name FROM subjects WHERE id=:id LIMIT 1;`, {
      id: req.params.id
    });
    const item = rows && rows[0];
    if (!item) return res.status(404).json({ ok: false, message: 'Mapel tidak ditemukan.' });
    return res.json({ ok: true, item });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'Gagal memuat data mapel.' });
  }
});

// Update via AJAX untuk modal edit mapel
router.post('/subjects/:id/ajax-update', async (req, res) => {
  const { code, name } = req.body || {};
  try {
    await pool.query(`UPDATE subjects SET code=:code, name=:name WHERE id=:id;`, {
      id: req.params.id,
      code: String(code || '').trim(),
      name: String(name || '').trim()
    });
    const [rows] = await pool.query(`SELECT id, code, name FROM subjects WHERE id=:id LIMIT 1;`, { id: req.params.id });
    return res.json({ ok: true, item: rows && rows[0] });
  } catch (e) {
    console.error(e);
    if (String(e && e.code) === 'ER_DUP_ENTRY') {
      return res.status(409).json({ ok: false, message: 'Kode mapel sudah dipakai.' });
    }
    return res.status(500).json({ ok: false, message: 'Gagal menyimpan perubahan mapel.' });
  }
});

// ===== TEACHERS =====
router.get('/teachers', async (req, res) => {
  const [teachers] = await pool.query(
    `SELECT id, username, full_name, role, is_active, created_at
     FROM users
     WHERE role='TEACHER'
     ORDER BY id DESC;`
  );
  res.render('admin/teachers', { title: 'Kelola Guru', teachers });
});

// Download teachers as Excel
router.get('/teachers/download', async (req, res) => {
  try {
    const [teachers] = await pool.query(
      `SELECT id, username, full_name, is_active, created_at
       FROM users
       WHERE role='TEACHER'
       ORDER BY id DESC;`
    );
    
    // Format data for Excel
    const data = teachers.map(t => ({
      'ID': t.id,
      'Username': t.username,
      'Nama Lengkap': t.full_name,
      'Status': t.is_active ? 'Aktif' : 'Nonaktif',
      'Dibuat': new Date(t.created_at).toLocaleString('id-ID')
    }));
    
    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    
    // Set column widths
    ws['!cols'] = [
      { wch: 8 },  // ID
      { wch: 20 }, // Username
      { wch: 30 }, // Nama Lengkap
      { wch: 12 }, // Status
      { wch: 20 }  // Dibuat
    ];
    
    XLSX.utils.book_append_sheet(wb, ws, 'Guru');
    
    // Generate buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    // Send file
    res.setHeader('Content-Disposition', `attachment; filename="data_guru_${Date.now()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal mengunduh data guru.');
    res.redirect('/admin/teachers');
  }
});

router.post('/teachers', async (req, res) => {
  const { username, full_name, password } = req.body;
  try {
    const password_hash = await bcrypt.hash(password || '123456', 10);
    await pool.query(
      `INSERT INTO users (username, full_name, role, class_id, password_hash, is_active)
       VALUES (:username,:full_name,'TEACHER',NULL,:password_hash,1);`,
      { username, full_name, password_hash }
    );
    req.flash('success', 'Guru ditambahkan.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menambahkan guru (mungkin username sudah ada).');
  }
  res.redirect('/admin/teachers');
});

router.post('/teachers/:id/update', async (req, res) => {
  const { username, full_name, is_active, password } = req.body;
  try {
    const setPassword = String(password || '').trim() ? 1 : 0;
    const password_hash = await bcrypt.hash(String(password || '123456').trim() || '123456', 10);
    await pool.query(
      `UPDATE users
       SET username=:username,
           full_name=:full_name,
           is_active=:is_active,
           password_hash=IF(:setPassword=1, :password_hash, password_hash)
       WHERE id=:id AND role='TEACHER';`,
      {
        id: req.params.id,
        username,
        full_name,
        is_active: Number(is_active) ? 1 : 0,
        setPassword,
        password_hash
      }
    );
    req.flash('success', 'Data guru diperbarui.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal memperbarui guru (mungkin username sudah dipakai).');
  }
  res.redirect('/admin/teachers');
});

// JSON endpoint untuk modal edit guru (AJAX)
router.get('/teachers/:id/json', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, full_name, is_active
       FROM users
       WHERE id=:id AND role='TEACHER'
       LIMIT 1;`,
      { id: req.params.id }
    );
    const item = rows && rows[0];
    if (!item) return res.status(404).json({ ok: false, message: 'Guru tidak ditemukan.' });
    return res.json({ ok: true, item });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'Gagal memuat data guru.' });
  }
});

// Update via AJAX untuk modal edit guru
router.post('/teachers/:id/ajax-update', async (req, res) => {
  const { username, full_name, is_active, new_password } = req.body || {};
  try {
    const setPassword = new_password && String(new_password).trim().length > 0 ? 1 : 0;
    const password_hash = setPassword ? await bcrypt.hash(String(new_password).trim(), 10) : null;

    await pool.query(
      `UPDATE users
       SET username=:username,
           full_name=:full_name,
           is_active=:is_active,
           password_hash=IF(:setPassword=1, :password_hash, password_hash)
       WHERE id=:id AND role='TEACHER';`,
      {
        id: req.params.id,
        username: String(username || '').trim(),
        full_name: String(full_name || '').trim(),
        is_active: String(is_active) === '1' || is_active === true ? 1 : 0,
        setPassword,
        password_hash
      }
    );

    const [rows] = await pool.query(
      `SELECT id, username, full_name, is_active
       FROM users
       WHERE id=:id AND role='TEACHER'
       LIMIT 1;`,
      { id: req.params.id }
    );

    return res.json({ ok: true, item: rows && rows[0] });
  } catch (e) {
    console.error(e);
    if (String(e && e.code) === 'ER_DUP_ENTRY') {
      return res.status(409).json({ ok: false, message: 'Username sudah dipakai pengguna lain.' });
    }
    return res.status(500).json({ ok: false, message: 'Gagal menyimpan perubahan guru.' });
  }
});

router.post('/teachers/:id/reset', async (req, res) => {
  try {
    const password_hash = await bcrypt.hash(req.body.new_password || '123456', 10);
    await pool.query(`UPDATE users SET password_hash=:ph WHERE id=:id AND role='TEACHER';`, {
      ph: password_hash,
      id: req.params.id
    });
    req.flash('success', 'Password guru direset.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal reset password.');
  }
  res.redirect('/admin/teachers');
});

router.post('/teachers/:id/toggle', async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET is_active = IF(is_active=1,0,1) WHERE id=:id AND role='TEACHER';`,
      { id: req.params.id }
    );
    req.flash('success', 'Status guru diperbarui.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal memperbarui status.');
  }
  res.redirect('/admin/teachers');
});

router.delete('/teachers/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM users WHERE id=:id AND role='TEACHER';`, { id: req.params.id });
    req.flash('success', 'Guru dihapus.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menghapus guru.');
  }
  res.redirect('/admin/teachers');
});

router.get('/teachers/import', async (req, res) => {
  res.render('admin/teachers_import', { title: 'Import Masal Guru' });
});

router.post('/teachers/import/preview', uploadImport.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    req.flash('error', 'File import belum dipilih.');
    return res.redirect('/admin/teachers/import');
  }

  try {
    const wb = XLSX.readFile(file.path, { cellDates: true });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) {
      req.flash('error', 'File kosong / tidak ada data.');
      return res.redirect('/admin/teachers/import');
    }

    const usernames = rows
      .map((r) => String(pickRowValue(r, ['username', 'user', 'nip', 'nuptk', 'email'])).trim())
      .filter(Boolean);
    const uniq = Array.from(new Set(usernames));
    let existingUsernamesSet = new Set();
    if (uniq.length) {
      const placeholders = uniq.map(() => '?').join(',');
      const [exists] = await pool.query(`SELECT username FROM users WHERE username IN (${placeholders});`, uniq);
      existingUsernamesSet = new Set((exists || []).map((x) => x.username));
    }

    const { preview, errors } = buildTeacherImportPreview(rows, existingUsernamesSet);
    const importId = nanoid(12);
    req.session.teacherImportPreview = { importId, preview, errors, createdAt: Date.now() };

    try {
      fs.unlinkSync(file.path);
    } catch (_) {}

    return res.render('admin/teachers_import_preview', {
      title: 'Preview Import Guru',
      importId,
      preview,
      errors
    });
  } catch (e) {
    console.error(e);
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}
    req.flash('error', 'Gagal membaca file. Pastikan format Excel/CSV sesuai template.');
    return res.redirect('/admin/teachers/import');
  }
});

router.get('/teachers/import/errors.csv', async (req, res) => {
  const sess = req.session.teacherImportPreview;
  if (!sess || !Array.isArray(sess.errors)) return res.status(404).send('Tidak ada data error.');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="import_guru_errors.csv"');
  res.write('row_no,reasons\n');
  for (const e of sess.errors) {
    const reasons = (e.reasons || []).join(' | ').replace(/\r?\n/g, ' ').replace(/"/g, '""');
    res.write(`${e.rowNo},"${reasons}"\n`);
  }
  res.end();
});

router.post('/teachers/import/commit', async (req, res) => {
  const { importId } = req.body;
  const sess = req.session.teacherImportPreview;

  if (!sess || sess.importId !== importId) {
    req.flash('error', 'Sesi preview tidak valid / sudah kedaluwarsa. Silakan upload ulang.');
    return res.redirect('/admin/teachers/import');
  }

  const items = Array.isArray(sess.preview) ? sess.preview : [];
  if (!items.length) {
    req.flash('error', 'Tidak ada data valid untuk di-import (periksa error).');
    return res.redirect('/admin/teachers/import');
  }

  const conn = await pool.getConnection();
  let inserted = 0;
  let updated = 0;
  try {
    await conn.beginTransaction();
    for (const it of items) {
      const pwd = String(it.password || '').trim();
      const setPassword = pwd ? 1 : 0;
      const password_hash = await bcrypt.hash(pwd || '123456', 10);

      await conn.query(
        `INSERT INTO users (username, full_name, role, class_id, password_hash, is_active)
         VALUES (:username,:full_name,'TEACHER',NULL,:password_hash,1)
         ON DUPLICATE KEY UPDATE
           full_name=VALUES(full_name),
           role='TEACHER',
           class_id=NULL,
           is_active=1,
           password_hash=IF(:setPassword=1, :password_hash, password_hash);`,
        {
          username: it.username,
          full_name: it.full_name,
          password_hash,
          setPassword
        }
      );

      if (it.action === 'UPDATE') updated += 1;
      else inserted += 1;
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error(e);
    req.flash('error', 'Gagal commit import guru. Coba ulangi / pecah file.');
    return res.redirect('/admin/teachers/import');
  } finally {
    conn.release();
  }

  req.session.teacherImportPreview = null;
  req.flash('success', `Import guru berhasil. Insert: ${inserted}, Update: ${updated}.`);
  return res.redirect('/admin/teachers');
});

router.delete('/subjects/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM subjects WHERE id=:id;`, { id: req.params.id });
    req.flash('success', 'Mapel dihapus.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menghapus mapel.');
  }
  res.redirect('/admin/subjects');
});

// Bulk delete subjects
router.post('/subjects/bulk-delete', async (req, res) => {
  let subject_ids = req.body.subject_ids;
  
  if (typeof subject_ids === 'string') {
    try {
      subject_ids = JSON.parse(subject_ids);
    } catch (e) {
      req.flash('error', 'Format data tidak valid.');
      return res.redirect('/admin/subjects');
    }
  }
  
  if (!subject_ids || !Array.isArray(subject_ids) || subject_ids.length === 0) {
    req.flash('error', 'Tidak ada mata pelajaran yang dipilih untuk dihapus.');
    return res.redirect('/admin/subjects');
  }

  const validIds = subject_ids.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
  
  if (validIds.length === 0) {
    req.flash('error', 'Tidak ada ID mata pelajaran yang valid.');
    return res.redirect('/admin/subjects');
  }

  const conn = await pool.getConnection();
  let deleted = 0;
  
  try {
    await conn.beginTransaction();
    
    const placeholders = validIds.map(() => '?').join(',');
    
    // Delete related data
    await conn.query(`DELETE FROM exams WHERE subject_id IN (${placeholders});`, validIds);
    await conn.query(`DELETE FROM materials WHERE subject_id IN (${placeholders});`, validIds);
    await conn.query(`DELETE FROM question_bank WHERE subject_id IN (${placeholders});`, validIds);
    
    // Delete subjects
    const [result] = await conn.query(`DELETE FROM subjects WHERE id IN (${placeholders});`, validIds);
    deleted = result.affectedRows || 0;
    
    await conn.commit();
    req.flash('success', `Berhasil menghapus ${deleted} mata pelajaran dan data terkait.`);
  } catch (e) {
    await conn.rollback();
    console.error(e);
    req.flash('error', 'Gagal menghapus mata pelajaran. Terjadi kesalahan pada database.');
  } finally {
    conn.release();
  }
  
  res.redirect('/admin/subjects');
});

// ===== USERS =====
router.get('/users', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim();
  const roleFilter = (req.query.role || '').trim();
  const classFilter = (req.query.class || '').trim();
  const statusFilter = (req.query.status || '').trim();

  const [classes] = await pool.query(`SELECT id, code, name FROM classes ORDER BY name ASC;`);
  
  // Build WHERE clause
  let whereConditions = [];
  let queryParams = {};
  
  if (search) {
    whereConditions.push('(u.username LIKE :search OR u.full_name LIKE :search)');
    queryParams.search = `%${search}%`;
  }
  
  if (roleFilter) {
    whereConditions.push('u.role = :role');
    queryParams.role = roleFilter;
  }
  
  if (classFilter) {
    whereConditions.push('u.class_id = :classId');
    queryParams.classId = parseInt(classFilter);
  }
  
  if (statusFilter) {
    whereConditions.push('u.is_active = :status');
    queryParams.status = statusFilter === 'active' ? 1 : 0;
  }
  
  const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
  
  // Get total count
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM users u ${whereClause}`,
    queryParams
  );
  
  // Get paginated users
  const [users] = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.class_id, c.name AS class_name
     FROM users u
     LEFT JOIN classes c ON c.id=u.class_id
     ${whereClause}
     ORDER BY u.id DESC
     LIMIT :limit OFFSET :offset;`,
    { ...queryParams, limit, offset }
  );
  
  const totalPages = Math.ceil(total / limit);
  
  res.render('admin/users', { 
    title: 'Kelola Pengguna', 
    users, 
    classes,
    pagination: {
      page,
      limit,
      total,
      totalPages
    },
    filters: {
      search,
      role: roleFilter,
      class: classFilter,
      status: statusFilter
    }
  });
});

// Download users as Excel
router.get('/users/download', async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.is_active, c.name AS class_name, u.created_at
       FROM users u
       LEFT JOIN classes c ON c.id=u.class_id
       ORDER BY u.id DESC;`
    );
    
    // Format data for Excel
    const data = users.map(u => ({
      'ID': u.id,
      'Username': u.username,
      'Nama Lengkap': u.full_name,
      'Role': u.role,
      'Kelas': u.class_name || '-',
      'Status': u.is_active ? 'Aktif' : 'Nonaktif',
      'Dibuat': new Date(u.created_at).toLocaleString('id-ID')
    }));
    
    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    
    // Set column widths
    ws['!cols'] = [
      { wch: 8 },  // ID
      { wch: 20 }, // Username
      { wch: 30 }, // Nama Lengkap
      { wch: 12 }, // Role
      { wch: 20 }, // Kelas
      { wch: 12 }, // Status
      { wch: 20 }  // Dibuat
    ];
    
    XLSX.utils.book_append_sheet(wb, ws, 'Pengguna');
    
    // Generate buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    // Send file
    res.setHeader('Content-Disposition', `attachment; filename="data_pengguna_${Date.now()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal mengunduh data pengguna.');
    res.redirect('/admin/users');
  }
});

// JSON endpoint untuk modal edit (AJAX)
router.get('/users/:id/json', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, full_name, role, class_id, is_active
       FROM users
       WHERE id=:id
       LIMIT 1;`,
      { id: req.params.id }
    );
    const user = rows && rows[0];
    if (!user) return res.status(404).json({ ok: false, message: 'Pengguna tidak ditemukan.' });
    return res.json({ ok: true, user });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'Gagal memuat data pengguna.' });
  }
});

// Update via AJAX untuk modal edit
router.post('/users/:id/ajax-update', async (req, res) => {
  const { username, full_name, role, class_id, is_active, new_password } = req.body || {};
  try {
    const setPassword = new_password && String(new_password).trim().length > 0 ? 1 : 0;
    const password_hash = setPassword ? await bcrypt.hash(String(new_password).trim(), 10) : null;

    await pool.query(
      `UPDATE users
       SET username=:username,
           full_name=:full_name,
           role=:role,
           class_id=:class_id,
           is_active=:is_active,
           password_hash=IF(:setPassword=1, :password_hash, password_hash)
       WHERE id=:id;`,
      {
        id: req.params.id,
        username: String(username || '').trim(),
        full_name: String(full_name || '').trim(),
        role: String(role || 'STUDENT').trim(),
        class_id: class_id ? Number(class_id) : null,
        is_active: String(is_active) === '1' || is_active === true ? 1 : 0,
        setPassword,
        password_hash
      }
    );

    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.class_id, c.name AS class_name
       FROM users u
       LEFT JOIN classes c ON c.id=u.class_id
       WHERE u.id=:id
       LIMIT 1;`,
      { id: req.params.id }
    );
    return res.json({ ok: true, user: rows && rows[0] });
  } catch (e) {
    console.error(e);
    if (String(e && e.code) === 'ER_DUP_ENTRY') {
      return res.status(409).json({ ok: false, message: 'Username sudah dipakai pengguna lain.' });
    }
    return res.status(500).json({ ok: false, message: 'Gagal menyimpan perubahan pengguna.' });
  }
});

// ===== EDIT PENGGUNA (terutama siswa) =====
router.get('/users/:id/edit', async (req, res) => {
  try {
    const [classes] = await pool.query(`SELECT id, code, name FROM classes ORDER BY name ASC;`);
    const [rows] = await pool.query(
      `SELECT id, username, full_name, role, class_id, is_active
       FROM users
       WHERE id=:id
       LIMIT 1;`,
      { id: req.params.id }
    );
    const user = rows && rows[0];
    if (!user) {
      req.flash('error', 'Pengguna tidak ditemukan.');
      return res.redirect('/admin/users');
    }
    return res.render('admin/users_edit', { title: 'Edit Pengguna', user, classes });
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal membuka halaman edit pengguna.');
    return res.redirect('/admin/users');
  }
});

router.post('/users/:id/edit', async (req, res) => {
  const { username, full_name, role, class_id, is_active, new_password } = req.body;
  try {
    const setPassword = new_password && String(new_password).trim().length > 0 ? 1 : 0;
    const password_hash = setPassword ? await bcrypt.hash(String(new_password).trim(), 10) : null;

    await pool.query(
      `UPDATE users
       SET username=:username,
           full_name=:full_name,
           role=:role,
           class_id=:class_id,
           is_active=:is_active,
           password_hash=IF(:setPassword=1, :password_hash, password_hash)
       WHERE id=:id;`,
      {
        id: req.params.id,
        username: String(username || '').trim(),
        full_name: String(full_name || '').trim(),
        role: String(role || 'STUDENT').trim(),
        class_id: class_id ? Number(class_id) : null,
        is_active: String(is_active) === '1' ? 1 : 0,
        setPassword,
        password_hash
      }
    );

    req.flash('success', 'Pengguna berhasil diperbarui.');
    return res.redirect('/admin/users');
  } catch (e) {
    console.error(e);
    if (String(e && e.code) === 'ER_DUP_ENTRY') {
      req.flash('error', 'Gagal menyimpan: username sudah dipakai pengguna lain.');
      return res.redirect(`/admin/users/${req.params.id}/edit`);
    }
    req.flash('error', 'Gagal menyimpan perubahan pengguna.');
    return res.redirect(`/admin/users/${req.params.id}/edit`);
  }
});

// ===== IMPORT SISWA (MASS UPLOAD) =====
router.get('/users/import', async (req, res) => {
  const [classes] = await pool.query(`SELECT id, code, name FROM classes ORDER BY name ASC;`);
  res.render('admin/users_import', { title: 'Import Masal Siswa', classes });
});

router.post('/users/import/preview', uploadImport.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    req.flash('error', 'File import belum dipilih.');
    return res.redirect('/admin/users/import');
  }

  try {
    const wb = XLSX.readFile(file.path, { cellDates: true });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) {
      req.flash('error', 'File kosong / tidak ada data.');
      return res.redirect('/admin/users/import');
    }

    // Build class map by code and name
    const [classes] = await pool.query(`SELECT id, code, name FROM classes;`);
    const classesMap = new Map();
    for (const c of classes) {
      if (c.code) classesMap.set(normalizeClassKey(c.code), c);
      if (c.name) classesMap.set(normalizeClassKey(c.name), c);
    }

    // collect usernames to detect insert/update
    const usernames = rows
      .map((r) => String(pickRowValue(r, ['username', 'user', 'nis', 'nisn'])).trim())
      .filter(Boolean);
    const uniq = Array.from(new Set(usernames));

    let existingUsernamesSet = new Set();
    if (uniq.length) {
      const placeholders = uniq.map(() => '?').join(',');
      const [exists] = await pool.query(`SELECT username FROM users WHERE username IN (${placeholders});`, uniq);
      existingUsernamesSet = new Set((exists || []).map((x) => x.username));
    }

    const { preview, errors } = buildStudentImportPreview(rows, classesMap, existingUsernamesSet);
    const importId = nanoid(12);

    // store on session (keep raw password so we can hash on commit)
    req.session.studentImportPreview = {
      importId,
      preview,
      errors,
      createdAt: Date.now()
    };

    // cleanup temp file
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}

    return res.render('admin/users_import_preview', {
      title: 'Preview Import Siswa',
      importId,
      preview,
      errors
    });
  } catch (e) {
    console.error(e);
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}
    req.flash('error', 'Gagal membaca file. Pastikan format Excel/CSV sesuai template.');
    return res.redirect('/admin/users/import');
  }
});

// Download laporan error (CSV) dari sesi preview terakhir
router.get('/users/import/errors.csv', async (req, res) => {
  const sess = req.session.studentImportPreview;
  if (!sess || !Array.isArray(sess.errors)) {
    return res.status(404).send('Tidak ada data error (jalankan preview import dulu).');
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="import_siswa_errors.csv"');
  res.write('row_no,reasons\n');
  for (const e of sess.errors) {
    const reasons = (e.reasons || []).join(' | ').replace(/\r?\n/g, ' ').replace(/"/g, '""');
    res.write(`${e.rowNo},"${reasons}"\n`);
  }
  res.end();
});

// Commit import dari preview
router.post('/users/import/commit', async (req, res) => {
  const { importId } = req.body;
  const sess = req.session.studentImportPreview;

  if (!sess || sess.importId !== importId) {
    req.flash('error', 'Sesi preview tidak valid / sudah kedaluwarsa. Silakan upload ulang.');
    return res.redirect('/admin/users/import');
  }

  const items = Array.isArray(sess.preview) ? sess.preview : [];
  if (!items.length) {
    req.flash('error', 'Tidak ada data valid untuk di-import (periksa error).');
    return res.redirect('/admin/users/import');
  }

  const conn = await pool.getConnection();
  let inserted = 0;
  let updated = 0;

  try {
    await conn.beginTransaction();
    for (const it of items) {
      const pwd = String(it.password || '').trim();
      const setPassword = pwd ? 1 : 0;
      const password_hash = await bcrypt.hash(pwd || '123456', 10);

      await conn.query(
        `INSERT INTO users (username, full_name, role, class_id, password_hash, is_active)
         VALUES (:username,:full_name,'STUDENT',:class_id,:password_hash,1)
         ON DUPLICATE KEY UPDATE
           full_name=VALUES(full_name),
           role='STUDENT',
           class_id=VALUES(class_id),
           is_active=1,
           password_hash=IF(:setPassword=1, :password_hash, password_hash);
        `,
        {
          username: it.username,
          full_name: it.full_name,
          class_id: it.class_id || null,
          password_hash,
          setPassword
        }
      );

      if (it.action === 'UPDATE') updated += 1;
      else inserted += 1;
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error(e);
    req.flash('error', 'Gagal commit import. Coba ulangi atau pecah file menjadi lebih kecil.');
    return res.redirect('/admin/users/import');
  } finally {
    conn.release();
  }

  // clear session preview
  req.session.studentImportPreview = null;
  req.flash('success', `Import siswa berhasil. Insert: ${inserted}, Update: ${updated}.`);
  return res.redirect('/admin/users');
});

router.post('/users', async (req, res) => {
  const { username, full_name, role, class_id, password } = req.body;
  try {
    const password_hash = await bcrypt.hash(password || '123456', 10);
    await pool.query(
      `INSERT INTO users (username, full_name, role, class_id, password_hash)
       VALUES (:username,:full_name,:role,:class_id,:password_hash);`,
      {
        username,
        full_name,
        role,
        class_id: class_id || null,
        password_hash
      }
    );
    req.flash('success', 'Pengguna ditambahkan.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menambahkan pengguna (mungkin username sudah ada).');
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/reset', async (req, res) => {
  try {
    const password_hash = await bcrypt.hash(req.body.new_password || '123456', 10);
    await pool.query(`UPDATE users SET password_hash=:ph WHERE id=:id;`, { ph: password_hash, id: req.params.id });
    req.flash('success', 'Password direset.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal reset password.');
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/toggle', async (req, res) => {
  try {
    await pool.query(`UPDATE users SET is_active = IF(is_active=1,0,1) WHERE id=:id;`, { id: req.params.id });
    req.flash('success', 'Status akun diperbarui.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal memperbarui status akun.');
  }
  res.redirect('/admin/users');
});

router.delete('/users/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM users WHERE id=:id;`, { id: req.params.id });
    req.flash('success', 'Pengguna dihapus.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menghapus pengguna.');
  }
  res.redirect('/admin/users');
});

// Bulk delete users
router.post('/users/bulk-delete', async (req, res) => {
  let user_ids = req.body.user_ids;
  
  // Parse JSON string if needed
  if (typeof user_ids === 'string') {
    try {
      user_ids = JSON.parse(user_ids);
    } catch (e) {
      req.flash('error', 'Format data tidak valid.');
      return res.redirect('/admin/users');
    }
  }
  
  if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
    req.flash('error', 'Tidak ada pengguna yang dipilih untuk dihapus.');
    return res.redirect('/admin/users');
  }

  // Convert to integers and filter valid IDs
  const validIds = user_ids.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
  
  if (validIds.length === 0) {
    req.flash('error', 'Tidak ada ID pengguna yang valid.');
    return res.redirect('/admin/users');
  }

  const conn = await pool.getConnection();
  let deleted = 0;
  
  try {
    await conn.beginTransaction();
    
    // Delete related data first to avoid foreign key constraints
    const placeholders = validIds.map(() => '?').join(',');
    
    // Delete attempts
    await conn.query(`DELETE FROM attempts WHERE user_id IN (${placeholders});`, validIds);
    
    // Delete assignment submissions
    await conn.query(`DELETE FROM assignment_submissions WHERE user_id IN (${placeholders});`, validIds);
    
    // Delete notification reads
    await conn.query(`DELETE FROM notification_reads WHERE user_id IN (${placeholders});`, validIds);
    
    // Delete live class participants
    await conn.query(`DELETE FROM live_class_participants WHERE user_id IN (${placeholders});`, validIds);
    
    // Finally delete users
    const [result] = await conn.query(`DELETE FROM users WHERE id IN (${placeholders});`, validIds);
    deleted = result.affectedRows || 0;
    
    await conn.commit();
    req.flash('success', `Berhasil menghapus ${deleted} pengguna dan data terkait.`);
  } catch (e) {
    await conn.rollback();
    console.error(e);
    req.flash('error', 'Gagal menghapus pengguna. Terjadi kesalahan pada database.');
  } finally {
    conn.release();
  }
  
  res.redirect('/admin/users');
});

// ===== EXAMS (UJIAN) =====
router.get('/exams', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';
  const subjectFilter = req.query.subject || '';
  const teacherFilter = req.query.teacher || '';
  const classFilter = req.query.class || '';
  const statusFilter = req.query.status || '';

  // Get filter options
  const [subjects] = await pool.query(`SELECT id, code, name FROM subjects ORDER BY name ASC;`);
  const [teachers] = await pool.query(`SELECT id, username, full_name FROM users WHERE role='TEACHER' ORDER BY full_name ASC;`);
  const [classes] = await pool.query(`SELECT id, code, name FROM classes ORDER BY name ASC;`);

  // Build WHERE clause
  let whereConditions = [];
  let queryParams = {};

  if (search) {
    whereConditions.push('(e.title LIKE :search OR e.description LIKE :search)');
    queryParams.search = `%${search}%`;
  }

  if (subjectFilter) {
    whereConditions.push('e.subject_id = :subjectId');
    queryParams.subjectId = subjectFilter;
  }

  if (teacherFilter) {
    whereConditions.push('e.teacher_id = :teacherId');
    queryParams.teacherId = teacherFilter;
  }

  if (classFilter) {
    whereConditions.push('e.class_id = :classId');
    queryParams.classId = classFilter;
  }

  if (statusFilter === 'published') {
    whereConditions.push('e.is_published = 1');
  } else if (statusFilter === 'draft') {
    whereConditions.push('e.is_published = 0');
  }

  const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

  // Get total count
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM exams e ${whereClause}`,
    queryParams
  );

  // Get paginated exams with related data
  const [exams] = await pool.query(
    `SELECT 
      e.id, e.title, e.description, e.start_at, e.end_at, 
      e.duration_minutes, e.is_published, e.created_at,
      s.name AS subject_name, s.code AS subject_code,
      u.full_name AS teacher_name,
      c.name AS class_name,
      (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) AS question_count,
      (SELECT COUNT(*) FROM attempts WHERE exam_id = e.id) AS attempt_count
     FROM exams e
     LEFT JOIN subjects s ON s.id = e.subject_id
     LEFT JOIN users u ON u.id = e.teacher_id
     LEFT JOIN classes c ON c.id = e.class_id
     ${whereClause}
     ORDER BY e.created_at DESC
     LIMIT :limit OFFSET :offset;`,
    { ...queryParams, limit, offset }
  );

  const totalPages = Math.ceil(total / limit);

  res.render('admin/exams', {
    title: 'Kelola Ujian',
    exams,
    subjects,
    teachers,
    classes,
    pagination: {
      page,
      limit,
      total,
      totalPages
    },
    filters: {
      search,
      subject: subjectFilter,
      teacher: teacherFilter,
      class: classFilter,
      status: statusFilter
    }
  });
});

// Get exam detail JSON for modal
router.get('/exams/:id/json', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT 
        e.id, e.title, e.description, e.subject_id, e.teacher_id, e.class_id,
        e.start_at, e.end_at, e.duration_minutes, e.pass_score, 
        e.shuffle_questions, e.shuffle_options, e.max_attempts, 
        e.access_code, e.is_published,
        s.name AS subject_name,
        u.full_name AS teacher_name,
        c.name AS class_name,
        (SELECT COUNT(*) FROM questions WHERE exam_id = e.id) AS question_count
       FROM exams e
       LEFT JOIN subjects s ON s.id = e.subject_id
       LEFT JOIN users u ON u.id = e.teacher_id
       LEFT JOIN classes c ON c.id = e.class_id
       WHERE e.id = :id
       LIMIT 1;`,
      { id: req.params.id }
    );
    const exam = rows && rows[0];
    if (!exam) return res.status(404).json({ ok: false, message: 'Ujian tidak ditemukan.' });
    return res.json({ ok: true, exam });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'Gagal memuat data ujian.' });
  }
});

// Toggle publish status
router.post('/exams/:id/toggle-publish', async (req, res) => {
  try {
    await pool.query(
      `UPDATE exams SET is_published = IF(is_published=1,0,1) WHERE id=:id;`,
      { id: req.params.id }
    );
    req.flash('success', 'Status publikasi ujian diperbarui.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal memperbarui status publikasi.');
  }
  res.redirect('/admin/exams');
});

// Delete exam
router.delete('/exams/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM exams WHERE id=:id;`, { id: req.params.id });
    req.flash('success', 'Ujian berhasil dihapus.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menghapus ujian.');
  }
  res.redirect('/admin/exams');
});

// Bulk delete exams
router.post('/exams/bulk-delete', async (req, res) => {
  let exam_ids = req.body.exam_ids;
  
  if (typeof exam_ids === 'string') {
    try {
      exam_ids = JSON.parse(exam_ids);
    } catch (e) {
      req.flash('error', 'Format data tidak valid.');
      return res.redirect('/admin/exams');
    }
  }
  
  if (!exam_ids || !Array.isArray(exam_ids) || exam_ids.length === 0) {
    req.flash('error', 'Tidak ada ujian yang dipilih untuk dihapus.');
    return res.redirect('/admin/exams');
  }

  const validIds = exam_ids.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
  
  if (validIds.length === 0) {
    req.flash('error', 'Tidak ada ID ujian yang valid.');
    return res.redirect('/admin/exams');
  }

  const conn = await pool.getConnection();
  let deleted = 0;
  
  try {
    await conn.beginTransaction();
    
    const placeholders = validIds.map(() => '?').join(',');
    
    // Delete related data
    await conn.query(`DELETE FROM attempts WHERE exam_id IN (${placeholders});`, validIds);
    await conn.query(`DELETE FROM questions WHERE exam_id IN (${placeholders});`, validIds);
    await conn.query(`DELETE FROM exam_classes WHERE exam_id IN (${placeholders});`, validIds);
    
    // Delete exams
    const [result] = await conn.query(`DELETE FROM exams WHERE id IN (${placeholders});`, validIds);
    deleted = result.affectedRows || 0;
    
    await conn.commit();
    req.flash('success', `Berhasil menghapus ${deleted} ujian dan data terkait.`);
  } catch (e) {
    await conn.rollback();
    console.error(e);
    req.flash('error', 'Gagal menghapus ujian. Terjadi kesalahan pada database.');
  } finally {
    conn.release();
  }
  
  res.redirect('/admin/exams');
});

// ===== MATERIALS =====
router.get('/materials', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  
  const search = (req.query.search || '').trim();
  const subjectFilter = (req.query.subject || '').trim();
  const teacherFilter = (req.query.teacher || '').trim();
  const classFilter = (req.query.class || '').trim();
  const statusFilter = (req.query.status || '').trim();

  // Get filter options
  const [subjects] = await pool.query(`SELECT id, code, name FROM subjects ORDER BY name ASC;`);
  const [teachers] = await pool.query(`SELECT id, full_name FROM users WHERE role='TEACHER' ORDER BY full_name ASC;`);
  const [classes] = await pool.query(`SELECT id, name FROM classes ORDER BY name ASC;`);

  // Build WHERE clause
  let whereConditions = [];
  let queryParams = {};
  
  if (search) {
    whereConditions.push('(m.title LIKE :search OR m.description LIKE :search)');
    queryParams.search = `%${search}%`;
  }
  
  if (subjectFilter) {
    whereConditions.push('m.subject_id = :subjectId');
    queryParams.subjectId = parseInt(subjectFilter);
  }
  
  if (teacherFilter) {
    whereConditions.push('m.teacher_id = :teacherId');
    queryParams.teacherId = parseInt(teacherFilter);
  }
  
  if (classFilter) {
    whereConditions.push('m.class_id = :classId');
    queryParams.classId = parseInt(classFilter);
  }
  
  if (statusFilter === 'published') {
    whereConditions.push('m.is_published = 1');
  } else if (statusFilter === 'draft') {
    whereConditions.push('m.is_published = 0');
  }
  
  const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
  
  // Get total count
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM materials m ${whereClause}`,
    queryParams
  );
  
  // Get paginated materials
  const [materials] = await pool.query(
    `SELECT 
      m.id, m.title, m.description, m.embed_type, m.embed_url, m.is_published, m.created_at,
      s.code AS subject_code, s.name AS subject_name,
      u.full_name AS teacher_name,
      c.name AS class_name,
      (SELECT COUNT(*) FROM material_reads WHERE material_id = m.id) AS read_count
     FROM materials m
     LEFT JOIN subjects s ON s.id = m.subject_id
     LEFT JOIN users u ON u.id = m.teacher_id
     LEFT JOIN classes c ON c.id = m.class_id
     ${whereClause}
     ORDER BY m.created_at DESC
     LIMIT :limit OFFSET :offset;`,
    { ...queryParams, limit, offset }
  );
  
  const totalPages = Math.ceil(total / limit);

  res.render('admin/materials', {
    title: 'Kelola Materi',
    materials,
    subjects,
    teachers,
    classes,
    pagination: {
      page,
      limit,
      total,
      totalPages
    },
    filters: {
      search,
      subject: subjectFilter,
      teacher: teacherFilter,
      class: classFilter,
      status: statusFilter
    }
  });
});

// Get material detail JSON for modal
router.get('/materials/:id/json', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT 
        m.id, m.title, m.description, m.content_html, m.embed_type, m.embed_url,
        m.subject_id, m.teacher_id, m.class_id, m.is_published,
        m.auto_complete_minutes, m.created_at,
        s.name AS subject_name,
        u.full_name AS teacher_name,
        c.name AS class_name,
        (SELECT COUNT(*) FROM material_reads WHERE material_id = m.id) AS read_count,
        (SELECT COUNT(*) FROM material_reads WHERE material_id = m.id AND completed_at IS NOT NULL) AS completed_count
       FROM materials m
       LEFT JOIN subjects s ON s.id = m.subject_id
       LEFT JOIN users u ON u.id = m.teacher_id
       LEFT JOIN classes c ON c.id = m.class_id
       WHERE m.id = :id
       LIMIT 1;`,
      { id: req.params.id }
    );
    const material = rows && rows[0];
    if (!material) return res.status(404).json({ ok: false, message: 'Materi tidak ditemukan.' });
    return res.json({ ok: true, material });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: 'Gagal memuat data materi.' });
  }
});

// Toggle publish status
router.post('/materials/:id/toggle-publish', async (req, res) => {
  try {
    await pool.query(
      `UPDATE materials SET is_published = IF(is_published=1,0,1) WHERE id=:id;`,
      { id: req.params.id }
    );
    req.flash('success', 'Status publikasi materi diperbarui.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal memperbarui status publikasi.');
  }
  res.redirect('/admin/materials');
});

// Delete material
router.delete('/materials/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM materials WHERE id=:id;`, { id: req.params.id });
    req.flash('success', 'Materi berhasil dihapus.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menghapus materi.');
  }
  res.redirect('/admin/materials');
});

// Bulk delete materials
router.post('/materials/bulk-delete', async (req, res) => {
  let material_ids = req.body.material_ids;
  
  if (typeof material_ids === 'string') {
    try {
      material_ids = JSON.parse(material_ids);
    } catch (e) {
      req.flash('error', 'Format data tidak valid.');
      return res.redirect('/admin/materials');
    }
  }
  
  if (!material_ids || !Array.isArray(material_ids) || material_ids.length === 0) {
    req.flash('error', 'Tidak ada materi yang dipilih untuk dihapus.');
    return res.redirect('/admin/materials');
  }

  const validIds = material_ids.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
  
  if (validIds.length === 0) {
    req.flash('error', 'Tidak ada ID materi yang valid.');
    return res.redirect('/admin/materials');
  }

  const conn = await pool.getConnection();
  let deleted = 0;
  
  try {
    await conn.beginTransaction();
    
    const placeholders = validIds.map(() => '?').join(',');
    
    // Delete related data
    await conn.query(`DELETE FROM material_reads WHERE material_id IN (${placeholders});`, validIds);
    await conn.query(`DELETE FROM material_classes WHERE material_id IN (${placeholders});`, validIds);
    
    // Delete materials
    const [result] = await conn.query(`DELETE FROM materials WHERE id IN (${placeholders});`, validIds);
    deleted = result.affectedRows || 0;
    
    await conn.commit();
    req.flash('success', `Berhasil menghapus ${deleted} materi dan data terkait.`);
  } catch (e) {
    await conn.rollback();
    console.error(e);
    req.flash('error', 'Gagal menghapus materi. Terjadi kesalahan pada database.');
  } finally {
    conn.release();
  }
  
  res.redirect('/admin/materials');
});

module.exports = router;


// ===== ASSIGNMENTS MANAGEMENT =====

// GET Admin Assignments List
router.get('/assignments', async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const subject_id = req.query.subject_id || '';
    const status = req.query.status || '';

    // Get subjects for filter
    const [subjects] = await pool.query(`SELECT id, name FROM subjects ORDER BY name ASC;`);

    // Build WHERE clause
    let whereConditions = ['1=1'];
    let queryParams = {};

    if (search) {
      whereConditions.push(`(a.title LIKE :search OR u.full_name LIKE :search)`);
      queryParams.search = `%${search}%`;
    }

    if (subject_id) {
      whereConditions.push(`a.subject_id = :subject_id`);
      queryParams.subject_id = subject_id;
    }

    if (status === 'published') {
      whereConditions.push(`a.is_published = 1`);
    } else if (status === 'draft') {
      whereConditions.push(`a.is_published = 0`);
    }

    const whereClause = whereConditions.join(' AND ');

    // Get assignments
    const [assignments] = await pool.query(
      `SELECT 
        a.*,
        u.full_name as teacher_name,
        s.name as subject_name,
        c.name as class_name,
        (SELECT COUNT(*) FROM assignment_submissions WHERE assignment_id = a.id) as submission_count
      FROM assignments a
      JOIN users u ON a.teacher_id = u.id
      JOIN subjects s ON a.subject_id = s.id
      LEFT JOIN classes c ON a.class_id = c.id
      WHERE ${whereClause}
      ORDER BY a.created_at DESC;`,
      queryParams
    );

    // Get stats
    const [[statsRow]] = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_published = 1 THEN 1 ELSE 0 END) as published,
        SUM(CASE WHEN is_published = 0 THEN 1 ELSE 0 END) as draft,
        (SELECT COUNT(*) FROM assignment_submissions) as submissions
      FROM assignments;
    `);

    const stats = {
      total: statsRow.total || 0,
      published: statsRow.published || 0,
      draft: statsRow.draft || 0,
      submissions: statsRow.submissions || 0
    };

    res.render('admin/assignments', {
      title: 'Manajemen Tugas',
      assignments,
      subjects,
      stats,
      search,
      subject_id,
      status
    });
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal memuat data tugas.');
    res.redirect('/admin');
  }
});

// POST Delete Assignment
router.post('/assignments/:id/delete', async (req, res) => {
  const assignmentId = req.params.id;
  
  try {
    await pool.query(`DELETE FROM assignments WHERE id = :id;`, { id: assignmentId });
    req.flash('success', 'Tugas berhasil dihapus.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menghapus tugas.');
  }
  
  res.redirect('/admin/assignments');
});

// POST Bulk Delete Assignments
router.post('/assignments/bulk-delete', async (req, res) => {
  const ids = req.body['ids[]'] || [];
  const idsArray = Array.isArray(ids) ? ids : [ids];
  
  if (idsArray.length === 0) {
    req.flash('error', 'Tidak ada tugas yang dipilih.');
    return res.redirect('/admin/assignments');
  }
  
  try {
    const placeholders = idsArray.map((_, i) => `:id${i}`).join(',');
    const params = {};
    idsArray.forEach((id, i) => {
      params[`id${i}`] = id;
    });
    
    await pool.query(`DELETE FROM assignments WHERE id IN (${placeholders});`, params);
    req.flash('success', `${idsArray.length} tugas berhasil dihapus.`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menghapus tugas.');
  }
  
  res.redirect('/admin/assignments');
});

// ===== QUESTION BANK MANAGEMENT =====

// GET Admin Question Bank List
router.get('/question-bank', async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const subject_id = req.query.subject_id || '';
    const difficulty = req.query.difficulty || '';

    // Get subjects for filter
    const [subjects] = await pool.query(`SELECT id, name FROM subjects ORDER BY name ASC;`);

    // Build WHERE clause
    let whereConditions = ['1=1'];
    let queryParams = {};

    if (search) {
      whereConditions.push(`(qb.question_text LIKE :search OR u.full_name LIKE :search)`);
      queryParams.search = `%${search}%`;
    }

    if (subject_id) {
      whereConditions.push(`qb.subject_id = :subject_id`);
      queryParams.subject_id = subject_id;
    }

    if (difficulty) {
      whereConditions.push(`qb.difficulty = :difficulty`);
      queryParams.difficulty = difficulty;
    }

    const whereClause = whereConditions.join(' AND ');

    // Get questions
    const [questions] = await pool.query(
      `SELECT 
        qb.*,
        u.full_name as teacher_name,
        s.name as subject_name
      FROM question_bank qb
      JOIN users u ON qb.teacher_id = u.id
      JOIN subjects s ON qb.subject_id = s.id
      WHERE ${whereClause}
      ORDER BY qb.created_at DESC;`,
      queryParams
    );

    // Get stats
    const [[statsRow]] = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN difficulty = 'EASY' THEN 1 ELSE 0 END) as easy,
        SUM(CASE WHEN difficulty = 'MEDIUM' THEN 1 ELSE 0 END) as medium,
        SUM(CASE WHEN difficulty = 'HARD' THEN 1 ELSE 0 END) as hard
      FROM question_bank;
    `);

    const stats = {
      total: statsRow.total || 0,
      easy: statsRow.easy || 0,
      medium: statsRow.medium || 0,
      hard: statsRow.hard || 0
    };

    res.render('admin/question_bank', {
      title: 'Manajemen Bank Soal',
      questions,
      subjects,
      stats,
      search,
      subject_id,
      difficulty
    });
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal memuat data bank soal.');
    res.redirect('/admin');
  }
});

// POST Delete Question Bank
router.post('/question-bank/:id/delete', async (req, res) => {
  const questionId = req.params.id;
  
  try {
    await pool.query(`DELETE FROM question_bank WHERE id = :id;`, { id: questionId });
    req.flash('success', 'Soal berhasil dihapus.');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menghapus soal.');
  }
  
  res.redirect('/admin/question-bank');
});

// POST Bulk Delete Question Bank
router.post('/question-bank/bulk-delete', async (req, res) => {
  const ids = req.body['ids[]'] || [];
  const idsArray = Array.isArray(ids) ? ids : [ids];
  
  if (idsArray.length === 0) {
    req.flash('error', 'Tidak ada soal yang dipilih.');
    return res.redirect('/admin/question-bank');
  }
  
  try {
    const placeholders = idsArray.map((_, i) => `:id${i}`).join(',');
    const params = {};
    idsArray.forEach((id, i) => {
      params[`id${i}`] = id;
    });
    
    await pool.query(`DELETE FROM question_bank WHERE id IN (${placeholders});`, params);
    req.flash('success', `${idsArray.length} soal berhasil dihapus.`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal menghapus soal.');
  }
  
  res.redirect('/admin/question-bank');
});
