#!/usr/bin/env python3
"""Convert MP4 uploads in stickers/ to GIFs (run by .github/workflows/convert-mp4.yml).

The gallery lets users upload MP4 (e.g. X "GIFs" are really MP4). This script
converts each new .mp4 under stickers/ to a GIF, deletes the .mp4, and updates
the matching index.json entry (file -> .gif, format -> gif, converting flag
removed). The entry keeps its original md5 (the MP4's md5) so re-uploading
the same MP4 is still caught as a duplicate by the gallery's dedup check.
"""
import hashlib
import json
import os
import subprocess
import sys
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STICKERS = os.path.join(ROOT, "stickers")
INDEX = os.path.join(ROOT, "index.json")
MAX_GIF_BYTES = 25 * 1024 * 1024


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def gif_dims(path):
    code, out, _ = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path,
    ])
    if code != 0:
        return None
    try:
        w, h = out.strip().split("x")
        return int(w), int(h)
    except ValueError:
        return None


def convert(mp4_path, gif_path):
    """Try 480px/15fps first, fall back to 320px/10fps if the GIF is too big."""
    attempts = [
        "fps=15,scale=480:-1:flags=lanczos",
        "fps=10,scale=320:-1:flags=lanczos",
    ]
    for filters in attempts:
        vf = filters + ",split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse"
        code, _out, err = run(["ffmpeg", "-y", "-i", mp4_path, "-vf", vf, gif_path])
        if code != 0:
            print(f"  ffmpeg failed for {mp4_path}: {err.strip()[-300:]}")
            return False
        size = os.path.getsize(gif_path)
        print(f"  gif {os.path.basename(gif_path)}: {size / 1048576:.2f} MB")
        if size <= MAX_GIF_BYTES:
            return True
        print("  too big (>25MB), retrying smaller...")
    return False


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    mp4s = []
    for dirpath, _dirs, files in os.walk(STICKERS):
        for name in files:
            if name.lower().endswith(".mp4"):
                mp4s.append(os.path.join(dirpath, name))
    if not mp4s:
        print("no mp4 files found, nothing to do")
        return 0

    with open(INDEX, encoding="utf-8") as f:
        index = json.load(f)
    items = index.get("items", [])
    by_file = {it.get("file"): it for it in items}

    today = date.today().isoformat()
    changed = False
    for mp4_path in sorted(mp4s):
        rel_mp4 = os.path.relpath(mp4_path, ROOT).replace(os.sep, "/")
        gif_path = mp4_path[:-4] + ".gif"
        rel_gif = rel_mp4[:-4] + ".gif"
        print(f"converting {rel_mp4} ...")
        if not convert(mp4_path, gif_path):
            print(f"  FAILED, keeping {rel_mp4} as-is")
            continue
        dims = gif_dims(gif_path)
        entry = by_file.get(rel_mp4)
        if entry is None:
            # No index entry (mp4 pushed directly): create a minimal one.
            filename = os.path.basename(mp4_path)[:-4]
            parts = rel_mp4.split("/")
            char = parts[1] if len(parts) > 1 else ""
            thumb_path = f"thumbs/{char}/{filename}.jpg"
            entry = {
                "id": filename, "file": rel_gif,
                "character": char, "tags": [char] if char else [],
                "source": "mp4-convert", "added": today,
                "format": "gif", "width": dims[0] if dims else 0,
                "height": dims[1] if dims else 0,
                "animated": True, "md5": md5_of(gif_path),
            }
            if os.path.exists(os.path.join(ROOT, thumb_path)):
                entry["thumb"] = thumb_path
            items.append(entry)
            by_file[rel_gif] = entry
            print(f"  created new index entry {filename}")
        else:
            entry["file"] = rel_gif
            entry["format"] = "gif"
            entry.pop("converting", None)
            if dims:
                entry["width"], entry["height"] = dims
            print(f"  updated index entry {entry.get('id')}")
        os.remove(mp4_path)
        changed = True

    if changed:
        index["items"] = items
        index["count"] = len(items)
        index["updated"] = today
        with open(INDEX, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"index.json updated ({len(items)} items)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
