# Code Review Validation'dan Önce mi Sonra mı Gelmeli?

Code review, doğrulamadan ("validation" adımından) önce bir kalite kontrol adımıdır. Bu sayede kodun yeterince sağlam olduğundan emin olunur ve validation aşaması hata ayıklama yerine iş ihtiyaçlarına (business requirements) odaklanabilir. Ayrıca, code review ekip içi bilgi paylaşımını artırır, farklı bakış açılarıyla potansiyel hataların veya mimari zayıflıkların erkenden yakalanmasını sağlar. Kod standartlarının korunması, sürdürülebilirlik ve okunabilirlik gibi yazılımın uzun vadeli kalitesine katkıda bulunur.

# PR ↔ Notion Task Çift Yönlü Linkleme Akışı

## Amaç

- **PR açıldığında:** PR linki Notion'daki ilgili task(lar)ın altına otomatik düşsün.
- **PR tarafı:** PR içinde ilgili tüm task linkleri listelensin.
- **Çift yön:** Hem PR'da task linkleri, hem task'ta PR linki bulunmalı.

## 1) Konvansiyon (zorunlu)

PR description veya title içinde task ID veya Notion URL geçecek:

**ID formatı:** `TASK-1234`

**Örnek PR body:**
```markdown
### Description
Release automation for CI/CD.

### Related Tasks
TASK-3374
https://www.notion.so/Tasks-ci-cd-25b6cafc5b5c801fba02ea17d3cc4b77#25d6cafc5b5c80d5b565c006f1b006de
```

## 2) Notion Kurulumu

- Notion Workspace'te bir Integration oluştur, token'ı GitHub repo secret olarak kaydet: `NOTION_TOKEN`.
  - https://www.notion.so/profile/integrations
- İlgili Notion task sayfasını bu integration ile paylaş:
  - Sağ üstteki üç nokta → Connections → "GitHub PR Sync"

## 3) GitHub Actions'da Notion Webhook Kurulumu

Main branch'te bulunan workflow `.github/workflows/notion_webhook.yml`:

PR event'lerinde tetiklensin: `opened`, `edited`, `synchronize`.

```yaml
name: Link PRs with Notion Tasks

on:
  pull_request:
    types: [opened, edited, synchronize]
    # If you later parse PR comments too, add:
    # issue_comment:
    #   types: [created, edited]

# Needed so the job can post a comment (and/or edit the PR body)
permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  link-pr-tasks:
    runs-on: ubuntu-latest

    steps:
      # 1) Checkout the PR branch (default path = repo root)
      - name: Checkout PR branch
        uses: actions/checkout@v3

      # 2) Also checkout main branch into a subfolder for the script
      - name: Checkout main branch (for script)
        uses: actions/checkout@v3
        with:
          ref: main
          path: main-branch

      # 3) (Optional) Quick debug to verify files are present
      - name: List files
        run: |
          echo "Current ref: ${{ github.ref }}"
          ls -la
          ls -la main-branch/scripts || true

      # 4) Python setup + deps
      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: "3.11"

      - name: Install dependencies
        run: pip install requests

      # 5) Run the script from main branch
      - name: Run script to sync PR ↔ Notion
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # auto-provided
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}   # you create in repo secrets
          # Optional: if your script supports multiple prefixes via env
          # TASK_PREFIXES: "SPR,TASK"
        run: python main-branch/scripts/link_pr_to_notion_task.py
```

- Workflow önce PR branch'ini ve ayrıca main branch'ten script'i indirir.
- Python ortamı kurulur, gerekli paketler yüklenir.
- Script çalıştırılır: PR'ın title/body/branch içinden `TASK-####` veya Notion linkleri aranır.
- Bulunan task sayfalarına Notion API üzerinden PR linki eklenir.
- PR tarafına da ilgili task linkleri yorum olarak bırakılır.

## 4) scripts/link_pr_to_notion_task.py Script Mantığı

### Script'in Genel Özeti

GitHub Action tarafından çağrılır. PR içeriğini (title, body, branch) tarar. Eğer `TASK-####` formatında ID veya Notion URL bulursa, PR ↔ Task arasında çift yönlü bağlantı kurar.

