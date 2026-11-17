#!/usr/bin/env bash
# Builds dist/ai-quota-meter-gnome-v<VERSION>.zip for extensions.gnome.org.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(tr -d '[:space:]' < "$root/VERSION")"
out="$root/dist"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cd "$root/gnome"
cp -r metadata.json extension.js prefs.js stylesheet.css lib icons "$stage/"
mkdir "$stage/schemas"
cp schemas/*.gschema.xml "$stage/schemas/"
# version-name is the user-visible version; EGO sets "version" itself.
python3 - "$stage/metadata.json" "$version" <<'PY'
import json, sys
p, v = sys.argv[1], sys.argv[2]
m = json.load(open(p))
m["version-name"] = v
m.pop("version", None)
open(p, "w").write(json.dumps(m, indent=2, ensure_ascii=False) + "\n")
PY
mkdir -p "$out"
zip_path="$out/ai-quota-meter-gnome-v$version.zip"
rm -f "$zip_path"
(cd "$stage" && zip -qr "$zip_path" .)
echo "$zip_path"
