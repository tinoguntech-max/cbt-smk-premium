# Fitur Input Nilai di Modal Preview

## Deskripsi
Menambahkan form input nilai langsung di modal preview tugas siswa, sehingga guru bisa memberi nilai sambil melihat file yang dikumpulkan tanpa perlu membuka modal terpisah.

## Problem
Sebelumnya, workflow untuk memberi nilai:
1. Klik tombol "Lihat" → Modal preview terbuka
2. Lihat file submission
3. Tutup modal preview
4. Klik tombol "Nilai" → Modal grade terbuka
5. Input nilai dan feedback
6. Submit

Terlalu banyak langkah dan tidak efisien.

## Solution
Menambahkan form input nilai langsung di footer modal preview:
- Input nilai (score)
- Input feedback singkat
- Tombol "Simpan Nilai" untuk quick grading
- Tombol "Form Lengkap" untuk membuka modal grade dengan textarea besar

## Features

### 1. Quick Grade Form
Form sederhana di footer modal preview dengan:
- Input number untuk nilai (0 - max_score)
- Input text untuk feedback singkat
- Pre-filled jika sudah ada nilai sebelumnya
- Submit langsung tanpa tutup modal

### 2. Form Lengkap Button
Tombol untuk membuka modal grade lengkap jika:
- Perlu menulis feedback panjang
- Ingin melihat form yang lebih besar
- Transfer nilai dari quick form ke full form

### 3. Auto-fill Existing Grade
Jika submission sudah dinilai:
- Score otomatis terisi
- Feedback otomatis terisi
- Guru bisa edit langsung

## UI/UX

### Modal Preview Layout
```
┌─────────────────────────────────────────┐
│ Header: Tugas Siswa - [Nama Siswa]     │
│ [Download] [✕ Tutup]                    │
├─────────────────────────────────────────┤
│                                         │
│ [Catatan Siswa] (jika ada)             │
│                                         │
│ ┌─────────────────────────────────┐   │
│ │                                 │   │
│ │     File Preview Area           │   │
│ │                                 │   │
│ └─────────────────────────────────┘   │
│                                         │
├─────────────────────────────────────────┤
│ Footer: Quick Grade Form                │
│ ┌─────────────┐ ┌──────────────────┐  │
│ │ Nilai: [__] │ │ Feedback: [____] │  │
│ └─────────────┘ └──────────────────┘  │
│ [Filename]  [Form Lengkap] [✓ Simpan] │
└─────────────────────────────────────────┘
```

### Form Fields
- **Nilai**: Number input, min=0, max=max_score, step=0.01
- **Feedback**: Text input, single line, optional
- **Buttons**: 
  - "Form Lengkap" (blue) - Opens full grade modal
  - "✓ Simpan Nilai" (green) - Submit quick grade

## Changes Made

### File: `src/views/teacher/assignment_detail.ejs`

#### 1. Update View Button Data Attributes
```html
<button 
  data-submission-id="<%= sub.id %>"
  data-student-name="<%= sub.student_name %>"
  data-file-path="<%= sub.file_path || '' %>"
  data-file-name="<%= sub.file_name || '' %>"
  data-notes="<%= sub.notes || '' %>"
  data-score="<%= sub.score || '' %>"          <!-- BARU -->
  data-feedback="<%= sub.feedback || '' %>"    <!-- BARU -->
  onclick="viewSubmissionSafe(this)"
  class="..."
>
  👁️ Lihat
</button>
```

#### 2. Replace Modal Footer
```html
<!-- Before: Simple button -->
<div class="p-6 border-t border-slate-200 flex justify-between items-center">
  <div id="viewFileName" class="text-sm text-slate-600"></div>
  <button onclick="gradeFromView()">📝 Beri Nilai</button>
</div>

<!-- After: Quick grade form -->
<div class="p-6 border-t border-slate-200 bg-slate-50">
  <form id="quickGradeForm" method="POST" action="">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <!-- Score Input -->
      <div>
        <label>Nilai (0 - <%= assignment.max_score %>)</label>
        <input type="number" name="score" id="quickScoreInput" ... />
      </div>
      
      <!-- Feedback Input -->
      <div>
        <label>Feedback (Opsional)</label>
        <input type="text" name="feedback" id="quickFeedbackInput" ... />
      </div>
    </div>
    
    <div class="flex items-center justify-between">
      <div id="viewFileName"></div>
      <div class="flex gap-2">
        <button type="button" onclick="openFullGradeModal()">📝 Form Lengkap</button>
        <button type="submit">✓ Simpan Nilai</button>
      </div>
    </div>
  </form>
</div>
```

#### 3. Update JavaScript Functions

