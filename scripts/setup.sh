#!/usr/bin/env bash
# ldes-lite deployment script for fresh Ubuntu.
# Usage: sudo bash scripts/setup.sh
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "==> deploying from ${REPO_ROOT}"

echo "==> base packages"
apt update
apt install -y curl gnupg jq ufw debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node.js 24"
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q "^v24"; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt install -y nodejs
fi
node --version

echo "==> Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt update
  apt install -y caddy
fi

echo "==> service user + directories"
useradd --system --home-dir /var/lib/ldes-lite --shell /usr/sbin/nologin ldes 2>/dev/null || true
mkdir -p /var/lib/ldes-lite/data/nodes /var/lib/ldes-lite/keys
chown -R ldes:ldes /var/lib/ldes-lite

echo "==> deploy code to /opt/ldes-lite"
mkdir -p /opt/ldes-lite
cp -r "${REPO_ROOT}/src" /opt/ldes-lite/
cp "${REPO_ROOT}/package.json" "${REPO_ROOT}/tsconfig.json" /opt/ldes-lite/
chown -R root:ldes /opt/ldes-lite
chmod -R g+rX /opt/ldes-lite
cd /opt/ldes-lite
npm install --omit=dev
cd - >/dev/null

echo "==> config file"
if [ ! -f /var/lib/ldes-lite/config.json ]; then
  cp "${REPO_ROOT}/config.example.json" /var/lib/ldes-lite/config.json
  chown ldes:ldes /var/lib/ldes-lite/config.json
  chmod 644 /var/lib/ldes-lite/config.json
  echo "    !! edit /var/lib/ldes-lite/config.json to set baseIri for your domain"
fi

echo "==> shape file"
if [ ! -f /var/lib/ldes-lite/shape.ttl ]; then
  cp "${REPO_ROOT}/shape.example.ttl" /var/lib/ldes-lite/shape.ttl
  chown ldes:ldes /var/lib/ldes-lite/shape.ttl
fi

echo "==> Ed25519 keypair"
if [ ! -f /var/lib/ldes-lite/keys/ed25519.key ]; then
  sudo -u ldes node --input-type=module -e '
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync("/var/lib/ldes-lite/keys/ed25519.key",
  privateKey.export({ type: "pkcs8", format: "pem" }));
chmodSync("/var/lib/ldes-lite/keys/ed25519.key", 0o400);
writeFileSync("/var/lib/ldes-lite/keys/ed25519.pub",
  publicKey.export({ type: "spki", format: "pem" }));
'
  echo "    generated new keypair"
fi

echo "==> ingest token"
if [ ! -f /var/lib/ldes-lite/ingest.token ]; then
  node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))' \
    > /var/lib/ldes-lite/ingest.token
  chown ldes:ldes /var/lib/ldes-lite/ingest.token
  chmod 0400 /var/lib/ldes-lite/ingest.token
  echo "    generated new ingest token:"
  cat /var/lib/ldes-lite/ingest.token
  echo ""
  echo "    !! save this token — you need it to POST /ingest"
fi

echo "==> initial root.nq"
if [ ! -f /var/lib/ldes-lite/data/root.nq ]; then
  BASE_IRI=$(jq -r .baseIri /var/lib/ldes-lite/config.json)
  cat > /var/lib/ldes-lite/data/root.nq <<EOF
<${BASE_IRI}root> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/ldes#EventStream> .
<${BASE_IRI}root> <https://w3id.org/tree#view> <${BASE_IRI}root> .
<${BASE_IRI}root> <https://w3id.org/ldes#timestampPath> <http://www.w3.org/ns/prov#generatedAtTime> .
<${BASE_IRI}root> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/tree#Node> .
EOF
  chown ldes:ldes /var/lib/ldes-lite/data/root.nq
fi

echo "==> systemd unit"
cp "${REPO_ROOT}/systemd/ldes-lite.service" /etc/systemd/system/ldes-lite.service
systemctl daemon-reload
systemctl enable ldes-lite

echo "==> Caddyfile"
if ! grep -q "reverse_proxy 127.0.0.1:3000" /etc/caddy/Caddyfile 2>/dev/null; then
  cp "${REPO_ROOT}/caddy/Caddyfile.example" /etc/caddy/Caddyfile
  echo "    !! edit /etc/caddy/Caddyfile to set your domain and email"
fi

echo "==> firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

cat <<'DONE'

  setup complete.

  next steps:
    1. edit /var/lib/ldes-lite/config.json — set baseIri to your https URL
    2. edit /etc/caddy/Caddyfile — set your domain and email
    3. point DNS A record at this server
    4. systemctl start ldes-lite
    5. systemctl reload caddy    # obtains TLS cert on first request

DONE
