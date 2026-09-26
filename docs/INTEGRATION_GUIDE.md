# Panduan Integrasi E-Commerce & Skalabilitas Transaksi KaiGoBiz

Dokumen ini berisi panduan teknis lengkap untuk mengintegrasikan sistem KaiGoBiz Payment Gateway ke platform e-commerce Anda, mulai dari konfigurasi dasar, implementasi kode unik, verifikasi webhook, hingga strategi arsitektur untuk menangani ratusan ribu transaksi.

---

## 1. Arsitektur & Pembagian Peran

Pemisahan tugas antara KaiGoBiz dan E-Commerce mengikuti standar industri payment gateway:

| Komponen | Peran Utama | Tanggung Jawab |
|---|---|---|
| **E-Commerce** | Toko Online & Keranjang Belanja | Mengelola katalog produk, stok, keranjang belanja, voucher diskon, dan menerbitkan Order ID / Invoice. Mengirim instruksi tagihan ke KaiGoBiz saat pembeli checkout. |
| **KaiGoBiz** | Mesin Payment Gateway | Mengelola koneksi GoBiz, menghitung dan menerbitkan QRIS dinamis (EMVCo), mendeteksi mutasi uang masuk via background reconciler, dan menembakkan Webhook saat pembayaran sukses. |

---

## 2. Persiapan & Konfigurasi Awal di KaiGoBiz

Cukup disetel 1 kali melalui Dashboard Admin KaiGoBiz (`http://localhost:3636`):

1. **Template QRIS Statis Toko:**
   Masukkan string payload QRIS statis asli dari GoBiz Anda (diawali `000201...`) atau unggah gambar/PDF QRIS toko.
2. **Koneksi Akun GoBiz:**
   Masukkan nomor handphone GoBiz Anda dan verifikasi kode OTP yang masuk via SMS/WhatsApp.
3. **Webhook Secret (Opsional namun Sangat Direkomendasikan):**
   Setel nilai rahasia di `.kaigobiz-config.json` atau environment variable `WEBHOOK_SECRET` untuk menandatangani data webhook menggunakan HMAC-SHA256.

---

## 3. Spesifikasi API: Pembuatan Pembayaran

Saat pembeli menekan tombol **"Bayar Sekarang"** di website e-commerce Anda, backend e-commerce mengirimkan request HTTP POST ke KaiGoBiz.

* **Endpoint:** `POST /api/v1/payment/create`
* **Content-Type:** `application/json`

### Request Body Schema

```json
{
  "orderId": "INV-20260926-001",
  "amount": 50000,
  "expiryMinutes": 3,
  "useUniqueCode": true,
  "uniqueCodeMin": 1,
  "uniqueCodeMax": 249,
  "uniqueCodeType": "ADD",
  "callbackUrl": "https://tokoanda.com/api/webhook/kaigobiz"
}
```

### Penjelasan Parameter

| Field | Tipe | Wajib? | Deskripsi & Rekomendasi |
|---|---|---|---|
| `orderId` | String | Ya | ID unik pesanan dari e-commerce (1 s/d 100 karakter). Idempoten: request ulang dengan `orderId` dan `amount` yang sama dalam status PENDING akan mengembalikan data pembayaran yang sama. |
| `amount` | Number | Ya | Nilai dasar pesanan dalam Rupiah (Rp 1 s/d Rp 100.000.000). |
| `expiryMinutes` | Number | Tidak | Batas waktu pembayaran (1 s/d 1440 menit). Standar checkout normal: **3 - 5 menit**. Saat event flash sale: **2 menit**. |
| `useUniqueCode` | Boolean | Tidak | Aktifkan pengacakan nominal otomatis agar mutasi QRIS dapat dicocokkan otomatis 100% tanpa salah akun. |
| `uniqueCodeMin` | Number | Tidak | Nilai batas bawah kode unik (default: 1). |
| `uniqueCodeMax` | Number | Tidak | Nilai batas atas kode unik (default: 250, maksimal 9999). Rekomendasi: **249** agar biaya tambahan bagi pembeli selalu di bawah Rp 250. |
| `uniqueCodeType` | String | Tidak | `ADD` (menambahkan kode unik ke harga barang) atau `SUBTRACT` (mengurangkan kode unik dari harga barang sebagai diskon otomatis). |
| `callbackUrl` | String | Tidak | URL webhook backend e-commerce Anda yang akan ditembak saat pembayaran berhasil. Dilindungi proteksi anti-SSRF. |

### Contoh Response Sukses (HTTP 200)