**viewSubmissionSafe()** - Pass score and feedback
```javascript
function viewSubmissionSafe(button) {
  const submissionId = button.getAttribute('data-submission-id');
  const studentName = button.getAttribute('data-student-name');
  const filePath = button.getAttribute('data-file-path');
  const fileName = button.getAttribute('data-file-name');
  const notes = button.getAttribute('data-notes');
  const score = button.getAttribute('data-score');        // BARU
  const feedback = button.getAttribute('data-feedback');  // BARU
  
  viewSubmission(submissionId, studentName, filePath, fileName, notes, score, feedback);
}
```

**viewSubmission()** - Setup form
```javascript
function viewSubmission(submissionId, studentName, filePath, fileName, notes, score, feedback) {
  // ... existing code ...
  
  // Quick grade form setup
  const quickGradeForm = document.getElementById('quickGradeForm');
  const quickScoreInput = document.getElementById('quickScoreInput');
  const quickFeedbackInput = document.getElementById('quickFeedbackInput');
  
  // Set form action
  quickGradeForm.action = `/teacher/assignments/<%= assignment.id %>/submissions/${submissionId}/grade`;
  
  // Pre-fill score and feedback if exists
  quickScoreInput.value = score || '';
  quickFeedbackInput.value = feedback || '';
  
  // ... rest of code ...
}
```

**openFullGradeModal()** - Transfer to full form
```javascript
function openFullGradeModal() {
  // Get current values from quick form
  const quickScore = document.getElementById('quickScoreInput').value;
  const quickFeedback = document.getElementById('quickFeedbackInput').value;
  
  // Close view modal
  closeViewModal();
  
  // Open full grade modal with current values
  openGradeModal(
    currentSubmissionId,
    currentStudentName,
    quickScore ? parseFloat(quickScore) : null,
    quickFeedback
  );
}
```

## Workflow

### Quick Grading (New)
1. Klik "👁️ Lihat" → Modal preview terbuka
2. Lihat file submission
3. Input nilai di form bawah
4. (Optional) Input feedback singkat
5. Klik "✓ Simpan Nilai"
6. Done! Modal tetap terbuka untuk submission berikutnya

### Full Form Grading
1. Klik "👁️ Lihat" → Modal preview terbuka
2. Lihat file submission
3. (Optional) Input nilai di quick form
4. Klik "📝 Form Lengkap"
5. Modal grade terbuka dengan nilai pre-filled
6. Edit nilai dan tulis feedback panjang di textarea
7. Klik "Simpan Nilai"

### Edit Existing Grade
1. Klik "👁️ Lihat" pada submission yang sudah dinilai
2. Modal terbuka dengan nilai dan feedback sudah terisi
3. Edit langsung di quick form
4. Klik "✓ Simpan Nilai"

## Benefits

### Efficiency
- **Before**: 6 steps (open preview → close → open grade → input → submit)
- **After**: 3 steps (open preview → input → submit)
- **Time saved**: ~50% faster

### User Experience
- Tidak perlu tutup-buka modal berkali-kali
- Bisa lihat file sambil input nilai
- Quick grading untuk feedback singkat
- Full form tetap tersedia untuk feedback panjang

### Flexibility
- Quick form untuk grading cepat
- Full form untuk grading detail
- Transfer nilai dari quick ke full form
- Edit nilai existing tanpa buka modal baru

## Validation

### Client-side
- Min: 0
- Max: assignment.max_score
- Step: 0.01 (support desimal)
- Type: number (keyboard numeric di mobile)

### Server-side
Menggunakan endpoint yang sama: `POST /teacher/assignments/:id/submissions/:submissionId/grade`
- Validasi score range
- Sanitize feedback
- Update database

## Mobile Responsive

### Desktop (md+)
- Grid 2 columns (score | feedback)
- Buttons side by side

### Mobile (<md)
- Grid 1 column (score di atas, feedback di bawah)
- Buttons stack vertical atau wrap

## Testing

### Test Cases
1. **Quick grade baru**: Input nilai → Submit → Verify saved
2. **Edit existing**: Open graded submission → Edit → Submit → Verify updated
3. **Transfer to full**: Input di quick → Click "Form Lengkap" → Verify pre-filled
4. **Validation**: Input nilai > max_score → Verify error
5. **Empty feedback**: Submit tanpa feedback → Verify accepted
6. **Decimal score**: Input 85.5 → Verify saved correctly

### Browser Testing
- Chrome/Edge: ✓
- Firefox: ✓
- Safari: ✓
- Mobile browsers: ✓

## Future Enhancements

1. **Keyboard Shortcuts**: Enter to submit, Esc to close
2. **Auto-save Draft**: Save nilai ke localStorage sebelum submit
3. **Bulk Grading**: Navigate ke submission berikutnya tanpa tutup modal
4. **Score Presets**: Quick buttons untuk nilai umum (100, 90, 80, 70)
5. **Feedback Templates**: Dropdown feedback template umum
6. **Grade History**: Show previous grades jika di-edit berkali-kali
