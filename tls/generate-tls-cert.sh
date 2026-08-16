#!/usr/bin/env bash
#
# Generate a local CA and a TLS server certificate for the demo, so the
# player is served from an HTTPS origin. The C2PA plugin validates segments
# with the Web Crypto API (crypto.subtle.digest / importKey / verify), and
# browsers only expose crypto.subtle in a *secure context*: HTTPS, or one of
# the "potentially trustworthy" plain-HTTP origins (localhost, 127.0.0.1,
# [::1]). Opening the demo on a LAN address over http:// leaves
# crypto.subtle undefined and every segment fails validation with
# "Internal validation error (ManifestBoxValidator)".
#
# Everything here is generated locally with openssl - no internet access and
# no public CA involved.
#
# Produces in tls/:
#   local-ca-key.pem / local-ca-cert.pem  the local CA (trust this one)
#   server-key.pem / server-cert.pem      the server certificate
#   server-chain.pem                      server + CA, what nginx serves
#
# Usage:
#   ./tls/generate-tls-cert.sh            # refuses to overwrite existing files
#   FORCE=1 ./tls/generate-tls-cert.sh    # regenerate everything
#
# Overridable via environment:
#   OPENSSL      openssl binary
#   EXTRA_NAMES  additional DNS names, comma separated (e.g. "demo.box,ibc")
#   EXTRA_IPS    additional IP addresses, comma separated
#
set -euo pipefail

cd "$(dirname "$0")"

OPENSSL=${OPENSSL:-openssl}

# Apple platforms reject server certificates issued after 2020-09-01 with a
# validity longer than 398 days - Safari then fails the connection outright,
# no matter how well the CA is trusted. Stay below that.
DAYS_LEAF=397
DAYS_CA=730

# --- sanity checks ---------------------------------------------------------
if ! command -v "$OPENSSL" >/dev/null 2>&1; then
  echo >&2 "Error: openssl not found (set OPENSSL to override)."
  exit 1
fi

existing=()
for f in local-ca-key.pem local-ca-cert.pem server-key.pem server-cert.pem \
         server-chain.pem; do
  [ -e "$f" ] && existing+=("$f")
done
if [ ${#existing[@]} -gt 0 ] && [ "${FORCE:-}" != "1" ]; then
  echo >&2 "Error: refusing to overwrite: ${existing[*]}"
  echo >&2 "Run with FORCE=1 to regenerate (the CA has to be re-trusted then)."
  exit 1
fi

# --- collect the names the certificate has to cover ------------------------
# A certificate is only valid for the names in its subjectAltName; Apple
# platforms ignore the common name entirely. Cover every address the demo
# might be opened on: loopback, the machine's LAN address and its hostname.
dns_names=(localhost)
ip_addrs=(127.0.0.1 ::1)

host_short=$(hostname -s 2>/dev/null || hostname)
[ -n "$host_short" ] && dns_names+=("$host_short" "$host_short.local")

# LAN address, so colleagues on the same network can open the demo
lan_ip=""
if command -v ipconfig >/dev/null 2>&1; then          # macOS
  for iface in en0 en1 en2; do
    lan_ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
    [ -n "$lan_ip" ] && break
  done
elif command -v hostname >/dev/null 2>&1; then        # Linux
  lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi
[ -n "$lan_ip" ] && ip_addrs+=("$lan_ip")

IFS=',' read -ra extra <<< "${EXTRA_NAMES:-}"
for n in "${extra[@]}"; do [ -n "$n" ] && dns_names+=("$n"); done
IFS=',' read -ra extra <<< "${EXTRA_IPS:-}"
for i in "${extra[@]}"; do [ -n "$i" ] && ip_addrs+=("$i"); done

san=""
n=0
for d in "${dns_names[@]}"; do n=$((n + 1)); san+="DNS.$n = $d"$'\n'; done
n=0
for i in "${ip_addrs[@]}"; do n=$((n + 1)); san+="IP.$n = $i"$'\n'; done

echo "Certificate will be valid for:"
printf '  %s\n' "${dns_names[@]}" "${ip_addrs[@]}"
echo

# --- local CA --------------------------------------------------------------
echo "==> local CA"
$OPENSSL req -x509 -newkey rsa:2048 -nodes \
  -keyout local-ca-key.pem -out local-ca-cert.pem \
  -days "$DAYS_CA" -sha256 \
  -subj "/CN=live-demo-cmaf local CA/O=live-demo-cmaf" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

# --- server certificate ----------------------------------------------------
echo "==> server certificate"
cat > server.ext <<EOF
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
$san
EOF

$OPENSSL req -newkey rsa:2048 -nodes \
  -keyout server-key.pem -out server.csr \
  -subj "/CN=${dns_names[0]}/O=live-demo-cmaf" 2>/dev/null

$OPENSSL x509 -req -in server.csr \
  -CA local-ca-cert.pem -CAkey local-ca-key.pem -CAcreateserial \
  -out server-cert.pem -days "$DAYS_LEAF" -sha256 \
  -extfile server.ext 2>/dev/null

cat server-cert.pem local-ca-cert.pem > server-chain.pem
rm -f server.csr server.ext local-ca-cert.srl
chmod 600 local-ca-key.pem server-key.pem

echo
echo "Done. Now trust the CA once, so the browser accepts the certificate:"
echo
case "$(uname -s)" in
  Darwin)
    echo "  sudo security add-trusted-cert -d -r trustRoot \\"
    echo "    -k /Library/Keychains/System.keychain $(pwd)/local-ca-cert.pem"
    ;;
  *)
    echo "  sudo cp $(pwd)/local-ca-cert.pem \\"
    echo "    /usr/local/share/ca-certificates/live-demo-cmaf.crt"
    echo "  sudo update-ca-certificates"
    echo "  # Firefox and Chrome keep their own stores, import it there too"
    ;;
esac
echo
echo "Then start the stack:  docker compose up -d"
