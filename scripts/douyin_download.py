#!/usr/bin/env python3
"""
Download a Douyin video to a local MP4 file.

Supported input:
- short URL: https://v.douyin.com/xxxxx/
- share text containing a Douyin URL
- direct video URL: https://www.douyin.com/video/1234567890
"""

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
OFFICIAL_VIDEO_HOST_SUFFIXES = (".douyinvod.com", ".douyin.com", ".snssdk.com")


def extract_url(text: str) -> str:
    match = re.search(
        r"https?://(?:[a-z0-9-]+\.)*(?:douyin\.com|iesdouyin\.com)/[^\s\])}>\"']+",
        text,
        re.IGNORECASE,
    )
    if not match:
        match = re.search(r"https?://[^\s\])}>\"']+", text)
    if not match:
        raise ValueError("No URL found in Douyin input")
    return match.group(0).rstrip(".,;:!?")


def resolve_short_url(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": MOBILE_UA})
    try:
        response = urllib.request.urlopen(request, timeout=10)
        return response.url
    except urllib.error.HTTPError as error:
        return error.url or url


def extract_video_id(url: str) -> str:
    match = re.search(r"/video/(\d+)", url)
    if not match:
        raise ValueError(f"Could not extract Douyin video id from URL: {url}")
    return match.group(1)


def get_legacy_play_uri(video_id: str) -> tuple[str, str]:
    share_url = f"https://www.iesdouyin.com/share/video/{video_id}/"
    request = urllib.request.Request(
        share_url,
        headers={
            "User-Agent": MOBILE_UA,
            "Referer": "https://www.douyin.com/",
        },
    )
    response = urllib.request.urlopen(request, timeout=15)
    html = response.read().decode("utf-8", errors="ignore")

    match = re.search(r"window\._ROUTER_DATA\s*=\s*(\{.+?\})\s*</script>", html, re.DOTALL)
    if not match:
        raise ValueError("Could not find _ROUTER_DATA; the video may require login or be unavailable")

    data = json.loads(match.group(1))
    items = find_item_list(data)
    if not items:
        raise ValueError("Could not find Douyin video metadata")

    item = items[0]
    title = item.get("desc", video_id)[:50]
    aweme_type = item.get("aweme_type")
    video = item.get("video", {})
    play_addr = video.get("play_addr", {})
    uri = play_addr.get("uri", "")
    if not uri:
        raise ValueError(f"No playable video URI found; aweme_type={aweme_type}. Image posts are not supported.")
    return uri, title


def get_browser_play_urls(video_id: str) -> tuple[list[str], str, dict]:
    script = os.environ.get(
        "OKF_DOUYIN_BROWSER_RESOLVER_SCRIPT",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "douyin_browser_resolve.js"),
    )
    node = os.environ.get("OKF_NODE_EXECUTABLE", "node")
    timeout = positive_integer(os.environ.get("OKF_DOUYIN_BROWSER_TIMEOUT_SECONDS"), 90)
    try:
        completed = subprocess.run(
            [node, script, video_id],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as error:
        raise RuntimeError(
            "Node.js is required for the current Douyin browser fallback but was not found"
        ) from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"Douyin browser resolver timed out after {timeout}s") from error

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "unknown browser resolver error").strip()
        raise RuntimeError(detail)

    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("Douyin browser resolver returned no result")
    try:
        result = json.loads(lines[-1])
    except json.JSONDecodeError as error:
        raise RuntimeError("Douyin browser resolver returned invalid JSON") from error

    if str(result.get("video_id", "")) != video_id:
        raise RuntimeError("Douyin browser resolver returned a mismatched video id")
    play_urls = result.get("play_urls") or [result.get("play_url")]
    play_urls = [str(url) for url in play_urls if url]
    if not play_urls:
        raise RuntimeError("Douyin browser resolver returned no playable URL")
    for play_url in play_urls:
        validate_official_play_url(play_url)
    return play_urls, str(result.get("title") or video_id), result


