import os
import sys
import json
import time
from camoufox.sync_api import Camoufox

STATE_FILE = ".kaigobiz-worker-state.json"
COMMAND_FILE = ".kaigobiz-worker-command.json"
SESSION_FILE = ".kaigobiz-session.json"

def write_state(state):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except Exception:
        pass

def read_command():
    if os.path.exists(COMMAND_FILE):
        try:
            with open(COMMAND_FILE, "r") as f:
                return json.load(f)
        except Exception:
            return None
    return None

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 camoufox_gobiz_worker.py <phone>")
        sys.exit(1)

    phone = sys.argv[1]
    formatted_phone = phone.replace("+62", "").replace("62", "").lstrip("0")
    full_phone = f"0{formatted_phone}"
    profile_dir = os.path.join(os.getcwd(), ".camoufox-profile")
    os.makedirs(profile_dir, exist_ok=True)

    if os.path.exists(COMMAND_FILE):
        try:
            os.remove(COMMAND_FILE)
        except Exception:
            pass

    write_state({"status": "starting", "pid": os.getpid(), "phone": full_phone})

    session_data = {}

    with Camoufox(headless=True, persistent_context=True, user_data_dir=profile_dir) as context:
        page = context.pages[0] if context.pages else context.new_page()

        def handle_response(response):
            nonlocal session_data
            if "/goid/token" in response.url and response.status == 200:
                try:
                    res_json = response.json()
                    data = res_json.get("data", res_json)
                    if data.get("access_token"):
                        session_data = {
                            "phone_number": f"62{formatted_phone}",
                            "access_token": data["access_token"],
                            "refresh_token": data.get("refresh_token", ""),
                            "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400)),
                            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                        }
                        with open(SESSION_FILE, "w") as f:
                            json.dump(session_data, f, indent=2)
                except Exception:
                    pass

        page.on("response", handle_response)

        # 1. Navigate to login
        try:
            page.goto("https://portal.gofoodmerchant.co.id/auth/login", wait_until="networkidle", timeout=20000)
        except Exception:
            pass

        # Close cookies popup if present
        try:
            cookie_btn = page.query_selector("#onetrust-accept-btn-handler")
            if cookie_btn:
                cookie_btn.click()
                time.sleep(0.5)
        except Exception:
            pass

        # Fill phone
        try:
            page.wait_for_selector("input[name='phone']", timeout=12000)
            page.fill("input[name='phone']", full_phone)
            time.sleep(0.5)
            lanjut_btn = page.query_selector("button:has-text('Lanjut')")
            if lanjut_btn:
                lanjut_btn.click()
        except Exception as e:
            write_state({"status": "error", "message": f"Gagal mengisi nomor telepon: {str(e)}"})
            page.screenshot(path="gobiz-login-error.png")
            return

        # Wait for OTP input to appear
        try:
            page.wait_for_selector("#auth-otp-input, input[name='otp']", timeout=15000)
            time.sleep(1)
            write_state({"status": "otp_sent", "pid": os.getpid(), "phone": full_phone})
            page.screenshot(path="gobiz-otp-sent.png")
            print("OTP_SENT_READY")
            sys.stdout.flush()
        except Exception as e:
            error_el = page.query_selector("[role='alert'], .error, .sc-fznZeY")
            msg = error_el.inner_text() if error_el else str(e)
            write_state({"status": "error", "message": f"Gagal meminta OTP: {msg}"})
            page.screenshot(path="gobiz-login-error.png")
            return

        # 2. Wait for OTP submission command from Node backend
        start_wait = time.time()
        otp_received = None
        while time.time() - start_wait < 180:
            cmd = read_command()
            if cmd and cmd.get("otp"):
                otp_received = str(cmd.get("otp")).strip()
                break
            time.sleep(0.5)

        if not otp_received:
            write_state({"status": "error", "message": "Waktu verifikasi OTP habis (timeout 3 menit)"})
            return

        write_state({"status": "verifying", "otp": otp_received})

        # 3. Enter OTP and verify
        try:
            otp_input = page.query_selector("#auth-otp-input, input[name='otp']")
            if not otp_input:
                otp_inputs = page.query_selector_all("input")
                if otp_inputs:
                    otp_input = otp_inputs[0]

            if otp_input:
                otp_input.click()
                time.sleep(0.2)
                otp_input.fill(otp_received)
                time.sleep(0.5)

            # Click verify button
            verify_btn = (
                page.query_selector("#verify-otp-button")
                or page.query_selector("button:has-text('Masuk')")
                or page.query_selector("button[type='submit']")
            )
            if verify_btn:
                verify_btn.click()
            else:
                page.keyboard.press("Enter")

            # Wait for response / navigation
            time.sleep(5)

            # Check if session captured via /goid/token response
            if session_data.get("access_token"):
                write_state({"status": "success", "session": session_data})
                page.screenshot(path="gobiz-login-success.png")
                print("LOGIN_SUCCESS")
                return

            # Check localStorage / cookies if response listener didn't catch it
            try:
                local_storage = page.evaluate("() => ({ ...localStorage })")
                cookies = context.cookies()
                token = None
                for k, v in local_storage.items():
                    if "token" in k.lower() or "auth" in k.lower():
                        try:
                            parsed = json.loads(v)
                            if isinstance(parsed, dict) and parsed.get("access_token"):
                                token = parsed.get("access_token")
                        except Exception:
                            pass
                for c in cookies:
                    if "token" in c.get("name", "").lower():
                        token = c.get("value")

                if token:
                    session_data = {
                        "phone_number": f"62{formatted_phone}",
                        "access_token": token,
                        "refresh_token": "",
                        "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400)),
                        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                    }
                    with open(SESSION_FILE, "w") as f:
                        json.dump(session_data, f, indent=2)
                    write_state({"status": "success", "session": session_data})
                    page.screenshot(path="gobiz-login-success.png")
                    return
            except Exception:
                pass

            # Check for error on page (e.g. wrong OTP)
            err_el = page.query_selector("[role='alert'], .error, .sc-fznZeY, .toast")
            err_text = err_el.inner_text() if err_el else "Kode OTP salah atau tidak valid"
            page.screenshot(path="gobiz-otp-error.png")
            write_state({"status": "error", "message": err_text})

        except Exception as e:
            page.screenshot(path="gobiz-otp-error.png")
            write_state({"status": "error", "message": f"Kesalahan verifikasi OTP: {str(e)}"})

if __name__ == "__main__":
    main()
