#!/usr/bin/env bash
#
# Generate the self-signed certificate chain, session key and AIX document
# for the Unified Streaming Trusted Media (C2PA) workflow, following:
# https://docs.unified-streaming.com/tutorials/trusted-media/index.html
#
# Produces in the current directory:
#   root-key.pem / root-cert.pem                root CA (Ed25519)
#   intermediate-key.pem / intermediate-cert.pem intermediate CA
#   leaf-key.pem / leaf-cert.pem                 content signer certificate
#   chain.pem                                    leaf + intermediate chain
#   session-key.pem                              C2PA session key
#   minimal.aix                                  AIX document for mp4split --aix
#
# The AIX document contains PRIVATE KEYS, do not commit or publish it.
#
# Usage:
#   ./generate-certs-and-aix.sh          # refuses to overwrite existing files
#   FORCE=1 ./generate-certs-and-aix.sh  # regenerate everything
#
# Overridable via environment:
#   OPENSSL        openssl binary (needs 3.x with Ed25519, e.g. brew openssl@3)
#   AIX_TITLE      dc:title metadata assertion
#   AIX_PUBLISHER  dc:publisher metadata assertion
#   AIX_RIGHTS     dc:rights metadata assertion

set -euo pipefail

OPENSSL=${OPENSSL:-openssl}
DAYS_ROOT=730
DAYS=365
OUTPUT_FILE="minimal.aix"

AIX_TITLE=${AIX_TITLE:-"Unified Streaming Live Demo (CMAF)"}
AIX_PUBLISHER=${AIX_PUBLISHER:-"Unified Streaming Live Demo"}
AIX_RIGHTS=${AIX_RIGHTS:-"Demo content, not for production use"}

# --- sanity checks ---------------------------------------------------------
if ! $OPENSSL version | grep -q "OpenSSL 3"; then
  echo >&2 "Error: OpenSSL 3.x required (found: $($OPENSSL version))."
  echo >&2 "On macOS: brew install openssl@3 and run with OPENSSL=\$(brew --prefix openssl@3)/bin/openssl"
  exit 1
fi

if [ -z "${FORCE:-}" ]; then
  for f in root-key.pem intermediate-key.pem leaf-key.pem session-key.pem "$OUTPUT_FILE"; do
    if [ -e "$f" ]; then
      echo >&2 "Error: $f already exists, run with FORCE=1 to regenerate."
      exit 1
    fi
  done
fi

# --- root CA ---------------------------------------------------------------
echo "Generating root CA..."
$OPENSSL genpkey -algorithm ed25519 -out root-key.pem
chmod 600 root-key.pem

$OPENSSL req -x509 -new \
  -key root-key.pem \
  -out root-cert.pem \
  -days $DAYS_ROOT \
  -subj "/CN=Unified Tutorial Root" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

# --- intermediate CA -------------------------------------------------------
echo "Generating intermediate CA..."
$OPENSSL genpkey -algorithm ed25519 -out intermediate-key.pem
chmod 600 intermediate-key.pem

cat > intermediate.ext <<EOF
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
EOF

$OPENSSL req -new \
  -key intermediate-key.pem \
  -subj "/CN=Unified Tutorial Intermediate" | \
$OPENSSL x509 -req -in - \
  -CA root-cert.pem \
  -CAkey root-key.pem \
  -CAcreateserial \
  -out intermediate-cert.pem \
  -days $DAYS \
  -extfile intermediate.ext

# --- leaf (content signer) -------------------------------------------------
echo "Generating leaf certificate (content signer)..."
$OPENSSL genpkey -algorithm ed25519 -out leaf-key.pem
chmod 600 leaf-key.pem

cat > leaf.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
EOF

$OPENSSL req -new \
  -key leaf-key.pem \
  -subj "/C=NL/O=Unified Streaming Tutorial/OU=Content Signing/CN=Unified Streaming Tutorial Content Signer" | \
$OPENSSL x509 -req -in - \
  -CA intermediate-cert.pem \
  -CAkey intermediate-key.pem \
  -CAcreateserial \
  -out leaf-cert.pem \
  -days $DAYS \
  -extfile leaf.ext

# --- chain (leaf first, then upward) ----------------------------------------
cat leaf-cert.pem intermediate-cert.pem > chain.pem

echo "Verifying chain..."
$OPENSSL verify \
  -CAfile root-cert.pem \
  -untrusted intermediate-cert.pem \
  leaf-cert.pem

# --- session key -------------------------------------------------------------
echo "Generating session key..."
$OPENSSL genpkey -algorithm ed25519 -out session-key.pem
chmod 600 session-key.pem

# --- AIX document ------------------------------------------------------------
echo "Assembling $OUTPUT_FILE..."
private_b64=$(base64 < leaf-key.pem | tr -d '\n')
public_b64=$(base64 < chain.pem | tr -d '\n')
session_private_b64=$(base64 < session-key.pem | tr -d '\n')
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$OUTPUT_FILE" <<EOF
{
  "signers": {
    "generator": {
      "private_key": "$private_b64",
      "public_certificate_chain": "$public_b64"
    }
  },
  "session_keys": {
    "key_001": {
      "private_key": "$session_private_b64",
      "created_at": "$created_at",
      "validity_period": 31536000
    }
  },
  "assertions": {
    "metadata_assertion": {
      "cawg.metadata": {
        "@context": {
          "dc": "http://purl.org/dc/elements/1.1/"
        },
        "dc:publisher": "$AIX_PUBLISHER",
        "dc:rights": "$AIX_RIGHTS",
        "dc:title": "$AIX_TITLE"
      }
    },
    "identity_assertion": {
      "cawg.identity": {
        "signer": "generator",
        "referenced_assertions": [
          "metadata_assertion"
        ]
      }
    }
  },
  "claim": {
    "signer": "generator"
  }
}
EOF
chmod 600 "$OUTPUT_FILE"

echo
echo "Done. Created $OUTPUT_FILE (contains private keys, keep it out of git)."
echo "Start the stack with 'docker compose up -d --build' to serve a C2PA signed live stream."