### Script'in Genel İşleyişi

1) PR verilerini okur
2) Notion task'i için Regex ile arama yapar
3) Notion sayfalarını bulur
4) Notion tarafını ekleme yapar, örneğin:
   ```
   PR: https://github.com/SuperAppLabsCo/axon-ui/pull/108
   ```
5) GitHub PR tarafını günceller:
   ```
   Linked Notion Tasks:
   https://www.notion.so/25b6cafc5b5c801fba02ea17d3cc4b77
   ```

```python
#!/usr/bin/env python3

import json
import os
import re
import sys
from typing import List, Dict, Tuple, Optional
import requests

GITHUB_API = "https://api.github.com"
NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"  # stable, fine for pages/search/blocks

TASK_PREFIX = os.getenv("TASK_PREFIX", "TASK")  # e.g., TASK, ISSUE, CARD
TASK_REGEX = re.compile(rf"\b{re.escape(TASK_PREFIX)}-\d+\b", re.IGNORECASE)
NOTION_URL_REGEX = re.compile(r"https?://(www\.)?notion\.so/[^\s)>\]]+")

def die(msg: str, exit_code: int = 1):
    print(f"::error:: {msg}")
    sys.exit(exit_code)

def gh_headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
    }

def notion_headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }

def load_event() -> dict:
    path = os.getenv("GITHUB_EVENT_PATH")
    if not path or not os.path.exists(path):
        die("GITHUB_EVENT_PATH not found; are you running in GitHub Actions?")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def extract_pr_info(evt: dict) -> Tuple[str, str, int, str, str, str]:
    """
    Returns (repo_full, owner, pr_number, pr_html_url, pr_title, pr_body)
    """
    pr = evt.get("pull_request")
    if not pr:
        die("Event payload has no pull_request object.")
    repo = evt.get("repository", {}) or {}
    repo_full = repo.get("full_name")
    if not repo_full:
        die("repository.full_name missing in event.")
    owner = repo.get("owner", {}).get("login", "")
    number = pr.get("number")
    html_url = pr.get("html_url")
    title = pr.get("title") or ""
    body = pr.get("body") or ""
    return repo_full, owner, int(number), html_url, title, body

def parse_task_refs(title: str, body: str, branch: Optional[str]) -> Dict[str, List[str]]:
    text = "\n".join([title, body or "", branch or ""])
    ids = sorted(set(m.group(0).upper() for m in TASK_REGEX.finditer(text)))
    notion_links = sorted(set(NOTION_URL_REGEX.findall(text)))  # findall returns tuples if groups
    # Normalize notion links from regex with groups
    links = sorted(set(m.group(0) if hasattr(m, "group") else m for m in re.finditer(NOTION_URL_REGEX, text)))
    return {"task_ids": ids, "notion_links": links}

def extract_branch(evt: dict) -> str:
    return (evt.get("pull_request", {}).get("head", {}) or {}).get("ref", "") or ""

def ensure_uuid_hyphens(id32: str) -> str:
    """Convert 32-hex to UUID with hyphens."""
    s = id32.replace("-", "")
    if len(s) != 32 or not re.fullmatch(r"[0-9a-fA-F]{32}", s):
        return id32  # return as-is; Notion may still accept some variants
    return f"{s[0:8]}-{s[8:12]}-{s[12:16]}-{s[16:20]}-{s[20:32]}"

def page_id_from_notion_url(url: str) -> Optional[str]:
    """
    Extract the last 32-hex chunk from a Notion URL and hyphenate it.
    """
    m = re.search(r"([0-9a-fA-F]{32})(?:\?|#|/|$)", url)
    if not m:
        return None
    return ensure_uuid_hyphens(m.group(1).lower())

def notion_search_page(notion_token: str, query: str) -> Optional[Tuple[str, str]]:
    """
    Search for a page by text (e.g., TASK-123). Returns (page_id, public_url) if found.
    """
    resp = requests.post(
        f"{NOTION_API}/search",
        headers=notion_headers(notion_token),
        json={"query": query, "filter": {"value": "page", "property": "object"}},
        timeout=20,
    )
    resp.raise_for_status()
    results = resp.json().get("results", [])
    if not results:
        return None
    page = results[0]
    page_id = page.get("id")
    # Construct a viewable URL if available; Notion doesn’t always give it directly.
    public_url = f"https://www.notion.so/{page_id.replace('-', '')}"
    return page_id, public_url

def notion_get_children(notion_token: str, page_id: str) -> List[dict]:
    resp = requests.get(
        f"{NOTION_API}/blocks/{page_id}/children?page_size=100",
        headers=notion_headers(notion_token),
        timeout=20,
    )
    if resp.status_code == 200:
        return resp.json().get("results", [])
    return []

def notion_append_pr_bullet(notion_token: str, page_id: str, pr_url: str):
    # Dedup: if a bullet already contains the PR URL, skip
    for b in notion_get_children(notion_token, page_id):
        if b.get("type") == "bulleted_list_item":
            texts = b["bulleted_list_item"].get("rich_text", [])
            if any(pr_url in (t.get("text", {}).get("content", "") or "") for t in texts):
                return  # already present
    payload = {
        "children": [
            {
                "object": "block",
                "type": "bulleted_list_item",
                "bulleted_list_item": {
                    "rich_text": [
                        {
                            "type": "text",
                            "text": {"content": f"PR: {pr_url}", "link": {"url": pr_url}},
                        }
                    ]
                },
            }
        ]
    }
    resp = requests.patch(
        f"{NOTION_API}/blocks/{page_id}/children",
        headers=notion_headers(notion_token),
        data=json.dumps(payload),
        timeout=20,
    )
    # If fails, don't crash the workflow; just log
    if resp.status_code >= 300:
        print(f"::warning:: Failed to append PR link to Notion page {page_id}: {resp.text}")

def gh_post_pr_comment(token: str, repo_full: str, pr_number: int, body: str):
    resp = requests.post(
        f"{GITHUB_API}/repos/{repo_full}/issues/{pr_number}/comments",
        headers=gh_headers(token),
        json={"body": body},
        timeout=20,
    )
    if resp.status_code >= 300:
        print(f"::warning:: Failed to post PR comment: {resp.text}")

def main():
    gh_token = os.getenv("GITHUB_TOKEN")
    notion_token = os.getenv("NOTION_TOKEN")

    if not gh_token:
        die("GITHUB_TOKEN missing. In Actions, expose it via env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}")
    if not notion_token:
        die("NOTION_TOKEN missing. Add it as a repository secret and expose via env.")

    evt = load_event()
    repo_full, owner, pr_number, pr_html_url, pr_title, pr_body = extract_pr_info(evt)
    branch = extract_branch(evt)

    refs = parse_task_refs(pr_title, pr_body, branch)
    task_ids = refs["task_ids"]
    notion_links = refs["notion_links"]

    # Resolve Notion pages from direct links
    pages: List[Tuple[str, str]] = []  # (page_id, page_url)

    for link in notion_links:
        pid = page_id_from_notion_url(link)
        if pid:
            pages.append((pid, link))

    # Resolve Notion pages from task IDs (search)
    for tid in task_ids:
        found = notion_search_page(notion_token, tid)
        if found:
            pages.append(found)

    # De-duplicate by page_id
    uniq: Dict[str, str] = {}
    for pid, url in pages:
        uniq[pid] = url
    pages = [(pid, url) for pid, url in uniq.items()]

    # Link PR -> Notion (append a bullet with PR URL)
    for pid, _ in pages:
        notion_append_pr_bullet(notion_token, pid, pr_html_url)

    # Link Notion -> PR (comment on PR listing task pages)
    if pages:
        lines = ["Linked Notion Tasks:"]
        for _, url in pages:
            lines.append(f"- {url}")
        gh_post_pr_comment(gh_token, repo_full, pr_number, "\n".join(lines))
        print(f"Linked {len(pages)} Notion page(s) to PR #{pr_number}.")
    else:
        print("No Notion pages or task IDs found to link.")

if __name__ == "__main__":
    main()
```
# Preview Build Alındığında Firebase App Distribution'a Release Notunu Otomatik Düşürmek

