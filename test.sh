#!/usr/bin/env bash
set -euo pipefail

# Expo webhook secret (must match EXPO_WEBHOOK_SECRET in Cloudflare + in Expo webhook settings)
SECRET="LOLWOWLOLWOWLOLWOWLOLWOW"

# Worker endpoint
URL="https://next-starter-template.kerem-0cc.workers.dev/api/expo-webhook"

# JSON body payload (exactly as Expo would send)
BODY='{
  "status":"finished",
  "buildDetailsPageUrl":"https://expo.dev/accounts/superapplabs/projects/axon/builds/123456",
  "gitRef":"feature/SPR-3374",
  "metadata":{"commitMessage":"Preview build for SPR-3374"}
}'

# Generate HMAC-SHA1 signature (base64)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha1 -binary -hmac "$SECRET" | openssl base64)

echo "Using signature: $SIG"
echo "Posting to $URL"

# Send request
curl -i -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "expo-signature: sha1=$SIG" \
  -d "$BODY"

