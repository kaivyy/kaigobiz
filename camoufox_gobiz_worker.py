import argparse
import base64
import json
import os
import re
import sys
import time
import uuid
from typing import Optional
from camoufox.sync_api import Camoufox

DEFAULT_STATE_FILE = ".kaigobiz-worker-state.json"
DEFAULT_COMMAND_FILE = ".kaigobiz-worker-command.json"
COOKIE_DOMAIN_FILTERS = ("gofoodmerchant.co.id", "gobiz.co.id", "gojekapi.com")


def format_id_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone.strip())
    digits = re.sub(r"^(?:62|0)+", "", digits)
    return f"0{digits}" if digits else ""


def parse_jwt_expiry(token: str) -> tuple[Optional[int], Optional[int]]:
    if not token or not isinstance(token, str):
        return None, None
    parts = token.split(".")
    if len(parts) != 3 or not parts[1]:
        return None, None
    try:
        segment = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
        payload = json.loads(base64.urlsafe_b64decode(segment.encode("utf-8")).decode("utf-8"))
        if not isinstance(payload, dict):
            return None, None
        exp = int(payload["exp"]) if isinstance(payload.get("exp"), (int, float)) else None
        iat = int(payload["iat"]) if isinstance(payload.get("iat"), (int, float)) else None
        return exp, iat
    except Exception:
        return None, None


def compute_expiry_fields(access_token: str, expires_in: Optional[int]) -> tuple[str, int]:
    now = time.time()
    exp, iat = parse_jwt_expiry(access_token)
    if exp is not None and exp > now - 60:
        ttl = (exp - iat) if (iat is not None and exp > iat) else max(60, int(exp - now))
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp)), max(60, int(ttl))

    if isinstance(expires_in, (int, float)) and expires_in > 0:
        ttl = max(60, int(expires_in))
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + ttl)), ttl

    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 86400)), 86400


def is_jwt_expired(token: str) -> bool:
    exp, _ = parse_jwt_expiry(token)
    if exp is None:
        return False
    return exp <= time.time()


def build_cookie_header(cookies: list, access_token: str, refresh_token: str) -> tuple[str, dict]:
    cookie_map = {}
    for c in cookies or []:
        domain = str(c.get("domain", "")).lower()
        name = c.get("name")
        value = c.get("value")
        if not name or value is None:
            continue
        if any(f in domain for f in COOKIE_DOMAIN_FILTERS) or not domain:
            cookie_map[name] = str(value)

    if access_token:
        cookie_map["access_token"] = access_token
    if refresh_token:
        cookie_map["refresh_token"] = refresh_token
    if "auth_method" not in cookie_map:
        cookie_map["auth_method"] = "goid"

    header = "; ".join(f"{k}={v}" for k, v in cookie_map.items())
    return header, cookie_map


