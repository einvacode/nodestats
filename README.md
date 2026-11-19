# NodeStats – Dashboard Monitoring MikroTik (ROS 7)

Dashboard web untuk memonitor satu atau banyak MikroTik (RouterOS 7.x) tanpa membuka Winbox.
Dibuat untuk ISP/RT-RW Net dengan ribuan pelanggan PPPoE. Node.js tanpa dependency npm, Tailwind CSS, Chart.js, database SQLite.

## Fitur
- **Multi router**: tambah banyak MikroTik, pilih dari dropdown; data, grafik, dan riwayat terpisah per router.
- **PPPoE**: jumlah online / offline / rasio / per profile; tabel pelanggan dengan pencarian, filter, dan paging (aman untuk ribuan user).
- **Interface & VLAN**: status link, traffic Rx/Tx, error, drop.
- **Grafik**: traffic total, PPPoE online/offline, CPU, traffic per interface. Rentang Live, 6 jam, 24 jam, 7 hari, 30 hari, atau pilih tanggal.
- **Riwayat konek/putus** per user (jumlah putus, jam putus, konek kembali, lama putus). Klik username untuk detail log lengkap.
- **Router**: CPU, RAM, suhu, uptime, versi.
- **Responsif** di HP, tampilan tab, pengaturan tampilan terakhir diingat.
- **Pengaturan Perusahaan & Logo**: ubah nama perusahaan/ISP, tagline, alamat, kontak NOC, catatan footer, serta upload logo (otomatis menjadi logo header & favicon browser, tersimpan aman di database).
- **Update dari GitHub** lewat satu klik di dashboard.

Backend mem-poll REST API RouterOS di latar belakang lalu menyimpan cache, jadi membuka dashboard tidak menambah beban router.

---

## 1. Persiapan di MikroTik (tiap router)
Buat user khusus read-only dan aktifkan REST API (`www-ssl`):
```
/user group add name=monitor policy=read,api,rest-api,!local,!telnet,!ssh,!ftp,!reboot,!write,!policy,!test,!winbox,!password,!web,!sniff,!sensitive,!romon
/user add name=monitor group=monitor password=GANTI_PASSWORD address=IP_SERVER_NODESTATS/32
/ip service set www-ssl disabled=no
```
- Jika belum punya sertifikat untuk `www-ssl`, buat sertifikat self-signed (aplikasi menerima self-signed secara default), atau pakai `www` (http) di jaringan yang tepercaya.
- Batasi `/ip service` agar hanya bisa diakses dari IP server NodeStats.

## 2. Pasang di Proxmox (LXC/VM Debian 12 atau Ubuntu 22.04+, tanpa Docker)
Buat LXC/VM baru (cukup 1 vCPU, 512 MB RAM), masuk sebagai root, lalu:
```bash
apt update && apt install -y git
git clone https://github.com/einvacode/nodestats.git /opt/nodestats
bash /opt/nodestats/install.sh
```
Skrip akan:
1. memasang Apache, Git, dan Node.js 22;
2. membuat user layanan `nodestats` dan service systemd (otomatis jalan saat boot, restart bila crash);
3. membuat `.env` (menanyakan username/password login dashboard; password acak dibuatkan bila dikosongkan);
4. mengatur Apache sebagai reverse proxy ke aplikasi (menanyakan domain, boleh dikosongkan bila akses lewat IP);
5. menampilkan alamat dan login di akhir.

Aman dijalankan ulang kapan saja (tidak menimpa `.env`, database, atau konfigurasi Apache).

**Repo private**: clone dengan token fine-grained (izin *Contents: read-only*):
`git clone https://TOKEN@github.com/einvacode/nodestats.git /opt/nodestats`

**HTTPS** (disarankan jika diakses dari internet): `apt install certbot python3-certbot-apache && certbot --apache -d domain.anda`

Setelah terpasang: buka dashboard, klik ikon **gear** di header, **Tambah Router**, isi IP/port/user/password, klik **Tes koneksi**, lalu **Simpan**.