## 0) Ön Koşullar ve Amaç

- Firebase projesi ayarlı, App Distribution etkin.
- Application ID'leri hazır.
- Dağıtılacak paket: Android için .apk/.aab, iOS için .ipa.
- Release notu dosyası: `release-notes/preview.txt`.

Preview profiliyle alınan EAS build tamamlandığında, Firebase App Distribution'a yükleme yapılırken release notu repo'daki bir TXT dosyasından, `release_notes/preview.txt`, okunacak.

## 1) scripts/upload-to-firebase.sh ve Örnek release_notes/preview.txt

```bash
#!/bin/bash

set -e

echo "Starting post-build Firebase App Distribution upload..."
echo "Debug info:"
echo "  - EAS_BUILD_PLATFORM: $EAS_BUILD_PLATFORM"
echo "  - EAS_BUILD_PROFILE: $EAS_BUILD_PROFILE"
echo "  - EAS_BUILD_WORKINGDIR: $EAS_BUILD_WORKINGDIR"
echo "  - PWD: $(pwd)"

# Only upload for 'preview' builds
if [ "$EAS_BUILD_PROFILE" != "preview" ]; then
  echo "Skipping upload - not a preview build"
  exit 0
fi

echo "Searching for build artifacts..."
ls -la

echo "Looking for build directories..."
find . -type d -name "*build*" || echo "No build directories found"

for path in "android/app/build/outputs/apk" "ios/build" "build" "dist" ".expo"; do
  if [ -d "$path" ]; then
    echo "  Found directory: $path"
    ls -la "$path" || true
  fi
done

# Install Firebase CLI if needed
if ! command -v firebase &> /dev/null; then
  echo "Installing Firebase CLI..."
  npm install -g firebase-tools@13.7.1
fi

# Use custom env variable for service account key
if [ -z "$AXON_AI_FIREBASE_SERVICE_ACCOUNT_KEY" ]; then
  echo "Service account key not set (AXON_AI_FIREBASE_SERVICE_ACCOUNT_KEY)"
  exit 1
fi

echo "$AXON_AI_FIREBASE_SERVICE_ACCOUNT_KEY" > /tmp/firebase-key.json
export GOOGLE_APPLICATION_CREDENTIALS=/tmp/firebase-key.json

# Select correct app ID and build output patterns
if [ "$EAS_BUILD_PLATFORM" == "android" ]; then
  APP_ID="$FIREBASE_ANDROID_APP_ID"
  POSSIBLE_PATHS=(
    "android/app/build/outputs/apk/**/*.apk"
    "android/app/build/outputs/apk/release/*.apk"
    "android/app/build/outputs/apk/debug/*.apk"
    "build/*.apk"
    "dist/*.apk"
    ".expo/*.apk"
    "*.apk"
  )
elif [ "$EAS_BUILD_PLATFORM" == "ios" ]; then
  APP_ID="$FIREBASE_IOS_APP_ID"
  POSSIBLE_PATHS=(
    "ios/build/*.ipa"
    "build/*.ipa"
    "dist/*.ipa"
    ".expo/*.ipa"
    "*.ipa"
  )
else
  echo "Unsupported platform: $EAS_BUILD_PLATFORM"
  exit 1
fi

# Locate the build file
BUILD_FILE=""
for pattern in "${POSSIBLE_PATHS[@]}"; do
  echo "Checking: $pattern"
  for file in $pattern; do
    if [ -f "$file" ]; then
      BUILD_FILE="$file"
      echo "Found build file: $BUILD_FILE"
      break 2
    fi
  done
done

if [ -z "$BUILD_FILE" ]; then
  echo "Build file not found. Searched in:"
  printf '%s\n' "${POSSIBLE_PATHS[@]}"
  exit 1
fi

echo "Found build file: $BUILD_FILE"
ls -lh "$BUILD_FILE"

# Confirm Firebase access
firebase projects:list --project "$FIREBASE_PROJECT_ID" || {
  echo "Firebase authentication failed"
  exit 1
}

# Read release notes from file if exists
RELEASE_NOTES="Preview build from EAS - $(date)"
if [ -f "release_notes/preview.txt" ]; then
  RELEASE_NOTES=$(cat "release_notes/preview.txt")
  echo "Using release notes from file: release_notes/preview.txt"
else
  echo "No release notes file found, using default message"
fi

# Upload to Firebase App Distribution
firebase appdistribution:distribute "$BUILD_FILE" \
  --app "$APP_ID" \
  --groups "testers" \
  --release-notes "$RELEASE_NOTES" \
  --project "$FIREBASE_PROJECT_ID" || {
  echo "Upload failed"
  exit 1
}

echo "Upload to Firebase App Distribution completed successfully."
rm -f /tmp/firebase-key.json
```

