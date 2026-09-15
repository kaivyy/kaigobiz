import sys
import os
import subprocess
import cv2
import numpy as np
from PIL import Image, ImageOps

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

try:
    import zxingcpp
except Exception:
    zxingcpp = None

try:
    from pyzbar.pyzbar import decode as pyzbar_decode, ZBarSymbol
except Exception:
    pyzbar_decode = None


def extract_qris_candidate(text: str):
    """
    If the decoded string contains '000201', extract starting from '000201'.
    """
    if not text:
        return None
    text = text.strip()
    idx = text.find("000201")
    if idx != -1:
        return text[idx:]
    return text


def try_all_engines(img_np):
    """
    Attempts decoding using ZXing, PyZBar, and OpenCV QRCodeDetector.
    """
    if img_np is None or img_np.size == 0:
        return None

    # 1. Google ZXing-CPP (Superior for phone screens, center logos, skewed perspective)
    if zxingcpp is not None:
        try:
            results = zxingcpp.read_barcodes(
                img_np,
                formats=zxingcpp.BarcodeFormat.QRCode,
                try_rotate=True,
                try_downscale=True,
                try_invert=True
            )
            for r in results:
                c = extract_qris_candidate(r.text)
                if c:
                    return c
        except Exception:
            pass

    # 2. PyZBar
    if pyzbar_decode is not None:
        try:
            decoded = pyzbar_decode(img_np, symbols=[ZBarSymbol.QRCODE])
            for item in decoded:
                data = item.data.decode("utf-8", errors="ignore").strip()
                c = extract_qris_candidate(data)
                if c:
                    return c
        except Exception:
            pass

    # 3. OpenCV QRCodeDetector
    try:
        detector = cv2.QRCodeDetector()
        val, _, _ = detector.detectAndDecode(img_np)
        if val and val.strip():
            return extract_qris_candidate(val.strip())
    except Exception:
        pass

    return None


def scan_image_pipeline(img_rgb):
    """
    Runs multi-filter, multi-scale, and smart-cropping pipeline on the image.
    """
    h, w = img_rgb.shape[:2]
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY)

    # 1. Try full image (RGB & Grayscale)
    res = try_all_engines(img_rgb)
    if res:
        return res
    res = try_all_engines(gray)
    if res:
        return res

    # 2. Inverted Gray (for dark mode or white QR on dark background)
    inverted = cv2.bitwise_not(gray)
    res = try_all_engines(inverted)
    if res:
        return res

    # 3. Smart Crops for mobile screenshots / posters
    crops = []
    # If mobile portrait screenshot (tall aspect ratio)
    if h > 1.2 * w:
        crops.append(gray[int(h * 0.10):int(h * 0.70), :])
        crops.append(gray[int(h * 0.15):int(h * 0.85), :])
        crops.append(gray[int(h * 0.20):int(h * 0.65), int(w * 0.05):int(w * 0.95)])
    else:
        crops.append(gray[int(h * 0.05):int(h * 0.95), int(w * 0.05):int(w * 0.95)])
        crops.append(gray[int(h * 0.15):int(h * 0.85), int(w * 0.15):int(w * 0.85)])

    for crop in crops:
        if crop is not None and crop.size > 0:
            res = try_all_engines(crop)
            if res:
                return res

    # 4. Multi-scale resizing
    for target_dim in [1200, 800, 600]:
        max_dim = max(h, w)
        if max_dim > target_dim:
            scale = float(target_dim) / max_dim
            small = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            res = try_all_engines(small)
            if res:
                return res

    # 5. Enhanced filtering (CLAHE for glare/shadows, Otsu, Sharpening)
    try:
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        clahe_img = clahe.apply(gray)
        res = try_all_engines(clahe_img)
        if res:
            return res
    except Exception:
        pass

    try:
        _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        res = try_all_engines(otsu)
        if res:
            return res
    except Exception:
        pass

    # Morphological closing (fixes broken QR dots)
    try:
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        closed = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, kernel)
        res = try_all_engines(closed)
        if res:
            return res
    except Exception:
        pass

    return None


def load_image_safely(file_path: str):
    """
    Loads any image format (PNG, JPG, WEBP, HEIC, PDF) with proper alpha handling and EXIF orientation.
    """
    # Check if PDF
    try:
        with open(file_path, "rb") as f:
            header = f.read(5)
            if header.startswith(b"%PDF"):
                prefix = file_path + "_page"
                subprocess.run(
                    ["pdftoppm", "-png", "-r", "200", "-f", "1", "-l", "1", file_path, prefix],
                    check=True,
                    timeout=10,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
                for candidate in [f"{prefix}-1.png", f"{prefix}-01.png", f"{prefix}-001.png"]:
                    if os.path.exists(candidate):
                        with Image.open(candidate) as page_img:
                            res = np.array(page_img.convert("RGB"))
                        try:
                            os.unlink(candidate)
                        except Exception:
                            pass
                        return res
    except Exception:
        pass

    # Standard PIL loading
    try:
        with Image.open(file_path) as pil_img:
            # Auto-rotate EXIF
            pil_img = ImageOps.exif_transpose(pil_img)

            # Properly handle alpha/transparency by compositing on white background
            if pil_img.mode in ("RGBA", "LA") or (pil_img.mode == "P" and "transparency" in pil_img.info):
                alpha = pil_img.convert("RGBA").split()[-1]
                bg = Image.new("RGBA", pil_img.size, (255, 255, 255, 255))
                bg.paste(pil_img, mask=alpha)
                pil_img = bg.convert("RGB")
            elif pil_img.mode != "RGB":
                pil_img = pil_img.convert("RGB")

            return np.array(pil_img)
    except Exception:
        pass

    # OpenCV fallback
    try:
        bgr = cv2.imread(file_path, cv2.IMREAD_COLOR)
        if bgr is not None:
            return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    except Exception:
        pass

    return None


def main():
    if len(sys.argv) < 2:
        print("NO_QR_FOUND")
        sys.exit(0)

    file_path = sys.argv[1]
    if not os.path.exists(file_path):
        print("NO_QR_FOUND")
        sys.exit(0)

    img_rgb = load_image_safely(file_path)

    if img_rgb is not None:
        result = scan_image_pipeline(img_rgb)
        if result:
            print(result.strip())
            sys.exit(0)

    # 2. Final CLI Fallback: zbarimg
    try:
        cli_out = subprocess.run(
            ["zbarimg", "--raw", "-q", file_path],
            capture_output=True,
            text=True,
            timeout=5
        )
        if cli_out.returncode == 0 and cli_out.stdout:
            candidate = extract_qris_candidate(cli_out.stdout.strip())
            if candidate:
                print(candidate)
                sys.exit(0)
    except Exception:
        pass

    # No QR found
    print("NO_QR_FOUND")
    sys.exit(0)


if __name__ == "__main__":
    main()
