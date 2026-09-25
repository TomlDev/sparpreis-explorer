#!/usr/bin/env python3
"""
TLS-impersonating transport for the Deutsche Bahn API.

Akamai blocks Node.js / plain-curl by TLS fingerprint (HTTP 452 OPS_BLOCKED),
regardless of IP. curl_cffi presents a real browser TLS fingerprint, which the
DB mobile API accepts. This helper reads one request as JSON from stdin and
writes {status, body} as JSON to stdout. It performs no logic of its own — the
Node side (db-vendo-client) builds the request and parses the response.

Input  (stdin):  {"method","url","headers":{...},"body":"...","impersonate":"chrome"}
Output (stdout): {"status": <int>, "body": "<text>"}  or  {"status":0,"error":"..."}
"""
import json
import sys

STRIP = {"user-agent", "accept-encoding", "content-length", "host", "connection"}


def main() -> None:
    try:
        req = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"status": 0, "error": f"bad input: {e}"}))
        return
    try:
        from curl_cffi import requests
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"status": 0, "error": f"curl_cffi missing: {e}"}))
        return

    headers = {
        k: v
        for k, v in (req.get("headers") or {}).items()
        if k.lower() not in STRIP
    }
    method = (req.get("method") or "GET").upper()
    url = req["url"]
    body = req.get("body")
    if isinstance(body, str):
        body = body.encode("utf-8")

    try:
        r = requests.request(
            method,
            url,
            headers=headers,
            data=body,
            impersonate=req.get("impersonate", "chrome"),
            timeout=req.get("timeout", 30),
        )
        sys.stdout.write(json.dumps({"status": r.status_code, "body": r.text}))
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"status": 0, "error": str(e)}))


if __name__ == "__main__":
    main()
