#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS (Hostinger KVM 2) for the ordering platform.
#
#   sudo bash setup.sh <domain> <email> [release]
#   e.g. sudo REPO_URL=https://github.com/you/ordering.git CLIENT=spice-route bash setup.sh order.spiceroute.in owner@gmail.com release/v1.0
#
# Before running: point the domain's DNS A record at this server's IP (the
# HTTPS certificate needs it). Safe to run again: it skips what's done and
# never overwrites the .env or the database.
#
# What it does: system packages, Node.js 22, pm2, an app user `ordering`, the code
# (via deploy.sh), a .env with fresh secrets, nginx + HTTPS (Let's Encrypt),
# start on boot, nightly backups, log rotation and the firewall.
set -euo pipefail

DOMAIN="${1:-}"; EMAIL="${2:-}"; REF="${3:-release/v0.20}"
REPO_URL="${REPO_URL:?Set REPO_URL to your repository, e.g. REPO_URL=https://github.com/you/ordering.git}"
APP_USER=ordering
APP_HOME="/home/$APP_USER"
PORT=3000

[ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || { sed -n '2,13p' "$0"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0 $*"; exit 1; }

step() { echo; echo "==> $*"; }
as_app() { sudo -u "$APP_USER" -H bash -c "$1"; }

# ---- DNS check (warn only) -------------------------------------------------
step "Checking DNS for $DOMAIN"
MY_IP="$(curl -fsS4 --max-time 5 https://api.ipify.org || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [ -n "$MY_IP" ] && [ "$MY_IP" != "$DNS_IP" ]; then
  echo "    WARNING: $DOMAIN points to '${DNS_IP:-nothing}', this server is $MY_IP."
  echo "    HTTPS will fail until the A record points here. Fix DNS, wait a few minutes, re-run."
fi

# ---- Packages ---------------------------------------------------------------
step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl git nginx certbot python3-certbot-nginx sqlite3 ufw ca-certificates gnupg

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null; then
  step "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
echo "    node $(node -v)"
command -v pm2 >/dev/null || npm install -g --no-fund --no-audit pm2

# ---- App user and folders -----------------------------------------------------
step "App user $APP_USER"
id "$APP_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$APP_USER"
as_app "mkdir -p ~/shared/data ~/shared/backups ~/shared/logs ~/releases"
[ -d "$APP_HOME/repo/.git" ] || as_app "git clone --quiet '$REPO_URL' ~/repo"

# ---- .env with fresh secrets (only the first time) ---------------------------------
FIRST_RUN=0
if [ ! -f "$APP_HOME/shared/.env" ]; then
  FIRST_RUN=1
  step "Writing $APP_HOME/shared/.env with new secrets"
  as_app "git -C ~/repo fetch --quiet origin && git -C ~/repo show 'origin/$REF:.env.example' > ~/shared/.env"
  setenv() { sed -i "s|^$1=.*|$1=$2|" "$APP_HOME/shared/.env"; grep -q "^$1=" "$APP_HOME/shared/.env" || echo "$1=$2" >> "$APP_HOME/shared/.env"; }
  setenv NODE_ENV production
  setenv PORT "$PORT"
  setenv CLIENT "${CLIENT:-sample}"
  setenv PUBLIC_BASE_URL "https://$DOMAIN"
  setenv DB_PATH "$APP_HOME/shared/data/ordering.db"
  setenv ADMIN_TOKEN "$(openssl rand -hex 24)"
  setenv SETTINGS_KEY "$(openssl rand -hex 32)"
  setenv WHATSAPP_VERIFY_TOKEN "$(openssl rand -hex 16)"
  setenv SHADOWFAX_CALLBACK_TOKEN "$(openssl rand -hex 16)"
  setenv PORTER_CALLBACK_TOKEN "$(openssl rand -hex 16)"
  chmod 600 "$APP_HOME/shared/.env"; chown "$APP_USER:$APP_USER" "$APP_HOME/shared/.env"
fi
PORT="$(grep -E '^PORT=' "$APP_HOME/shared/.env" | cut -d= -f2)"

# ---- Code ------------------------------------------------------------------------
step "Installing $REF"
# The repo's default branch may not have the deploy scripts: use the release's own.
as_app "git -C ~/repo fetch --quiet origin && git -C ~/repo checkout --quiet --detach 'origin/$REF'"
as_app "bash ~/repo/deploy/deploy.sh '$REF'" || { echo "    deploy failed; see: sudo -u $APP_USER pm2 logs ordering"; exit 1; }

# ---- Start on boot, log rotation -------------------------------------------------
step "Start on boot"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
as_app "pm2 save >/dev/null"
as_app "pm2 describe pm2-logrotate >/dev/null 2>&1 || (pm2 install pm2-logrotate >/dev/null && pm2 set pm2-logrotate:max_size 20M >/dev/null && pm2 set pm2-logrotate:retain 14 >/dev/null)"

# ---- nginx + HTTPS ----------------------------------------------------------------
step "nginx for $DOMAIN"
mkdir -p /var/www/ordering
cp "$APP_HOME/current/deploy/502.html" /var/www/ordering/502.html
if [ ! -f /etc/nginx/sites-available/ordering ]; then
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$APP_HOME/current/deploy/nginx.conf.template" > /etc/nginx/sites-available/ordering
fi
ln -sfn /etc/nginx/sites-available/ordering /etc/nginx/sites-enabled/ordering
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

step "HTTPS certificate"
if certbot certificates 2>/dev/null | grep -qw "$DOMAIN"; then
  echo "    certificate already present"
else
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos -n --redirect \
    || echo "    WARNING: certificate not issued yet (DNS?). Re-run this script once $DOMAIN points here."
fi

# ---- Backups and firewall ------------------------------------------------------------
step "Nightly backups (03:15)"
CRON="15 3 * * * $APP_HOME/current/deploy/backup.sh >> $APP_HOME/shared/logs/backup.log 2>&1"
( crontab -u "$APP_USER" -l 2>/dev/null | grep -v 'deploy/backup.sh'; echo "$CRON" ) | crontab -u "$APP_USER" -

step "Firewall"
ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null
ufw status | head -5

# ---- Done ------------------------------------------------------------------------------
OWNER_PIN_LINE=""
if [ "$FIRST_RUN" = 1 ]; then
  step "Owner PIN for Head office → Connections"
  OWNER_PIN_LINE="$(as_app "cd ~/current && npm run -s owner-pin" | head -1)"
fi

step "Setup check"
as_app "cd ~/current && npm run -s check" || true

ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' "$APP_HOME/shared/.env" | cut -d= -f2)"
VERIFY="$(grep -E '^WHATSAPP_VERIFY_TOKEN=' "$APP_HOME/shared/.env" | cut -d= -f2)"
cat <<EOF

Done. Running: $(cat "$APP_HOME/current/VERSION")

  Customer app:       https://$DOMAIN/
  Outlet panel:       https://$DOMAIN/outlet/
  Head office panel:  https://$DOMAIN/admin/
  Head office token:  $ADMIN_TOKEN        (keep it private)
  ${OWNER_PIN_LINE:-Owner PIN: already set (change it with: sudo -u $APP_USER bash -c 'cd ~/current && npm run owner-pin')}

  WhatsApp webhook:   https://$DOMAIN/webhooks/whatsapp
  Verify token:       $VERIFY

Next: fill in WhatsApp / delivery partner / Supabase keys in $APP_HOME/shared/.env
(sudo -u $APP_USER nano $APP_HOME/shared/.env), then: sudo -u $APP_USER pm2 reload ordering
Updates later: sudo -u $APP_USER bash $APP_HOME/current/deploy/deploy.sh release/v0.NN   (see DEPLOY.md)
EOF
