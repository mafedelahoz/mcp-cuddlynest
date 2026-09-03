#!/usr/bin/env bash
# Run once on a fresh Ubuntu 22.04/24.04 Oracle Cloud VM (as the default user,
# e.g. `ubuntu`). Installs Docker, opens the firewall, and starts the stack.
#
#   curl -fsSL https://raw.githubusercontent.com/mafedelahoz/mcp-cuddlynest/main/deploy/oracle/bootstrap.sh | bash
#
# or clone the repo and run  bash deploy/oracle/bootstrap.sh  from deploy/oracle/.
set -euo pipefail

REPO="https://github.com/mafedelahoz/mcp-cuddlynest.git"
APP_DIR="$HOME/mcp-cuddlynest"

echo "==> Docker"
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin git
  sudo usermod -aG docker "$USER"
fi

echo "==> Firewall (OS-level — the VCN Security List must also allow 80/443)"
# Oracle Ubuntu images ship iptables rules that block everything but SSH.
sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT || true
sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT || true
sudo netfilter-persistent save || sudo sh -c 'iptables-save > /etc/iptables/rules.v4' || true

echo "==> Source"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
cd "$APP_DIR/deploy/oracle"

if [ ! -f .env ]; then
  cp .env.example .env
  IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  sed -i "s/^SITE_ADDRESS=.*/SITE_ADDRESS=${IP//./-}.sslip.io/" .env
  echo "   wrote .env with SITE_ADDRESS=${IP//./-}.sslip.io  (edit it to use a real domain later)"
fi

echo "==> Build + start"
sudo docker compose up -d --build

echo
echo "Done. Give Caddy ~30s for the cert, then:"
grep SITE_ADDRESS .env | sed 's/SITE_ADDRESS=/  https:\/\//; s/$/\/health/'
echo "  (log out and back in once so 'docker' works without sudo)"
