#!/usr/bin/env bash
# NodeStats installer - Debian 12 / Ubuntu 22.04+ (LXC atau VM di Proxmox). Tanpa Docker.
#
# Pemasangan (jalankan sebagai root):
#   apt update && apt install -y git
#   git clone https://github.com/einvacode/nodestats.git /opt/nodestats
#   bash /opt/nodestats/install.sh
#
# Atau satu baris (repo publik):
#   bash <(curl -fsSL https://raw.githubusercontent.com/einvacode/nodestats/main/install.sh)
#
# Repo private: gunakan REPO_URL dengan token fine-grained (izin Contents: read-only):
#   REPO_URL=https://TOKEN@github.com/einvacode/nodestats.git bash install.sh
#
# Variabel opsional: REPO_URL BRANCH APP_DIR DASH_USER DASH_PASS SERVER_NAME
# Aman dijalankan ulang (tidak menimpa .env, database, atau konfigurasi Apache yang sudah ada).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/einvacode/nodestats.git}"
BRANCH="${BRANCH:-main}"
APP="${APP_DIR:-/opt/nodestats}"
DATA=/var/lib/nodestats
SVC_USER=nodestats

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Jalankan sebagai root (sudo bash install.sh)"
command -v apt-get >/dev/null || die "Skrip ini untuk Debian/Ubuntu (apt)"
export DEBIAN_FRONTEND=noninteractive

# folder tempat skrip ini berada (kosong jika dijalankan lewat curl)
SELF=""; if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi

# ---------------------------------------------------------------- paket
say "Memasang paket (apache2, git, curl)"
apt-get update -y
apt-get install -y apache2 git curl ca-certificates openssl

# ---------------------------------------------------------------- node >= 22.13
NODE_OK=0
if command -v node >/dev/null; then
  NV="$(node -p 'process.versions.node')"; NMAJ="${NV%%.*}"; NMIN="$(echo "$NV" | cut -d. -f2)"
  if [ "$NMAJ" -gt 22 ] || { [ "$NMAJ" -eq 22 ] && [ "$NMIN" -ge 13 ]; }; then NODE_OK=1; fi
fi
if [ "$NODE_OK" -eq 0 ]; then
  say "Memasang Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
say "Node $(node -v)"

# ---------------------------------------------------------------- kode aplikasi
id "$SVC_USER" &>/dev/null || useradd --system --home "$APP" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$DATA"
if [ -d "$APP/.git" ]; then
  say "Aplikasi sudah ada di $APP, memperbarui (git pull)"
  git config --global --add safe.directory "$APP" 2>/dev/null || true
  git -C "$APP" pull --ff-only || warn "git pull gagal, memakai kode yang ada"
elif [ -n "$SELF" ] && [ "$SELF" != "$APP" ] && [ -f "$SELF/server.js" ] && [ ! -e "$APP" ]; then
  say "Menyalin aplikasi dari $SELF ke $APP"
  cp -r "$SELF" "$APP"
else
  [ ! -e "$APP" ] || [ -z "$(ls -A "$APP" 2>/dev/null)" ] || die "$APP sudah ada tetapi bukan git repository. Pindahkan/hapus dulu."
  say "git clone $BRANCH dari repo"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP"
fi
[ -f "$APP/server.js" ] || die "server.js tidak ditemukan di $APP"
if git -C "$APP" ls-files --error-unmatch .env >/dev/null 2>&1; then
  warn ".env ikut tertrack di git! Di PC lokal jalankan: git rm --cached .env && git commit && git push"
fi

