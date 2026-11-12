#!/usr/bin/env python3
"""Screenshots of the dashboard (web/market.html), served from web/ by a throwaway local server.

usage: python3 scripts/shoot.py OUT_DIR
Writes dashboard.png (full page) and report.png (a grade report dialog).
"""
import functools
import http.server
import pathlib
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent / "web"
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "assets")
out.mkdir(parents=True, exist_ok=True)

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
handler.log_message = lambda *a: None
srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}/"

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1400, "height": 900}, device_scale_factor=2)
    # The recorded run is the one the README describes.
    pg.goto(base + "market.html?contract=market.credster-68480.testnet")
    pg.wait_for_selector(".srow", timeout=30000)
    pg.wait_for_timeout(800)
    pg.screenshot(path=str(out / "dashboard.png"), full_page=True)
    pg.screenshot(path=str(out / "dashboard-top.png"))
    for label in sys.argv[2:] or ["F"]:
        if pg.locator("details.off-list:not([open])").count():
            pg.click("details.off-list summary")
        btn = pg.locator(f".srow:has(.hm-{label}) [data-rep]").first
        btn.click()
        pg.wait_for_selector(".m-hash", timeout=30000)
        pg.wait_for_timeout(500)
        pg.locator("dialog[data-report]").screenshot(path=str(out / f"report-{label}.png"))
        pg.keyboard.press("Escape")
    b.close()
srv.shutdown()
print("wrote", out)