```json
{
  "success": true,
  "paymentId": "pay_1774693198_x7k9p",
  "orderId": "INV-20260926-001",
  "amount": 50142,
  "rawAmount": 50000,
  "uniqueCode": 142,
  "qrisString": "00020101021226670016ID.CO.GOJEK.WWW01189360091437946879480215G794687948834950303UME51440014ID.CO.QRIS.WWW0215ID10265577472700303UME520458125303360540850142.005802ID5917ARQSTORE, Gaming6007CILACAP61055323262070703A016304E8A1",
  "qrisQrUrl": "data:image/png;base64,iVBORw0KGgo...",
  "checkoutUrl": "http://localhost:3636/pay/pay_1774693198_x7k9p",
  "expiresAt": "2026-09-26T10:25:00.000Z",
  "callbackUrl": "https://tokoanda.com/api/webhook/kaigobiz"
}
```

---

## 4. Tiga Cara Menampilkan Pembayaran di Frontend

### Opsi A: Embed Modal Widget (Mirip Midtrans Snap)
Paling direkomendasikan karena pembeli tidak meninggalkan halaman toko online Anda:

1. Pasang tag script di halaman checkout website e-commerce Anda:
   ```html
   <script src="http://your-kaigobiz-domain:3636/kaigobiz.js"></script>
   ```
2. Panggil fungsi `KaiGoBiz.pay` saat tombol bayar diklik:
   ```javascript
   KaiGoBiz.pay({
     paymentId: responseFromBackend.paymentId,
     onSuccess: function(result) {
       alert("Pembayaran berhasil!");
       window.location.href = "/order/success/" + result.orderId;
     },
     onPending: function(result) {
       console.log("Menunggu transfer...", result);
     },
     onClose: function() {
       console.log("Modal pembayaran ditutup pelanggan.");
     }
   });
   ```

### Opsi B: Redirect Invoice Page (Mirip Xendit Invoice)
Arahkan pembeli langsung ke tautan `checkoutUrl`:
```javascript
window.location.href = responseFromBackend.checkoutUrl;
```
Halaman checkout bawaan KaiGoBiz sudah dilengkapi QRIS dinamis, waktu hitung mundur live, tombol salin nominal, dan auto-redirect saat lunas.

### Opsi C: Direct Headless UI
Jika e-commerce Anda ingin mendesain tampilan QR sendiri, gunakan langsung nilai `qrisQrUrl` (gambar format base64 PNG):
```html
<img src="{{ responseFromBackend.qrisQrUrl }}" alt="Scan QRIS untuk Bayar" />
<p>Total yang harus dibayar: <strong>Rp {{ responseFromBackend.amount }}</strong></p>
```

---

## 5. Menangani Webhook Notifikasi Pembayaran

Saat pelanggan berhasil scan dan membayar via m-banking/e-wallet, reconciler KaiGoBiz mendeteksi mutasi dan langsung mengirimkan HTTP POST ke `callbackUrl` Anda.

### Payload Webhook

```json
{
  "event": "payment.success",
  "paymentId": "pay_1774693198_x7k9p",
  "orderId": "INV-20260926-001",
  "amount": 50142,
  "status": "PAID",
  "paidAt": "2026-09-26T10:24:15.000Z",
  "transactionId": "10029384729",
  "timestamp": "2026-09-26T10:24:15.000Z"
}
```

### Verifikasi Tanda Tangan Kriptografi (HMAC-SHA256)

KaiGoBiz menyertakan header tanda tangan:
`X-KaiGoBiz-Signature: sha256=<hex_digest>`

#### Contoh Verifikasi di Node.js (Express)
```javascript
const crypto = require('crypto');

app.post('/api/webhook/kaigobiz', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-kaigobiz-signature'];
  const secret = process.env.WEBHOOK_SECRET;

  if (secret && signature) {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    if (signature !== expected) {
      return res.status(401).send('Invalid signature');
    }
  }

  const payload = JSON.parse(req.body.toString());
  if (payload.event === 'payment.success' && payload.status === 'PAID') {
    // 1. Cek apakah order sudah ditandai lunas sebelumnya (idempotency check)
    // 2. Ubah status pesanan menjadi Lunas di database e-commerce
    // 3. Kurangi stok barang dan kirim email konfirmasi ke pembeli
  }

  res.status(200).json({ received: true });
});
```

#### Contoh Verifikasi di PHP
```php
<?php
$rawPayload = file_get_contents('php://input');
$signature = $_SERVER['HTTP_X_KAIGOBIZ_SIGNATURE'] ?? '';
$secret = getenv('WEBHOOK_SECRET');

if ($secret && $signature) {
    $expected = 'sha256=' . hash_hmac('sha256', $rawPayload, $secret);
    if (!hash_equals($signature, $expected)) {
        http_response_code(401);
        exit('Invalid signature');
    }
}

$data = json_decode($rawPayload, true);
if ($data['event'] === 'payment.success' && $data['status'] === 'PAID') {
    $orderId = $data['orderId'];
    // Update status pesanan di database e-commerce Anda
}

http_response_code(200);
echo json_encode(['received' => true]);
```