# ---------------------------------------------------------------- .env
ENVF="$APP/.env"
GEN_PASS=""
if [ ! -f "$ENVF" ]; then
  say "Membuat $ENVF"
  cp "$APP/.env.example" "$ENVF"
  sed -i 's/^ROS_/# ROS_/' "$ENVF"                 # router ditambahkan dari dashboard, bukan dari .env
  DU="${DASH_USER:-}"; DP="${DASH_PASS:-}"
  if [ -z "$DU" ] && [ -t 0 ]; then read -r -p "Username login dashboard [admin]: " DU || true; fi
  DU="${DU:-admin}"
  if [ -z "$DP" ] && [ -t 0 ]; then read -r -s -p "Password login dashboard [kosong = dibuatkan acak]: " DP || true; echo; fi
  if [ -z "$DP" ]; then DP="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)"; GEN_PASS="$DP"; fi
  sed -i "s|^DASH_USER=.*|DASH_USER=$DU|; s|^DASH_PASS=.*|DASH_PASS=$DP|" "$ENVF"
  DASH_SHOW_USER="$DU"
else
  say ".env sudah ada, dibiarkan apa adanya"
  DASH_SHOW_USER="$(grep -E '^DASH_USER=' "$ENVF" | cut -d= -f2- || true)"
  grep -qE '^DASH_USER=.+' "$ENVF" || warn "DASH_USER di .env kosong -> dashboard tanpa login & tombol Update nonaktif"
fi
chown -R "$SVC_USER:$SVC_USER" "$APP" "$DATA"
chmod 600 "$ENVF"

# ---------------------------------------------------------------- systemd
say "Mengatur service systemd"
cp "$APP/deploy/nodestats.service" /etc/systemd/system/nodestats.service
systemctl daemon-reload
systemctl enable nodestats >/dev/null 2>&1
systemctl restart nodestats

# ---------------------------------------------------------------- apache
say "Mengatur Apache (reverse proxy)"
a2enmod proxy proxy_http headers >/dev/null
SITE=/etc/apache2/sites-available/nodestats.conf
if [ ! -f "$SITE" ]; then
  SN="${SERVER_NAME:-}"
  if [ -z "$SN" ] && [ -t 0 ]; then read -r -p "Domain / hostname dashboard (kosongkan jika akses lewat IP): " SN || true; fi
  cp "$APP/deploy/apache-nodestats.conf" "$SITE"
  if [ -n "$SN" ]; then sed -i "s|monitor.example.com|$SN|g" "$SITE"; else sed -i '/^ *ServerName monitor.example.com/d' "$SITE"; fi
else
  say "Konfigurasi Apache sudah ada, dibiarkan"
fi
a2dissite 000-default >/dev/null 2>&1 || true
a2ensite nodestats >/dev/null
apache2ctl configtest
systemctl enable apache2 >/dev/null 2>&1
systemctl reload apache2 || systemctl restart apache2

# ---------------------------------------------------------------- cek
say "Memeriksa layanan"
sleep 3
UP=""; PW="$(grep -E '^DASH_PASS=' "$ENVF" | cut -d= -f2- || true)"
if [ -n "$DASH_SHOW_USER" ]; then UP="-u $DASH_SHOW_USER:$PW"; fi
# shellcheck disable=SC2086
CODE="$(curl -s -o /dev/null -w '%{http_code}' $UP http://127.0.0.1/ || true)"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ "$CODE" = "200" ]; then printf '\033[1;32mOK: dashboard merespons lewat Apache (HTTP 200)\033[0m\n'; else warn "HTTP $CODE - cek: journalctl -u nodestats -n 50"; fi

cat <<EOF

=====================================================================
 NodeStats terpasang.

 Buka     : http://${IP:-IP_SERVER}/
 Login    : ${DASH_SHOW_USER:-"(tanpa login)"}${GEN_PASS:+  /  $GEN_PASS   <-- catat password ini}

 Langkah berikutnya:
  1. Buka dashboard, klik ikon gear di header -> tambah router MikroTik
     (di MikroTik buat user read-only + aktifkan www-ssl, lihat README).
  2. Update dari GitHub: push dari PC, lalu klik ikon panah atas di dashboard.

 Perintah berguna:
  journalctl -u nodestats -f          log aplikasi
  systemctl restart nodestats         restart
  nano $ENVF                          pengaturan
  cp $DATA/nodestats.db backup.db     backup database
=====================================================================
EOF
