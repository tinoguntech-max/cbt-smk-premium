# LMS SMKN 1 Kras (Node.js + MySQL + Tailwind)

Aplikasi ujian online sederhana namun lengkap untuk kebutuhan SMK:
- Role: **ADMIN**, **TEACHER (Guru)**, **STUDENT (Siswa)**
- Admin: kelola kelas, mapel, pengguna (reset password, aktif/nonaktif)
- Guru: buat ujian, atur jadwal/durasi, kode akses, publish/unpublish, tambah & hapus soal pilihan ganda (A–E)
- Guru: upload gambar pada soal (opsional)
- Guru: import soal dari Excel (.xlsx) / CSV + upload gambar multiple (opsional)
- Import Excel/CSV: **preview & validasi** sebelum disimpan + **laporan baris error** (CSV)
- Siswa: daftar ujian, verifikasi kode akses, kerjakan ujian dengan timer, autosave jawaban, submit, lihat hasil + review

## Teknologi
- Node.js (Express)
- MySQL
- EJS (templating)
- Tailwind CSS via CDN

## Cara Menjalankan
1) Clone / ekstrak project
2) Install dependency
```bash
npm install
```
3) Siapkan `.env`
```bash
cp .env.example .env
```
4) Buat database + schema + seed akun default
```bash
npm run db:setup
```

Jika Anda sudah pernah menjalankan versi lama, lakukan migrasi cepat:
```sql
ALTER TABLE questions ADD COLUMN question_image VARCHAR(255) NULL;
```
5) Jalankan
```bash
npm run dev
# atau
npm start
```
Buka: http://localhost:3000

## Akun Default
- Admin: `admin / admin123`
- Guru: `guru / guru123`
- Siswa: `siswa / siswa123`

> Untuk produksi, ganti password default, set `SESSION_SECRET` kuat, dan aktifkan HTTPS.

