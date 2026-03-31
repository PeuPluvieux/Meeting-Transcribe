"""
Live Captions Bridge - WebSocket server that reads from Windows 11 Live Captions
and streams caption text to the Meeting Notes AI web app.

Usage:
    python caption_bridge.py

Requirements:
    pip install "uiautomation>=2.0.27" "websockets>=14.0"

How it works:
    1. Finds the Windows Live Captions window via UI Automation (auto-launches if needed)
    2. Minimizes the Live Captions window so it doesn't clutter the screen
    3. Reads the CaptionsTextBlock element every ~100ms
    4. Detects new text and sends it to connected WebSocket clients
    5. Web app connects to ws://localhost:8765 to receive captions
"""

import asyncio
import json
import subprocess
import sys
import time
import os
import ctypes

# Auto-install dependencies if missing
def ensure_dependency(package, import_name=None):
    try:
        __import__(import_name or package)
    except ImportError:
        print(f"Installing {package}...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", package],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"  {package} installed.")

ensure_dependency("uiautomation")
ensure_dependency("websockets")

import uiautomation as auto
import websockets

# ─── Configuration ────────────────────────────────────────────────────────────
WS_HOST = "localhost"
WS_PORT = 8765
POLL_INTERVAL = 0.10       # 100ms — reliable and low CPU
RECONNECT_DELAY = 3        # seconds between reconnect attempts
MAX_RECONNECT_TRIES = 20   # before giving up on a lost element

# ─── Global State ─────────────────────────────────────────────────────────────
clients: set = set()
last_full_text = ""
caption_element = None
is_connected = False

# ─── UI Automation helpers ────────────────────────────────────────────────────

def find_live_captions_window():
    """Find the Live Captions window. Returns the AutomationElement or None."""
    # Method 1: By known class name (Windows 11 22H2+)
    try:
        win = auto.WindowControl(ClassName="LiveCaptionsDesktopWindow", searchDepth=1)
        if win.Exists(0, 0):
            return win
    except Exception:
        pass

    # Method 2: By window name (fallback)
    for name in ["Live Captions", "Live captions"]:
        try:
            win = auto.WindowControl(Name=name, searchDepth=1)
            if win.Exists(0, 0):
                return win
        except Exception:
            pass

    return None


def find_caption_text_block(window):
    """Locate the CaptionsTextBlock element inside the Live Captions window."""
    global caption_element

    # Direct search by AutomationId
    try:
        el = window.TextControl(AutomationId="CaptionsTextBlock")
        if el.Exists(0, 0):
            caption_element = el
            return el
    except Exception:
        pass

    # Recursive search (slower, but covers edge cases)
    try:
        def search(parent, depth=0):
            if depth > 8:
                return None
            for child in parent.GetChildren():
                if getattr(child, "AutomationId", "") == "CaptionsTextBlock":
                    return child
                found = search(child, depth + 1)
                if found:
                    return found
            return None

        el = search(window)
        if el:
            caption_element = el
            return el
    except Exception:
        pass

    return None


def minimize_live_captions_window(window):
    """Minimize the Live Captions window so it doesn't clutter the screen.
    UIA reads continue to work even when the window is minimized."""
    try:
        hwnd = window.NativeWindowHandle
        if hwnd:
            SW_MINIMIZE = 6
            ctypes.windll.user32.ShowWindow(hwnd, SW_MINIMIZE)
            print("  ✓ Live Captions window minimized")
    except Exception as e:
        print(f"  Could not minimize Live Captions window: {e}")


def get_caption_text() -> str | None:
    """Read the current text from the CaptionsTextBlock. Returns None on error."""
    global caption_element
    try:
        if caption_element and caption_element.Exists(0, 0):
            return caption_element.Name or ""
    except Exception:
        caption_element = None
    return None


def enable_live_captions_registry():
    """Enable Live Captions and microphone audio via Windows registry."""
    import winreg
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                             r"Software\Microsoft\Accessibility", 0,
                             winreg.KEY_SET_VALUE)
        winreg.SetValueEx(key, "IsLiveCaptionsEnabled", 0, winreg.REG_DWORD, 1)
        winreg.SetValueEx(key, "IsLiveCaptionsMicrophoneEnabled", 0, winreg.REG_DWORD, 1)
        winreg.CloseKey(key)
        print("  ✓ Live Captions enabled via registry")
        return True
    except Exception as e:
        print(f"  Registry method failed: {e}")
        return False


