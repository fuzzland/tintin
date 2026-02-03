FROM ubuntu:24.04

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# Configure Aliyun mirror (HTTP) for Ubuntu 24.04 using DEB822 format.
RUN cat <<'EOF' > /etc/apt/sources.list.d/ubuntu.sources
Types: deb
URIs: http://mirrors.aliyun.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://mirrors.aliyun.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

# Install base networking and crypto tools.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    wget \
  && rm -rf /var/lib/apt/lists/*

# Add NodeSource repository.
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list

# Base OS packages: GUI stack, tooling, and runtime prerequisites.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    git \
    nodejs \
    xvfb \
    x11vnc \
    xdotool \
    xfce4 \
    x11-xserver-utils \
    papirus-icon-theme \
    arc-theme \
    fonts-noto \
    fonts-noto-color-emoji \
    ripgrep \
    build-essential \
    dbus-x11 \
    colord \
    socat \
    scrot \
    sudo \
    tmux \
  && rm -rf /var/lib/apt/lists/*

# Install Chrome separately.
RUN wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb \
  && apt-get update \
  && apt-get install -y --no-install-recommends /tmp/chrome.deb \
  && rm -f /tmp/chrome.deb \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Reduce image size by removing docs and caches.
RUN rm -rf /usr/share/doc/* /usr/share/man/* /usr/share/locale/* /var/cache/apt/* /tmp/* /var/tmp/*

RUN mkdir -p /tmp/.X11-unix \
  && chown root:root /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix

# MCP toolchain: install all MCP-related npm packages at build time.
# Extend by editing MCP_NPM_PACKAGES (no runtime installs).
ARG PLAYWRIGHT_MCP_PACKAGE=@playwright/mcp@latest
ARG MCP_NPM_PACKAGES="${PLAYWRIGHT_MCP_PACKAGE}"
ENV MCP_NPM_PACKAGES=${MCP_NPM_PACKAGES}
ENV TINTIN_PLAYWRIGHT_MCP_PACKAGE=${PLAYWRIGHT_MCP_PACKAGE}
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
# Ensure globally installed Node modules are resolvable at runtime.
ENV NODE_PATH=/usr/lib/node_modules:/usr/local/lib/node_modules
# Explicit install at build time; runtime downloads disabled.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm config set fund false \
  && npm config set audit false \
  && npm config set update-notifier false \
  && npm i -g @openai/codex ${MCP_NPM_PACKAGES} \
  && NPM_ROOT="$(npm root -g)" \
  && PW_VERSION="$(NODE_PATH="${NPM_ROOT}" node -e "const pkg=require('@playwright/mcp/package.json'); const deps=pkg.dependencies || {}; process.stdout.write(deps.playwright || deps['playwright-core'] || '');")" \
  && if [ -z "${PW_VERSION}" ]; then \
    echo "Unable to detect Playwright version from @playwright/mcp; aborting build." >&2; \
    exit 1; \
  fi \
  && npm i -g "playwright@${PW_VERSION}" \
  && echo "Preinstalling Playwright browsers for ${PW_VERSION}" \
  && mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}" \
  && PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH}" npx --yes "playwright@${PW_VERSION}" install --with-deps \
  && chmod -R 755 "${PLAYWRIGHT_BROWSERS_PATH}" \
  && npm cache clean --force \
  && rm -rf /root/.npm /root/.cache /tmp/* /var/tmp/*

# Claude Code (official installer).
RUN curl -fsSL https://claude.ai/install.sh | bash

# Auxiliary tools.
RUN wget -q https://github.com/tsl0922/ttyd/releases/download/1.7.3/ttyd.x86_64 -O /usr/local/bin/ttyd \
  && chmod +x /usr/local/bin/ttyd
RUN curl -fsSL https://code-server.dev/install.sh | sh \
  && rm -rf /root/.cache /tmp/* /var/tmp/*

# VS Code remote agent compatibility (vsda stub).
COPY vsda-stub/vsda.js /tmp/vsda.js
COPY vsda-stub/vsda_bg.wasm /tmp/vsda_bg.wasm
RUN mkdir -p /usr/lib/code-server/lib/vscode/node_modules/vsda/rust/web \
  && mkdir -p /usr/lib/code-server/lib/vscode/node_modules/vsda/dist \
  && cp /tmp/vsda.js /usr/lib/code-server/lib/vscode/node_modules/vsda/dist/vsda.js \
  && cp /tmp/vsda_bg.wasm /usr/lib/code-server/lib/vscode/node_modules/vsda/rust/web/vsda_bg.wasm \
  && cp /tmp/vsda.js /usr/lib/code-server/lib/vscode/node_modules/vsda/rust/web/vsda.js \
  && rm -f /tmp/vsda.js /tmp/vsda_bg.wasm

COPY tintin-log-agent.js /usr/local/bin/tintin-log-agent
COPY tintin-chatgpt-proxy.js /usr/local/bin/tintin-chatgpt-proxy.js
COPY tintin-helper-lib.js /usr/local/bin/tintin-helper-lib.js
COPY tintin-mcp-bootstrap.js /usr/local/bin/tintin-mcp-bootstrap.js
COPY code /usr/local/bin/code
COPY site /usr/local/bin/site
COPY static-deploy /usr/local/bin/static-deploy
COPY dynamic-deploy /usr/local/bin/dynamic-deploy
RUN chmod +x \
  /usr/local/bin/tintin-log-agent \
  /usr/local/bin/tintin-chatgpt-proxy.js \
  /usr/local/bin/tintin-mcp-bootstrap.js \
  /usr/local/bin/code \
  /usr/local/bin/site \
  /usr/local/bin/static-deploy \
  /usr/local/bin/dynamic-deploy

RUN id ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu \
  && mkdir -p /home/ubuntu/.image \
  && chown -R ubuntu:ubuntu /home/ubuntu \
  && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu \
  && chmod 0440 /etc/sudoers.d/ubuntu \
  && chsh -s /bin/bash ubuntu

USER ubuntu

ENV PATH="/home/ubuntu/.local/bin:${PATH}"
ENV DISPLAY=:99
ENV WIDTH=1920
ENV HEIGHT=1080

# Configure XFCE theme.
RUN mkdir -p /home/ubuntu/.config/xfce4/xfconf/xfce-perchannel-xml \
  && cat <<'XML' > /home/ubuntu/.config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml
<?xml version="1.0" encoding="UTF-8"?>

<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="Arc-Dark"/>
    <property name="IconThemeName" type="string" value="Papirus-Dark"/>
    <property name="EnableEventSounds" type="bool" value="false"/>
    <property name="EnableInputFeedbackSounds" type="bool" value="false"/>
  </property>
  <property name="Gtk" type="empty">
    <property name="CursorThemeName" type="string" value="default"/>
    <property name="CursorThemeSize" type="int" value="16"/>
    <property name="FontName" type="string" value="Noto Sans 10"/>
    <property name="MonospaceFontName" type="string" value="Noto Mono 10"/>
    <property name="IconSizes" type="string" value=""/>
    <property name="KeyThemeName" type="string" value=""/>
    <property name="ToolbarStyle" type="string" value="icons"/>
    <property name="ToolbarIconSize" type="int" value="2"/>
    <property name="MenuImages" type="bool" value="true"/>
    <property name="ButtonImages" type="bool" value="true"/>
    <property name="MenuBarAccel" type="string" value="F10"/>
  </property>
  <property name="Xft" type="empty">
    <property name="DPI" type="int" value="96"/>
    <property name="Antialias" type="int" value="1"/>
    <property name="Hinting" type="int" value="1"/>
    <property name="HintStyle" type="string" value="hintslight"/>
    <property name="RGBA" type="string" value="rgb"/>
  </property>
</channel>
XML

# Create startup script.
RUN cat <<'SCRIPT' > /home/ubuntu/start.sh
#!/usr/bin/env bash

DISPLAY=${DISPLAY:-:99}
WIDTH=${WIDTH:-1920}
HEIGHT=${HEIGHT:-1080}
ENABLE_VNC=${ENABLE_VNC:-0}
XVFB_STARTUP_TIMEOUT=${XVFB_STARTUP_TIMEOUT:-30}
case "$WIDTH" in (''|*[!0-9]*) WIDTH=1920;; esac
case "$HEIGHT" in (''|*[!0-9]*) HEIGHT=1080;; esac
export DISPLAY

log() {
  echo "[$(date -Iseconds 2>/dev/null || date)] $*" >&2
}

SUDO=""
if command -v sudo >/dev/null 2>&1; then
  if sudo -n true >/dev/null 2>&1; then
    SUDO="sudo -n"
  fi
fi

run_as_root() {
  if [ -n "$SUDO" ]; then
    $SUDO "$@"
    return $?
  fi
  return 1
}

step() {
  local name="$1"
  shift
  local start=$SECONDS
  log "start: ${name}"
  "$@"
  local rc=$?
  log "done: ${name} rc=${rc} dt=$((SECONDS - start))s"
  return $rc
}

step_bg() {
  local name="$1"
  shift
  local start=$SECONDS
  log "start: ${name}"
  "$@" &
  local pid=$!
  log "done: ${name} pid=${pid} dt=$((SECONDS - start))s"
}

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
if ! mkdir -p /tmp/.X11-unix 2>/dev/null; then
  run_as_root mkdir -p /tmp/.X11-unix || true
fi
if [ -d /tmp/.X11-unix ] && [ ! -w /tmp/.X11-unix ]; then
  run_as_root chmod 1777 /tmp/.X11-unix || true
fi

log "Starting Xvfb on ${DISPLAY} (${WIDTH}x${HEIGHT}x24)"
Xvfb "${DISPLAY}" -screen 0 "${WIDTH:-1920}x${HEIGHT:-1080}x24" -ac +extension RANDR >/home/ubuntu/.image/xvfb.log 2>&1 &
XVFB_PID=$!
log "done: Xvfb pid=${XVFB_PID} dt=0s"

t_wait_start=$SECONDS
log "start: wait for Xvfb"
XVFB_READY=0
for i in $(seq 1 $((XVFB_STARTUP_TIMEOUT * 2))); do
  if ! kill -0 "${XVFB_PID}" >/dev/null 2>&1; then
    log "Xvfb process exited early (pid=${XVFB_PID})"
    break
  fi
  if [ -S "/tmp/.X11-unix/X99" ]; then
    XVFB_READY=1
    break
  fi
  if command -v xdpyinfo >/dev/null 2>&1; then
    if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
      XVFB_READY=1
      break
    fi
  fi
  sleep 0.5
done
log "done: wait for Xvfb ready=${XVFB_READY} dt=$((SECONDS - t_wait_start))s"

if command -v dbus-launch >/dev/null 2>&1; then
  t_dbus_start=$SECONDS
  log "start: dbus-launch"
  eval "$(dbus-launch --sh-syntax)"
  log "done: dbus-launch rc=$? dt=$((SECONDS - t_dbus_start))s"
fi

if [ "$XVFB_READY" -eq 1 ]; then
  # Start XFCE session.
  step_bg "XFCE" startxfce4 >/home/ubuntu/xfce.log 2>&1
  step "XFCE warmup" sleep 2

  # Set theme and appearance (best-effort).
  t_theme_start=$SECONDS
  log "start: XFCE theme"
  xfconf-query -c xsettings -p /Net/ThemeName -s "Arc-Dark" >/dev/null 2>&1 || true
  xfconf-query -c xsettings -p /Net/IconThemeName -s "Papirus-Dark" >/dev/null 2>&1 || true
  xfconf-query -c xfwm4 -p /general/theme -s "Arc-Dark" >/dev/null 2>&1 || true
  log "done: XFCE theme dt=$((SECONDS - t_theme_start))s"
else
  log "Xvfb failed to start; continuing in headless mode."
  if [ -s /home/ubuntu/.image/xvfb.log ]; then
    log "Xvfb log tail:"
    tail -n 200 /home/ubuntu/.image/xvfb.log >&2 || true
  fi
  log "Xvfb diagnostics:"
  if command -v ps >/dev/null 2>&1; then
    ps -p "${XVFB_PID}" -o pid,ppid,stat,etime,cmd >&2 || true
  fi
  ls -la /tmp/.X11-unix >&2 || true
fi

# Start system dbus (best-effort) to reduce Chrome warnings.
if command -v dbus-daemon >/dev/null 2>&1; then
  if ! mkdir -p /run/dbus 2>/dev/null; then
    run_as_root mkdir -p /run/dbus || true
  fi
  t_dbusd_start=$SECONDS
  log "start: dbus-daemon"
  if ! run_as_root dbus-daemon --system --fork >/home/ubuntu/.image/dbus.log 2>&1; then
    dbus-daemon --system --fork >/home/ubuntu/.image/dbus.log 2>&1 || true
  fi
  log "done: dbus-daemon rc=$? dt=$((SECONDS - t_dbusd_start))s"
fi

# Start Chrome CDP endpoint.
CHROME_ARGS=(
  --no-sandbox
  --disable-setuid-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --remote-debugging-port=9222
  --no-first-run
  --no-default-browser-check
  --user-data-dir=/home/ubuntu/.chrome
)
if [ "$XVFB_READY" -ne 1 ]; then
  CHROME_ARGS+=(--headless=new)
fi
step_bg "Chrome" google-chrome "${CHROME_ARGS[@]}"

# Forward CDP port.
step_bg "CDP forward" socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222

if [ "$XVFB_READY" -eq 1 ] && [ "$ENABLE_VNC" = "1" ]; then
  step_bg "x11vnc" x11vnc -display "${DISPLAY}" -forever -nopw -shared >/home/ubuntu/.image/x11vnc.log 2>&1
fi
step_bg "code-server" code-server --auth none --bind-addr 0.0.0.0:8080
step_bg "ttyd" ttyd -p 7681 bash

# Keep container alive.
log "startup complete; entering sleep"
sleep infinity
SCRIPT

RUN chmod +x /home/ubuntu/start.sh

EXPOSE 8080 7681 9222 9223 11000

CMD ["bash", "-c", "cd /home/ubuntu/ && ./start.sh"]