## 3. Update dari GitHub
1. Ubah kode di PC, lalu `git push`.
2. Di dashboard klik ikon **panah atas** (titik kuning muncul jika ada update) → **Cek update** → **Update sekarang**.
3. Aplikasi menjalankan `git pull --ff-only` lalu restart sendiri; halaman reload otomatis.

Syarat: dipasang dengan `git clone` (lewat `install.sh`), `DASH_USER`/`DASH_PASS` terisi, dan `.env` serta `data/` tidak masuk repo (sudah ada di `.gitignore`). Pengecekan otomatis tiap 6 jam (`UPDATE_CHECK_HOURS`). Bila update gagal karena ada perubahan manual di server, lihat pesannya di jendela update atau jalankan `git -C /opt/nodestats status`.

## 4. Jalankan di Windows (untuk uji coba / lokal)
Install Node.js 22.13 atau lebih baru, lalu klik dua kali `start.bat` (membuat `.env` dari contoh, menjalankan server, dan restart otomatis jika berhenti). Buka `http://localhost:3000`. Isi `DEMO=1` di `.env` untuk mencoba dengan data palsu tanpa router.

## Pengaturan (`.env`)
| Variabel | Default | Keterangan |
| --- | --- | --- |
| `DASH_USER` / `DASH_PASS` | kosong | Login dashboard (basic auth). **Wajib di server**; tanpa ini tombol Update dimatikan |
| `PORT` | 3000 | Port aplikasi |
| `HOST` | 0.0.0.0 | Alamat bind (service systemd memakai 127.0.0.1 di belakang Apache) |
| `POLL_SECONDS` | 10 | Interval polling interface dan PPPoE aktif |
| `SECRET_POLL_SECONDS` | 300 | Interval polling daftar `/ppp/secret` |
| `SAMPLE_SECONDS` | 60 | Interval simpan data ke database |
| `RETENTION_DAYS` | 90 | Lama data riwayat disimpan |
| `DATA_DIR` | `./data` | Lokasi database (`/var/lib/nodestats` di server) |
| `UPDATE_CHECK_HOURS` | 6 | Cek update otomatis (0 = mati) |
| `ROS_*` | – | Opsional, hanya untuk router pertama saat database masih kosong |
| `DEMO` | 0 | `1` = tambah router demo bila belum ada router |

## Data & keamanan
- Database SQLite ada di `/var/lib/nodestats/nodestats.db` (Windows: `data/`). **Backup**: salin file itu.
- Password router disimpan di database tersebut. Jangan commit `data/` dan `.env` ke git, batasi akses ke server, dan selalu isi `DASH_USER`/`DASH_PASS`.
- Gunakan user MikroTik read-only dan batasi dengan `address=` seperti di atas.
- Offline = secret PPPoE yang aktif (tidak disabled) tetapi tidak ada di `/ppp/active`. Riwayat konek/putus tercatat sejak aplikasi mulai memantau router tersebut.

## Perintah berguna di server
```bash
journalctl -u nodestats -f        # log aplikasi
systemctl restart nodestats       # restart
nano /opt/nodestats/.env          # ubah pengaturan, lalu restart
```

## Masalah umum
| Gejala | Penyebab / solusi |
| --- | --- |
| Status router "gagal" / `ECONNREFUSED` | `www-ssl` belum aktif, port salah, atau firewall MikroTik memblokir IP server |
| `401` dari router | User/password MikroTik salah, atau `address=` user tidak mencakup IP server |
| `self-signed certificate` | Centang "Terima sertifikat self-signed" pada form router |
| Grafik/tampilan kosong, tidak ada styling | Browser butuh internet untuk memuat Tailwind dan Chart.js dari CDN |
| Tombol Update abu-abu | `DASH_USER` kosong, atau folder bukan hasil `git clone` |

## Struktur
```
install.sh          installer Proxmox/Debian/Ubuntu
start.bat           menjalankan di Windows
server.js           backend, polling router, API
db.js               SQLite (router, riwayat, event)
update.js           update dari git
public/index.html   dashboard (Tailwind + Chart.js)
deploy/             template systemd dan Apache
```