def launch_live_captions():
    """Try to launch Windows Live Captions automatically."""
    print("  Attempting to launch Live Captions...")

    # Step 1: Enable via registry first
    enable_live_captions_registry()

    # Step 2: Try direct executable launch — System32 is the confirmed primary path
    exe_paths = [
        r"C:\Windows\System32\LiveCaptions.exe",  # Primary — confirmed working on Win11 22H2+
        os.path.expandvars(r"%SYSTEMROOT%\SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\LiveCaptions.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WindowsApps\LiveCaptions.exe"),
    ]
    for exe in exe_paths:
        if os.path.exists(exe):
            try:
                subprocess.Popen([exe], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                print(f"  ✓ Launched Live Captions from {os.path.basename(exe)}")
                time.sleep(3)
                win = find_live_captions_window()
                if win:
                    return win
            except Exception:
                pass

    # Step 3: Try Win+Ctrl+L hotkey via PowerShell
    try:
        subprocess.Popen(
            'powershell -Command "Add-Type -AssemblyName System.Windows.Forms; '
            '[System.Windows.Forms.SendKeys]::SendWait(\'^(%l)\')"',
            shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        time.sleep(3)
        win = find_live_captions_window()
        if win:
            print("  ✓ Launched via Win+Ctrl+L hotkey")
            return win
    except Exception:
        pass

    # Step 4: Last resort — open accessibility settings
    try:
        os.system('start ms-settings:easeofaccess-livecaptions >nul 2>&1')
        print("  ⚠ Opened Live Captions settings — please enable it manually")
        time.sleep(4)
    except Exception:
        pass

    return find_live_captions_window()


# ─── Text diffing ─────────────────────────────────────────────────────────────

def extract_new_text(old: str, new: str) -> str:
    """Extract only the newly added portion of the caption text."""
    if not old:
        return new.strip()

    # Case 1: New text extends old text (most common)
    if new.startswith(old):
        return new[len(old):].strip()

    # Case 2: Find the longest suffix of `old` that is a prefix of `new`
    # This handles when the top line scrolls away
    best = 0
    for i in range(1, min(len(old), len(new)) + 1):
        if old[-i:] == new[:i]:
            best = i
    if best > 5:  # Require reasonable overlap
        return new[best:].strip()

    # Case 3: Completely different text (new sentence)
    return new.strip()


# ─── WebSocket server ─────────────────────────────────────────────────────────

async def broadcast(message: dict):
    """Send a JSON message to all connected clients."""
    if not clients:
        return
    payload = json.dumps(message)
    disconnected = set()
    for ws in clients:
        try:
            await ws.send(payload)
        except Exception:
            disconnected.add(ws)
    clients.difference_update(disconnected)


async def ws_handler(websocket):
    """Handle a WebSocket connection from the web app."""
    clients.add(websocket)
    remote = websocket.remote_address
    print(f"  [+] Client connected from {remote[0]}:{remote[1]}  ({len(clients)} total)")

    await websocket.send(json.dumps({
        "type": "status",
        "connected": is_connected,
        "message": "Bridge connected." + (" Live Captions active." if is_connected else " Searching for Live Captions...")
    }))

    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    await websocket.send(json.dumps({"type": "pong"}))
            except json.JSONDecodeError:
                pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        clients.discard(websocket)
        print(f"  [-] Client disconnected  ({len(clients)} total)")


# ─── Caption polling loop ─────────────────────────────────────────────────────

async def poll_captions():
    """Main polling loop: find Live Captions, read text, broadcast changes."""
    global last_full_text, caption_element, is_connected

    while True:
        # ── Phase 1: Find the Live Captions window ──
        print("\n  Looking for Live Captions window...")
        window = find_live_captions_window()

        if not window:
            print("  Live Captions not found. Trying to launch it...")
            window = launch_live_captions()

        if not window:
            is_connected = False
            await broadcast({
                "type": "status",
                "connected": False,
                "message": "Live Captions not found. Enable it in Windows Settings > Accessibility > Captions."
            })
            print("  Could not find Live Captions. Retrying in 5 seconds...")
            print("  Tip: Open Windows Settings > Accessibility > Captions > Live Captions")
            await asyncio.sleep(5)
            continue

        print("  Found Live Captions window!")

        # ── Phase 2: Find the caption text element BEFORE minimizing ──
        # Must find the element while visible — minimizing first can break UIA discovery
        text_block = find_caption_text_block(window)
        if not text_block:
            is_connected = False
            await broadcast({
                "type": "status",
                "connected": False,
                "message": "Found Live Captions window but cannot read captions. Try restarting Live Captions."
            })
            print("  Could not find CaptionsTextBlock. Retrying...")
            await asyncio.sleep(RECONNECT_DELAY)
            continue

        # Minimize now that we have the element reference — UIA reads still work minimized
        minimize_live_captions_window(window)

        # ── Phase 3: Start reading captions ──
        is_connected = True
        last_full_text = ""
        miss_count = 0

        print("  Connected to Live Captions! Streaming captions to web app...")
        print("  (Speak into your microphone or play meeting audio — text will appear in the web app)")
        print()

        await broadcast({
            "type": "status",
            "connected": True,
            "message": "Connected to Live Captions. Ready to transcribe."
        })

        while True:
            text = get_caption_text()

            if text is None:
                miss_count += 1
                if miss_count > MAX_RECONNECT_TRIES:
                    print("  Lost connection to Live Captions element. Reconnecting...")
                    is_connected = False
                    caption_element = None
                    await broadcast({
                        "type": "status",
                        "connected": False,
                        "message": "Lost connection to Live Captions. Reconnecting..."
                    })
                    break
                await asyncio.sleep(POLL_INTERVAL)
                continue

            miss_count = 0

            if text and text != last_full_text:
                new_text = extract_new_text(last_full_text, text)
                if new_text:
                    await broadcast({
                        "type": "caption",
                        "text": new_text,
                        "fullText": text,
                        "timestamp": time.time()
                    })
                last_full_text = text

            await asyncio.sleep(POLL_INTERVAL)

        # If we break out of the inner loop, wait before reconnecting
        await asyncio.sleep(RECONNECT_DELAY)


# ─── Main entry point ─────────────────────────────────────────────────────────

async def main():
    print("=" * 60)
    print("  Live Captions Bridge for Meeting Notes AI v6.0")
    print("=" * 60)
    print(f"  WebSocket server: ws://{WS_HOST}:{WS_PORT}")
    print(f"  Poll interval:    {int(POLL_INTERVAL * 1000)}ms")
    print()

    # Auto-enable Live Captions before starting
    print("  Auto-configuring Live Captions...")
    enable_live_captions_registry()

    print()
    print("  Everything is automatic — just start speaking!")
    print("  Press Ctrl+C to stop the bridge.")
    print("=" * 60)
    print()

    # Start WebSocket server (websockets 14+ compatible)
    server = await websockets.serve(ws_handler, WS_HOST, WS_PORT)
    try:
        await poll_captions()
    finally:
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  Bridge stopped. Goodbye!")
        sys.exit(0)