**Örnek release_notes/preview.txt:**
```txt
- Remove pglite-debug.log
- Remove auto-upload_guide.md
- expo auto upload test branch eas.json update
- app.json fix
- updt
```

## 2) package.json'da Upload Script'i Tanımla

Build tamamlandığında Firebase'e otomatik yükleme tetiklenmesi için `scripts` kısmı altına package.json dosyasına şu satır eklenir:

```json
{
  "scripts": {
    "eas-build-on-success": "bash scripts/upload-to-firebase.sh"
  }
}
```

## 3) Service Account Key Dosyası Edinme (firebase-key.json)

Firebase App Distribution'a yükleme yapabilmek için bir Service Account oluşturulmalı ve JSON key dosyası alınmalıdır.

1. **Google Cloud Console'a git:** https://console.cloud.google.com/
2. **Üst menüden** ilgili Firebase projesine bağlı Google Cloud projesini seç.
3. **Sol menüden** IAM & Admin → Service Accounts bölümüne gir.
4. **Yeni bir Service Account oluştur** ya da mevcut olanı seç.
5. **Rol (Role):** Firebase App Distribution Admin veya Editor + Firebase App Distribution Admin
6. **Service Account detayına gir** → Keys sekmesine geç → Add Key → Create New Key → JSON seç.
7. **İndirilen JSON dosyası** senin firebase-key.json dosyandır.