def extract_browser_session(context, page, intercepted: dict, fallback_phone: str) -> Optional[dict]:
    cookies = context.cookies()
    token_map = {c.get("name"): c.get("value") for c in cookies if c.get("name")}

    current_acc = intercepted.get("access_token") or token_map.get("access_token")
    current_ref = intercepted.get("refresh_token") or token_map.get("refresh_token") or ""
    expires_in = intercepted.get("expires_in")

    ls_browser_id = None
    try:
        local_storage = page.evaluate("() => ({ ...localStorage })")
        if isinstance(local_storage, dict):
            if not current_acc and local_storage.get("access_token"):
                current_acc = local_storage.get("access_token")
            if not current_ref and local_storage.get("refresh_token"):
                current_ref = local_storage.get("refresh_token")
            ls_browser_id = local_storage.get("browser_id")
            for k, v in local_storage.items():
                if not current_acc or not current_ref:
                    if "token" in k.lower() or "auth" in k.lower():
                        try:
                            parsed = json.loads(v)
                            if isinstance(parsed, dict):
                                if not current_acc and parsed.get("access_token"):
                                    current_acc = parsed.get("access_token")
                                if not current_ref and parsed.get("refresh_token"):
                                    current_ref = parsed.get("refresh_token")
                        except Exception:
                            pass
    except Exception:
        pass

    if not current_acc or is_jwt_expired(current_acc):
        return None

    cookie_header, cookie_map = build_cookie_header(cookies, current_acc, current_ref)
    raw_device_id = cookie_map.get("browser_id") or ls_browser_id or ""
    if raw_device_id and re.match(r"^[0-9a-fA-F-]{16,}$", str(raw_device_id)):
        device_id = str(raw_device_id)
    else:
        device_id = str(uuid.uuid4())

    ua = None
    try:
        ua = page.evaluate("() => navigator.userAgent")
    except Exception:
        ua = None

    expires_at, ttl_seconds = compute_expiry_fields(current_acc, expires_in)
    clean_digits = re.sub(r"^(?:62|0)+", "", re.sub(r"\D", "", fallback_phone or ""))
    phone_val = f"62{clean_digits}" if clean_digits else None

    session = {
        "access_token": current_acc,
        "refresh_token": current_ref,
        "cookie": cookie_header,
        "device_id": device_id,
        "expires_at": expires_at,
        "token_ttl_seconds": ttl_seconds,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if phone_val:
        session["phone_number"] = phone_val
    if ua:
        session["user_agent"] = ua
    return session


def write_state(state_file: str, state: dict) -> None:
    tmp_path = f"{state_file}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(state, f)
        try:
            os.chmod(tmp_path, 0o600)
        except Exception:
            pass
        os.replace(tmp_path, state_file)
    except Exception:
        pass


def read_and_consume_command(command_file: str):
    if os.path.exists(command_file):
        try:
            with open(command_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            try:
                os.remove(command_file)
            except Exception:
                pass
            return data
        except Exception:
            return None
    return None


def debug_screenshot(page, path: str) -> None:
    if os.environ.get("KAIGOBIZ_DEBUG_SCREENSHOTS") == "1":
        try:
            page.screenshot(path=path)
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="GoBiz Camoufox OTP and silent session worker")
    parser.add_argument("phone", nargs="?", default="")
    parser.add_argument("--phone", dest="phone_flag", default="")
    parser.add_argument("--state-file", default=DEFAULT_STATE_FILE)
    parser.add_argument("--command-file", default=DEFAULT_COMMAND_FILE)
    parser.add_argument("--refresh-only", action="store_true")
    args = parser.parse_args()

    state_file = args.state_file
    command_file = args.command_file
    raw_phone = args.phone_flag or args.phone or ""
    full_phone = format_id_phone(raw_phone)

    if not args.refresh_only and not full_phone:
        write_state(state_file, {"status": "error", "message": "Nomor handphone wajib diisi"})
        return

    profile_dir = os.path.join(os.getcwd(), ".camoufox-profile")
    os.makedirs(profile_dir, exist_ok=True)

    if not args.refresh_only and os.path.exists(command_file):
        try:
            os.remove(command_file)
        except Exception:
            pass

    write_state(state_file, {"status": "starting", "pid": os.getpid(), "phone": full_phone})
    intercepted = {}

    with Camoufox(headless=True, persistent_context=True, user_data_dir=profile_dir) as context:
        page = context.pages[0] if context.pages else context.new_page()

        def handle_response(response):
            if "/goid/token" in response.url and response.status == 200:
                try:
                    res_json = response.json()
                    data = res_json.get("data", res_json)
                    acc = data.get("access_token")
                    ref = data.get("refresh_token", "")
                    exp_in = data.get("expires_in")
                    for h_name, h_val in response.headers.items():
                        if h_name.lower() == "set-cookie" and "refresh_token=" in h_val:
                            try:
                                part = h_val.split("refresh_token=")[1].split(";")[0].strip()
                                if part:
                                    ref = part
                            except Exception:
                                pass
                    if acc:
                        intercepted["access_token"] = acc
                        intercepted["refresh_token"] = ref
                        if exp_in is not None:
                            intercepted["expires_in"] = exp_in
                except Exception:
                    pass

        page.on("response", handle_response)

        if args.refresh_only:
            try:
                page.goto("https://portal.gofoodmerchant.co.id/", wait_until="networkidle", timeout=20000)
            except Exception:
                pass
            # Allow portal SPA to run any background token refresh interceptor without submitting forms
            for _ in range(10):
                time.sleep(1)
                if "/auth/login" in page.url:
                    break
                if intercepted.get("access_token"):
                    break

            if "/auth/login" in page.url:
                write_state(state_file, {"status": "relogin_required", "message": "Sesi browser sudah logout atau kedaluwarsa"})
                return

            session = extract_browser_session(context, page, intercepted, raw_phone)
            if not session:
                write_state(state_file, {"status": "relogin_required", "message": "Token aktif tidak ditemukan di profil browser"})
                return

            write_state(state_file, {"status": "success", "session": session})
            return

        try:
            page.goto("https://portal.gofoodmerchant.co.id/auth/login", wait_until="networkidle", timeout=20000)
        except Exception:
            pass

        # Avoid sending SMS OTP if the persistent Camoufox profile already holds a valid session
        if "/auth/login" not in page.url:
            existing_session = extract_browser_session(context, page, intercepted, raw_phone)
            if existing_session:
                write_state(state_file, {"status": "already_authenticated", "session": existing_session})
                debug_screenshot(page, "gobiz-login-success.png")
                return

        try:
            cookie_btn = page.query_selector("#onetrust-accept-btn-handler")
            if cookie_btn:
                cookie_btn.click()
                time.sleep(0.5)
        except Exception:
            pass

        try:
            page.wait_for_selector("input[name='phone']", timeout=12000)
            page.fill("input[name='phone']", full_phone)
            time.sleep(0.5)
            lanjut_btn = page.query_selector("button:has-text('Lanjut')")
            if lanjut_btn:
                lanjut_btn.click()
        except Exception as e:
            if "/auth/login" not in page.url:
                existing_session = extract_browser_session(context, page, intercepted, raw_phone)
                if existing_session:
                    write_state(state_file, {"status": "already_authenticated", "session": existing_session})
                    return
            write_state(state_file, {"status": "error", "message": f"Gagal mengisi nomor telepon: {str(e)}"})
            debug_screenshot(page, "gobiz-login-error.png")
            return

        try:
            page.wait_for_selector("#auth-otp-input, input[name='otp']", timeout=15000)
            time.sleep(1)
            write_state(state_file, {"status": "otp_sent", "pid": os.getpid(), "phone": full_phone})
            debug_screenshot(page, "gobiz-otp-sent.png")
            print("OTP_SENT_READY")
            sys.stdout.flush()
        except Exception as e:
            error_el = page.query_selector("[role='alert'], .error, .sc-fznZeY")
            msg = error_el.inner_text() if error_el else str(e)
            write_state(state_file, {"status": "error", "message": f"Gagal meminta OTP: {msg}"})
            debug_screenshot(page, "gobiz-login-error.png")
            return

        start_wait = time.time()
        otp_received = None
        while time.time() - start_wait < 180:
            cmd = read_and_consume_command(command_file)
            if cmd and cmd.get("otp"):
                otp_received = str(cmd.get("otp")).strip()
                break
            time.sleep(0.5)

        if not otp_received:
            write_state(state_file, {"status": "error", "message": "Waktu verifikasi OTP habis (timeout 3 menit)"})
            return

        write_state(state_file, {"status": "verifying"})

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

            verify_btn = (
                page.query_selector("#verify-otp-button")
                or page.query_selector("button:has-text('Masuk')")
                or page.query_selector("button[type='submit']")
            )
            if verify_btn:
                verify_btn.click()
            else:
                page.keyboard.press("Enter")

            time.sleep(5)

            session = extract_browser_session(context, page, intercepted, raw_phone)
            if session:
                write_state(state_file, {"status": "success", "session": session})
                debug_screenshot(page, "gobiz-login-success.png")
                print("LOGIN_SUCCESS")
                return

            err_el = page.query_selector("[role='alert'], .error, .sc-fznZeY, .toast")
            err_text = err_el.inner_text() if err_el else "Kode OTP salah atau tidak valid"
            debug_screenshot(page, "gobiz-otp-error.png")
            write_state(state_file, {"status": "error", "message": err_text})

        except Exception as e:
            debug_screenshot(page, "gobiz-otp-error.png")
            write_state(state_file, {"status": "error", "message": f"Kesalahan verifikasi OTP: {str(e)}"})


if __name__ == "__main__":
    main()