def get_play_source(video_id: str) -> tuple[list[str], str, str, dict]:
    legacy_error = None
    try:
        uri, title = get_legacy_play_uri(video_id)
        return [uri], title, "legacy-router-data", {}
    except Exception as error:  # The official page fallback also covers a retired share endpoint.
        legacy_error = error

    try:
        play_urls, title, metadata = get_browser_play_urls(video_id)
        return play_urls, title, "douyin-official-browser-api", metadata
    except Exception as browser_error:
        raise RuntimeError(
            f"Legacy Douyin metadata failed ({legacy_error}); browser fallback failed ({browser_error})"
        ) from browser_error


def find_item_list(value, depth=0):
    if depth > 10:
        return None
    if isinstance(value, dict):
        if "item_list" in value:
            return value["item_list"]
        for child in value.values():
            result = find_item_list(child, depth + 1)
            if result:
                return result
    if isinstance(value, list):
        for item in value:
            result = find_item_list(item, depth + 1)
            if result:
                return result
    return None


def download_video(uris: list[str], output_path: str) -> str:
    errors = []
    for uri in uris:
        try:
            return download_video_from_uri(uri, output_path)
        except Exception as error:
            host = urllib.parse.urlparse(uri).hostname or "legacy-play-endpoint"
            errors.append(f"{host}: {error}")
    raise RuntimeError("All official Douyin video URLs failed: " + " | ".join(errors))


def download_video_from_uri(uri: str, output_path: str) -> str:
    if uri.startswith("http"):
        play_url = uri
    else:
        play_url = f"https://aweme.snssdk.com/aweme/v1/play/?video_id={uri}&ratio=720p&line=0"

    validate_official_play_url(play_url)
    request = urllib.request.Request(
        play_url,
        headers={
            "User-Agent": MOBILE_UA,
            "Referer": "https://www.douyin.com/",
            "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.8",
        },
    )
    partial_path = f"{output_path}.part"
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    try:
        with urllib.request.urlopen(request, timeout=60) as response, open(partial_path, "wb") as file:
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                file.write(chunk)
        validate_mp4(partial_path)
        os.replace(partial_path, output_path)
    except Exception:
        if os.path.exists(partial_path):
            os.remove(partial_path)
        raise
    return play_url


def validate_official_play_url(play_url: str) -> None:
    parsed = urllib.parse.urlparse(play_url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not any(
        host == suffix[1:] or host.endswith(suffix) for suffix in OFFICIAL_VIDEO_HOST_SUFFIXES
    ):
        raise ValueError(f"Rejected non-official Douyin play URL host: {host or 'empty'}")


def validate_mp4(file_path: str) -> None:
    size = os.path.getsize(file_path)
    if size < 1024:
        raise ValueError(f"Downloaded file is too small to be a video: {size} bytes")
    with open(file_path, "rb") as file:
        header = file.read(64)
    if b"ftyp" not in header[:32] and b"styp" not in header[:32]:
        raise ValueError("Downloaded response is not an MP4 file")


def positive_integer(value, fallback: int) -> int:
    try:
        parsed = int(str(value or ""))
        return parsed if parsed > 0 else fallback
    except ValueError:
        return fallback


def sanitize_filename(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]', "_", name).strip()
    return name or "video"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    input_text = sys.argv[1]
    output_arg = sys.argv[2] if len(sys.argv) > 2 else None
    url = extract_url(input_text)
    if urllib.parse.urlparse(url).hostname == "v.douyin.com":
        url = resolve_short_url(url)
    video_id = extract_video_id(url)
    uris, title, source, metadata = get_play_source(video_id)
    output_path = output_arg or f"{sanitize_filename(title)}.mp4"
    play_url = download_video(uris, output_path)
    size_mb = os.path.getsize(output_path) / 1024 / 1024
    print(json.dumps({
        "ok": True,
        "file": output_path,
        "title": title,
        "video_id": video_id,
        "source": source,
        "play_url": play_url,
        "size_mb": round(size_mb, 2),
        "duration_ms": metadata.get("duration_ms"),
        "width": metadata.get("width"),
        "height": metadata.get("height"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