Bu dosyanın içeriğini repo'ya ekleme, gizli tut.

## 4) Gerekli Expo/EAS Environment Variable'ları

- `AXON_AI_FIREBASE_SERVICE_ACCOUNT_KEY` → Service Account JSON içeriği (tam JSON)
- `FIREBASE_PROJECT_ID` → Firebase proje ID
- `FIREBASE_ANDROID_APP_ID` → Android app ID (Android build için)
- `FIREBASE_IOS_APP_ID` → iOS app ID (iOS build için)

```bash
eas secret:create --name AXON_AI_FIREBASE_SERVICE_ACCOUNT_KEY --value "$(cat firebase-key.json)" --type plain
eas secret:create --name FIREBASE_PROJECT_ID --value "axon-d12fb" --type plain
eas secret:create --name FIREBASE_IOS_APP_ID --value "1:349966891648:ios:fa167fe77f4655d5294465" --platform ios
eas secret:create --name FIREBASE_ANDROID_APP_ID --value "1:349966891648:android:54e01a186e9557fd294465" --platform android
```

`FIREBASE_PROJECT_ID`, `FIREBASE_IOS_APP_ID`, `FIREBASE_ANDROID_APP_ID` değerlerini Firebase Console'da proje ayarları sayfasından bulabilirsiniz.

**Kaydedilen tüm secret'ları görmek için:**
```bash
eas secret:list
```

## 5) Çalışma Mantığı

1. Script yalnızca `EAS_BUILD_PROFILE=preview` olduğunda çalışır.
2. Build çıktısını bulur (APK/IPA; gerekirse AAB).
3. `release_notes/preview.txt` varsa onun içeriğini release notu olarak gönderir, eğer yoksa dosya bulunamazsa, script otomatik olarak bir fallback (yedek) mesaj üretip release notes alanına bunu koyar.
4. Firebase App Distribution'a yükler.
