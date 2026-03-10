# Fitur Download Excel Bulk Users

## Deskripsi
Menambahkan tombol "Download Excel" di bulk action bar untuk mengunduh data pengguna yang terseleksi/tertandai dalam format Excel.

## Perubahan yang Dilakukan

### 1. Frontend - View (`src/views/admin/users.ejs`)

#### Tombol Download Excel di Bulk Action Bar
```html
<!-- Bulk Download Excel -->
<button type="button" onclick="downloadSelectedExcel()" class="px-4 py-2 rounded-xl bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-semibold transition-all duration-200 shadow-md hover:shadow-lg transform hover:scale-105 flex items-center gap-2">
  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
  Download Excel
</button>
```

#### Fungsi JavaScript
```javascript
// Download selected excel functionality
window.downloadSelectedExcel = function() {
  const selectedIds = Array.from(userCheckboxes)
    .filter(cb => cb.checked)
    .map(cb => cb.getAttribute('data-user-id'));
  
  if (selectedIds.length === 0) {
    alert('Pilih pengguna yang ingin didownload terlebih dahulu.');
    return;
  }
  
  // Download excel with selected IDs
  window.location.href = `/admin/users/download?ids=${selectedIds.join(',')}`;
};
```

### 2. Backend - Route (`src/routes/admin.js`)

#### Update Route Download Excel
```javascript
router.get('/users/download', async (req, res) => {
  try {
    // Support filter by IDs (bulk download)
    const { ids } = req.query;
    let query = `SELECT u.id, u.username, u.full_name, u.role, u.is_active, c.name AS class_name, u.created_at
       FROM users u
       LEFT JOIN classes c ON c.id=u.class_id`;
    
    const params = [];
    if (ids) {
      const idArray = ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
      if (idArray.length > 0) {
        query += ` WHERE u.id IN (${idArray.map(() => '?').join(',')})`;
        params.push(...idArray);
      }
    }
    
    query += ` ORDER BY u.id DESC`;
    
    const [users] = await pool.query(query, params);
    
    if (users.length === 0) {
      req.flash('error', 'Tidak ada data pengguna untuk diunduh.');
      return res.redirect('/admin/users');
    }
    
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
    const filename = ids ? `data_pengguna_terpilih_${Date.now()}.xlsx` : `data_pengguna_${Date.now()}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Gagal mengunduh data pengguna.');
    res.redirect('/admin/users');
  }
});
```

## Cara Menggunakan

### Download Semua Pengguna
1. Klik tombol "Download Excel" di header (warna hijau)
2. File Excel akan terunduh dengan nama `data_pengguna_[timestamp].xlsx`

### Download Pengguna Terpilih (Bulk)
1. Centang checkbox pengguna yang ingin didownload
2. Bulk action bar akan muncul
3. Klik tombol "Download Excel" di bulk action bar (warna hijau)
4. File Excel akan terunduh dengan nama `data_pengguna_terpilih_[timestamp].xlsx`

## Fitur

### Tombol di Header
- Download semua pengguna (tanpa filter)
- Warna: Green-Emerald gradient
- Icon: Download SVG

### Tombol di Bulk Action Bar
- Download hanya pengguna yang tercentang
- Muncul saat ada pengguna yang terseleksi
- Warna: Green-Emerald gradient (sama dengan header)
- Icon: Download SVG
- Validasi: Alert jika tidak ada pengguna yang dipilih

### Format Excel
Kolom yang diexport:
- ID
- Username
- Nama Lengkap
- Role
- Kelas
- Status (Aktif/Nonaktif)
- Dibuat (tanggal pembuatan)

### Keamanan
- Validasi IDs: Filter hanya angka valid
- Query parameterized untuk mencegah SQL injection
- Error handling dengan flash message

## Testing

### Test Download Semua
```bash
# Akses langsung
http://localhost:3000/admin/users/download
```

### Test Download Terpilih
```bash
# Dengan IDs tertentu
http://localhost:3000/admin/users/download?ids=1,2,3
```

### Test Validasi
```bash
# IDs kosong - akan download semua
http://localhost:3000/admin/users/download?ids=

# IDs invalid - akan difilter
http://localhost:3000/admin/users/download?ids=abc,1,xyz,2
```

## File yang Dimodifikasi
1. `src/views/admin/users.ejs` - Tambah tombol dan fungsi JS
2. `src/routes/admin.js` - Update route download dengan support IDs

## Catatan
- Tombol bulk download muncul bersamaan dengan tombol bulk action lainnya (Cetak Kartu, Hapus, Pindah Kelas)
- Filename berbeda untuk membedakan download semua vs terpilih
- Menggunakan library XLSX yang sudah ada di project
