FROM ubuntu:24.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies + Chrome, then clean apt caches
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    xvfb \
    x11vnc \
    xdotool \
    wget \
    curl \
    git \
    nodejs \
    npm \
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
    && wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && apt-get -y -f install \
    && rm -f /tmp/chrome.deb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Codex + Claude Code CLIs (Node 18+ required for Claude Code)
RUN npm i -g @openai/codex @anthropic-ai/claude-code \
    && npm cache clean --force \
    && rm -rf /root/.npm

# Install ttyd
RUN wget -q https://github.com/tsl0922/ttyd/releases/download/1.7.3/ttyd.x86_64 -O /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

# Install code-server (VS Code Web)
RUN curl -fsSL https://code-server.dev/install.sh | sh \
    && rm -rf /root/.cache /tmp/* /var/tmp/*

RUN mkdir -p /home/ubuntu/.image
RUN chown -R ubuntu:ubuntu /home/ubuntu
RUN chown -R ubuntu:ubuntu /home/ubuntu/.image
USER ubuntu

# Add .local/bin to PATH
ENV PATH="/home/ubuntu/.local/bin:${PATH}"

# Set up display environment variables
ENV DISPLAY=:99
ENV WIDTH=1920
ENV HEIGHT=1080

# Configure XFCE theme
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

# Create startup script
RUN echo '#!/bin/bash\n\
Xvfb :99 -screen 0 ${WIDTH}x${HEIGHT}x24 &\n\
sleep 1\n\
export DISPLAY=:99\n\
# Start XFCE session\n\
startxfce4 &\n\
sleep 5\n\
# Set theme and appearance\n\
xfconf-query -c xsettings -p /Net/ThemeName -s "Arc-Dark"\n\
xfconf-query -c xsettings -p /Net/IconThemeName -s "Papirus-Dark"\n\
xfconf-query -c xfwm4 -p /general/theme -s "Arc-Dark"\n\
# Start Chrome CDP endpoint\n\
google-chrome \\\n  --no-sandbox \\\n  --disable-setuid-sandbox \\\n  --disable-dev-shm-usage \\\n  --disable-gpu \\\n  --remote-debugging-port=9222 \\\n  --no-first-run \\\n  --no-default-browser-check \\\n  --user-data-dir=/home/ubuntu/.chrome &\n\
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &\n\
x11vnc -display :99 -forever -nopw &\n\
code-server --auth none --bind-addr 0.0.0.0:8080 &\n\
ttyd -p 7681 bash &\n\
# Keep container alive\n\
sleep infinity\n\
\n' > /home/ubuntu/start.sh \
    && chmod +x /home/ubuntu/start.sh

EXPOSE 8080 7681 9222 9223

CMD ["bash", "-c", "cd /home/ubuntu/ && ./start.sh"]
