#!/usr/bin/env bash
# Install NodeStats di Debian/Ubuntu (LXC atau VM Proxmox). Jalankan sebagai root dari folder project:
#   bash deploy/install.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Jalankan sebagai root"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Paket (apache2, curl)"
apt-get update -y
apt-get install -y apache2 curl ca-certificates

# Butuh Node >= 22.13 (untuk node:sqlite bawaan)
need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  echo "==> Install Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> User & folder"
id nodestats &>/dev/null || useradd --system --home /opt/nodestats --shell /usr/sbin/nologin nodestats
mkdir -p /opt/nodestats /var/lib/nodestats
cp -r "$SRC/server.js" "$SRC/db.js" "$SRC/package.json" "$SRC/public" /opt/nodestats/
[ -f /opt/nodestats/.env ] || cp "$SRC/.env.example" /opt/nodestats/.env
chown -R nodestats:nodestats /opt/nodestats /var/lib/nodestats
chmod 600 /opt/nodestats/.env

echo "==> systemd"
cp "$SRC/deploy/nodestats.service" /etc/systemd/system/nodestats.service
systemctl daemon-reload
systemctl enable nodestats

echo "==> Apache"
a2enmod proxy proxy_http headers >/dev/null
[ -f /etc/apache2/sites-available/nodestats.conf ] || cp "$SRC/deploy/apache-nodestats.conf" /etc/apache2/sites-available/nodestats.conf
a2dissite 000-default >/dev/null 2>&1 || true
a2ensite nodestats >/dev/null
apache2ctl configtest
systemctl reload apache2

echo
echo "SELESAI. Langkah terakhir:"
echo "  1. nano /opt/nodestats/.env      (isi ROS_HOST, ROS_USER, ROS_PASS, DASH_USER, DASH_PASS)"
echo "  2. nano /etc/apache2/sites-available/nodestats.conf   (ganti ServerName)"
echo "  3. systemctl restart nodestats apache2"
echo "  4. journalctl -u nodestats -f    (cek log)"
