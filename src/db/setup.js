require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function main() {
  const host = process.env.DB_HOST;
  const port = Number(process.env.DB_PORT || 3306);
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;

  // NOTE:
  // We use positional placeholders (?) for broad MySQL/MariaDB compatibility.
  // Named placeholders like :ph require extra mysql2 config (namedPlaceholders: true)
  // and otherwise will be sent to the server and cause ER_PARSE_ERROR.
  const conn = await mysql.createConnection({ host, port, user, password, multipleStatements: true });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
  );
  await conn.query(`USE \`${database}\`;`);

  const schemaPath = path.join(__dirname, '..', '..', 'sql', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await conn.query(schemaSql);

  // Lightweight migration for existing DB (CREATE TABLE IF NOT EXISTS won't alter existing tables)
  try {
    await conn.query(
      "ALTER TABLE users MODIFY COLUMN role ENUM('ADMIN','TEACHER','STUDENT','PRINCIPAL') NOT NULL DEFAULT 'STUDENT';"
    );
  } catch (e) {
    // ignore if no privilege / already ok
  }


  // Migrate materials embed columns (for older DB)
  try {
    await conn.query("ALTER TABLE materials ADD COLUMN embed_type ENUM('YOUTUBE','PDF') NULL;");
  } catch (e) {}
  try {
    await conn.query("ALTER TABLE materials ADD COLUMN embed_url VARCHAR(500) NULL;");
  } catch (e) {}

  // Migrate exam_classes table for multiple classes per exam
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS exam_classes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        exam_id INT NOT NULL,
        class_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_exam_class (exam_id, class_id),
        INDEX idx_exam (exam_id),
        INDEX idx_class (class_id),
        CONSTRAINT fk_exam_classes_exam FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT fk_exam_classes_class FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB;
    `);
    console.log('✓ Table exam_classes created/verified');
  } catch (e) {
    console.log('Note: exam_classes table already exists or error:', e.message);
  }

  // Migrate existing exam.class_id data to exam_classes
  try {
    await conn.query(`
      INSERT IGNORE INTO exam_classes (exam_id, class_id)
      SELECT id, class_id 
      FROM exams 
      WHERE class_id IS NOT NULL;
    `);
    console.log('✓ Migrated existing exam class data');
  } catch (e) {
    console.log('Note: exam class migration skipped or error:', e.message);
  }

  // Basic seed data
  await conn.query(
    `INSERT INTO classes (code, name) VALUES ('X-RPL-1','X RPL 1')
     ON DUPLICATE KEY UPDATE name = VALUES(name);`
  );
  await conn.query(
    `INSERT INTO subjects (code, name) VALUES ('MAT','Matematika'),('BIN','Bahasa Indonesia')
     ON DUPLICATE KEY UPDATE name = VALUES(name);`
  );

  // Default users
  const adminPass = await bcrypt.hash('admin123', 10);
  const teacherPass = await bcrypt.hash('guru123', 10);
  const studentPass = await bcrypt.hash('siswa123', 10);
  const principalPass = await bcrypt.hash('kepsek123', 10);

  await conn.query(
    `INSERT INTO users (username, full_name, role, password_hash)
     VALUES ('admin','Administrator','ADMIN',?)
     ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), role=VALUES(role), password_hash=?;`,
    [adminPass, adminPass]
  );

  await conn.query(
    `INSERT INTO users (username, full_name, role, password_hash)
     VALUES ('guru','Guru SMK','TEACHER',?)
     ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), role=VALUES(role), password_hash=?;`,
    [teacherPass, teacherPass]
  );

  await conn.query(
    `INSERT INTO users (username, full_name, role, password_hash)
     VALUES ('kepsek','Kepala Sekolah','PRINCIPAL',?)
     ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), role=VALUES(role), password_hash=?;`,
    [principalPass, principalPass]
  );

  const [[cls]] = await conn.query(`SELECT id FROM classes WHERE code='X-RPL-1' LIMIT 1;`);
  const classId = cls?.id || null;

  await conn.query(
    `INSERT INTO users (username, full_name, role, class_id, password_hash)
     VALUES ('siswa','Siswa Contoh','STUDENT',?,?)
     ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), role=VALUES(role), class_id=VALUES(class_id), password_hash=?;`,
    [classId, studentPass, studentPass]
  );

  console.log('OK: Database & schema siap. Akun default: admin/admin123, guru/guru123, siswa/siswa123, kepsek/kepsek123');
  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