---

## 6. Arsitektur Skalabilitas Tinggi: Menangani Ratusan Ribu Transaksi

Banyak merchant khawatir: *Jika kode unik dibatasi di bawah Rp 250 agar tidak mahal, bagaimana cara melayani ratusan ribu transaksi saat Flash Sale tanpa bentrok?*

Berikut adalah 4 pilar arsitektur yang menjamin sistem tetap aman dan bebas bentrok:

### A. High-Velocity Slot Recycling (Siklus Cepat 90 - 120 Detik)
Slot kode unik tidak dihitung berdasarkan total transaksi harian, melainkan **transaksi aktif yang belum dibayar dalam satu waktu**.
* Pembeli saat flash sale melakukan scan QRIS dalam hitungan 15 sampai 30 detik.
* Begitu pembayaran terdeteksi, order berstatus `PAID` dan angka unik langsung dilepas kembali (*instant release*) ke kolam antrean.
* **Kalkulasi:**
  * 200 kode unik (Rp 1 s/d Rp 200).
  * Dengan durasi tunggu 90 detik dan rata-rata pembayaran selesai dalam 30 detik, 1 slot angka berputar 2 kali per menit.
  * $200 \times 2 = 400$ transaksi/menit = **24.000 transaksi sukses per jam**.
  * Dalam 1 hari, 200 kode unik mampu menampung lebih dari **100.000 transaksi** tanpa menaikkan fee bagi pembeli.

### B. Proteksi Database Level dengan SQLite Partial Unique Index
KaiGoBiz menggunakan indeks parsial unik di level database SQLite:
```sql
CREATE UNIQUE INDEX idx_pending_order_amount 
  ON payment_orders(amount) 
  WHERE status = 'PENDING' AND unique_code IS NOT NULL;
```
* Dua order `PENDING` dengan nominal rupiah yang persis sama **mustahil terjadi**.
* Jika dua pembeli checkout pada milidetik yang sama, SQLite menolak order kedua dengan `UNIQUE constraint failed`.
* Mesin KaiGoBiz otomatis menangkap error tersebut, mengundi kode unik berikutnya secara instan, dan menyimpannya tanpa disadari oleh pembeli (*zero race condition*).

### C. Antrean Checkout E-Commerce (Virtual Waiting Room)
Jika 50.000 orang menekan tombol checkout pada detik ke-0 flash sale:
* E-commerce menerapkan antrean checkout bertahap (*batched checkout*), misalnya 250 orang per gelombang 90 detik.
* Langkah ini melindungi inventaris dari *overselling*, menjaga server tetap responsif, dan memastikan setiap pembeli mendapat QRIS yang valid.

### D. Multi-Terminal / Multi-QRIS GoBiz
Jika volume transaksi Anda membutuhkan ratusan pembayaran per detik bersamaan:
* Daftarkan 2 sampai 4 terminal kasir di aplikasi GoBiz toko Anda.
* Setiap kasir memiliki QRIS statis tersendiri dengan rekening bank penampung yang sama.
* Hubungkan template QRIS tambahan tersebut ke sistem KaiGoBiz. Kapasitas konkurensi Anda langsung berlipat ganda secara paralel tanpa membebani satu QRIS tunggal.

---

## 7. Pemeliharaan & Operasional Database SQLite

KaiGoBiz menggunakan modul bawaan Node.js 26 (`node:sqlite`) dengan mode *Write-Ahead Logging* (WAL) dan sinkronisasi `NORMAL`:

* **Lokasi File Database:** `.kaigobiz.db` di direktori aplikasi.
* **Performa:** Mampu melayani 2.000 s/d 5.000 penulisan per detik tanpa memblokir pembaca mutasi.
* **Hot Backup Tanpa Downtime:**
  Untuk membuat salinan cadangan (*backup*) tanpa menghentikan server yang sedang melayani transaksi, jalankan perintah SQLite native:
  ```javascript
  const storage = getStorage();
  await storage.backup('/backup/kaigobiz-backup-' + Date.now() + '.db');
  ```
  Atau gunakan checkpoint sebelum menyalin file:
  ```bash
  # Checkpoint WAL ke file database utama
  node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('.kaigobiz.db'); db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); db.close();"
  cp .kaigobiz.db /backup/kaigobiz-backup.db
  ```
