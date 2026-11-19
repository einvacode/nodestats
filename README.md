# NodeStats – MikroTik ROS 7 Dashboard

Node.js (tanpa dependency) + Tailwind CSS + Chart.js. Backend mem-poll REST API RouterOS lalu cache,
jadi membuka dashboard tidak menambah beban router.

## Setup di MikroTik
```
/user group add name=monitor policy=read,api,rest-api,!local,!telnet,!ssh,!ftp,!reboot,!write,!policy,!test,!winbox,!password,!web,!sniff,!sensitive,!romon
/user add name=monitor group=monitor password=GANTI_PASSWORD address=IP_SERVER_MONITOR/32
/certificate  ;# atau pakai www-ssl bawaan
/ip service set www-ssl disabled=no
```
Batasi `/ip service` www-ssl hanya dari IP server monitor.

## Jalankan
```
copy .env.example .env   # isi ROS_HOST, ROS_USER, ROS_PASS
node server.js           # buka http://localhost:3000
```
Coba tanpa router: `DEMO=1` di `.env`.

## Fitur
- PPPoE online / offline / rasio / per-profile (offline = secret enabled yang tidak ada di active)
- Tabel pelanggan dengan search, filter, paging (server-side, aman untuk ribuan user)
- Traffic per interface & VLAN, status link, error/drop
- CPU, RAM, suhu, uptime; riwayat grafik 1 jam (in-memory)

Catatan: `/ppp/secret` di-refresh tiap 5 menit, `/ppp/active` & interface tiap 10 detik.
Tailwind memakai CDN; untuk produksi offline, build dengan Tailwind CLI.

## Database (riwayat hari sebelumnya)
SQLite bawaan Node (node:sqlite, perlu Node >= 22.13), file di folder data/ (atau DATA_DIR). Tiap menit disimpan rata-rata PPPoE online/offline, CPU, RAM, traffic total dan per interface, plus log konek/putus tiap user. Data disimpan RETENTION_DAYS hari (default 90). Di dashboard: tombol 6 jam / 24 jam / 7 hari / 30 hari, pilih tanggal, dan tabel riwayat PPPoE.

## Install di Proxmox (LXC/VM Debian atau Ubuntu, tanpa Docker)
1. Buat LXC/VM Debian 12 atau Ubuntu 22.04+, salin folder project ke dalam (scp / WinSCP).
2. Jalankan: bash deploy/install.sh (install Node 22, Apache, systemd service, reverse proxy).
3. Edit /opt/nodestats/.env dan /etc/apache2/sites-available/nodestats.conf, lalu: systemctl restart nodestats apache2
4. Log: journalctl -u nodestats -f. Backup: salin /var/lib/nodestats/nodestats.db.


## Multi router
Satu dashboard bisa memonitor banyak MikroTik. Pilih router lewat dropdown di header; tombol gear membuka Kelola Router (tambah, edit, tes koneksi, nonaktifkan, hapus). Router disimpan di database (tabel routers) beserta riwayatnya masing-masing. Saat pertama jalan, ROS_HOST dari .env otomatis menjadi router pertama; data lama dimigrasi ke router tersebut. Setelah itu kelola router dari UI saja (ROS_* di .env diabaikan). Perlu dicatat: password router disimpan di file database, jadi batasi akses ke folder data dan aktifkan DASH_USER/DASH_PASS.

