#!/usr/bin/env bash
# ==============================================================================
# KaiGoBiz One-Click Automated Installer & Setup Script
# Works on Ubuntu 20.04+, Debian 11+, and similar Linux distributions.
# ==============================================================================

set -euo pipefail

# Text styling
BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${CYAN}${BOLD}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}${BOLD}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}${BOLD}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}${BOLD}[ERROR]${NC} $1"
}

banner() {
    echo -e "${CYAN}${BOLD}"
    cat << "EOF"
  _  __      _  _____        ____  _     
 | |/ /     (_)/ ____|      |  _ \(_)    
 | ' / __ _  _| |  __  ___  | |_) |_ ____
 |  < / _` || | | |_ |/ _ \ |  _ <| |_  /
 | . \ (_| || | |__| | (_) || |_) | |/ / 
 |_|\_\__,_||_|\_____|\___/ |____/|_/___|
EOF
    echo -e "${NC}"
    echo -e "${BOLD}High-Performance GoBiz Payment Gateway & Dynamic QRIS Engine${NC}"
    echo -e "Automated Installer & Deployment Script\n"
}

banner

# 1. Determine Working Directory
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${REPO_DIR}"

if [[ ! -f "${TARGET_DIR}/package.json" ]]; then
    TARGET_DIR="/opt/kaigobiz"
    log_info "No local KaiGoBiz repository found in current directory."
    log_info "Target installation directory: ${TARGET_DIR}"

    if [[ ! -d "${TARGET_DIR}" ]]; then
        log_info "Cloning KaiGoBiz from GitHub..."
        git clone https://github.com/kaivyy/kaigobiz.git "${TARGET_DIR}"
    else
        log_info "Updating existing repository in ${TARGET_DIR}..."
        git -C "${TARGET_DIR}" pull || true
    fi
fi

cd "${TARGET_DIR}"

# 2. Check and Install System Dependencies
log_info "Checking system dependencies..."
if command -v apt-get &> /dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    log_info "Updating package lists..."
    apt-get update -qq || true
    log_info "Installing prerequisites: curl, git, python3, python3-pip, libzbar0, poppler-utils..."
    apt-get install -y -qq curl git python3 python3-pip libzbar0 poppler-utils libgl1-mesa-glx libglib2.0-0 > /dev/null 2>&1 || true
else
    log_warn "Non-Debian/Ubuntu OS detected. Please ensure curl, git, python3, and libzbar are installed manually."
fi

# 3. Check and Setup Node.js (Require Node.js >= 18)
NODE_INSTALLED=false
if command -v node &> /dev/null; then
    NODE_MAJOR=$(node -v | cut -d'.' -f1 | tr -d 'v')
    if [[ "${NODE_MAJOR}" -ge 18 ]]; then
        NODE_INSTALLED=true
        log_success "Found Node.js $(node -v) (Satisfies >= v18 requirement)"
    else
        log_warn "Installed Node.js $(node -v) is older than v18."
    fi
fi

if [[ "${NODE_INSTALLED}" = false ]]; then
    log_info "Installing Node.js 20 LTS from NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    log_success "Node.js $(node -v) and npm $(npm -v) installed successfully."
fi

# 4. Install PM2 Globally
if ! command -v pm2 &> /dev/null; then
    log_info "Installing PM2 process manager globally..."
    npm install -g pm2
    log_success "PM2 installed successfully."
else
    log_success "Found PM2 $(pm2 -v)"
fi

# 5. Install Python QR Decoding Modules
log_info "Configuring Python QR extraction modules..."
PIP_ARGS="--quiet --no-cache-dir"
if python3 -m pip install --help | grep -q -- "--break-system-packages"; then
    PIP_ARGS="${PIP_ARGS} --break-system-packages"
fi

python3 -m pip install ${PIP_ARGS} zxing-cpp pyzbar opencv-python-headless pillow pillow-heif numpy > /dev/null 2>&1 || {
    log_warn "Some Python packages failed to install. QR decoding will fall back to client-side jsQR."
}

# 6. Install Project Dependencies
log_info "Installing project npm dependencies..."
npm install --silent

# 7. Setup Configuration (.env)
if [[ ! -f ".env" ]]; then
    log_info "Creating default .env configuration file..."
    cat << "EOF" > .env
PORT=3636
NODE_ENV=production
# Default static QRIS template (can be updated via Dashboard)
STATIC_QRIS_TEMPLATE=00020101021126390013ID.GO-JEK.WWW01189360091430000000005204581253033605802ID5914KAI GOBIZ SHOP6007JAKARTA63045B63
EOF
    log_success "Created .env with default settings (Port 3636)."
else
    log_info "Existing .env file preserved."
fi

# 8. Build Production Assets (Dashboard, Widget, Server bundle)
log_info "Building production bundles (Vite dashboard and kaigobiz.js widget)..."
npm run build

# 9. Configure and Start PM2 Process
log_info "Configuring PM2 service..."
PM2_NAME="kaigobiz"

if pm2 list | grep -q "${PM2_NAME}"; then
    log_info "Restarting existing PM2 process: ${PM2_NAME}..."
    pm2 restart "${PM2_NAME}"
else
    log_info "Registering and starting new PM2 process: ${PM2_NAME}..."
    pm2 start "npm run server" --name "${PM2_NAME}"
fi

pm2 save > /dev/null 2>&1 || true

# Try to detect server public IP
SERVER_IP=$(curl -s -m 3 https://icanhazip.com || curl -s -m 3 https://ifconfig.me || echo "YOUR_SERVER_IP")
PORT_NUM="3636"
if grep -q "PORT=" .env; then
    PORT_NUM=$(grep "PORT=" .env | cut -d'=' -f2 | tr -d ' ' | tr -d '"')
fi

# 10. Summary and Success Message
echo ""
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD}           KaiGoBiz Has Been Successfully Installed!            ${NC}"
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo ""
echo -e "  ${BOLD}Web Dashboard:${NC}    http://${SERVER_IP}:${PORT_NUM} (or http://localhost:${PORT_NUM})"
echo -e "  ${BOLD}Hosted Checkout:${NC}  http://${SERVER_IP}:${PORT_NUM}/pay/:paymentId"
echo -e "  ${BOLD}Embed Widget:${NC}     http://${SERVER_IP}:${PORT_NUM}/kaigobiz.js"
echo ""
echo -e "  ${BOLD}Helpful PM2 Commands:${NC}"
echo -e "    - View live logs:     ${CYAN}pm2 logs kaigobiz${NC}"
echo -e "    - Check status:       ${CYAN}pm2 status${NC}"
echo -e "    - Restart service:    ${CYAN}pm2 restart kaigobiz${NC}"
echo -e "    - Stop service:       ${CYAN}pm2 stop kaigobiz${NC}"
echo ""
echo -e "  ${BOLD}Next Step:${NC} Open the Web Dashboard in your browser to log into your GoBiz"
echo -e "  merchant account and configure your static QRIS template."
echo -e "${GREEN}${BOLD}================================================================${NC}\n"
