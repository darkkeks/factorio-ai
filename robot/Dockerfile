# «Машина» робота: здесь живёт Claude Code и всё, что он запускает.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client xz-utils unzip zip bzip2 jq ripgrep less procps psmisc \
      iproute2 iputils-ping dnsutils netcat-openbsd tmux vim-tiny \
      python3 python3-venv python3-pip build-essential supervisor locales \
    && sed -i 's/^# *\(en_US.UTF-8\|ru_RU.UTF-8\)/\1/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_VERSION=2.1.325
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION}
# uid 1000 уже занят пользователем node — переименовываем его, чтобы файлы на хосте принадлежали darkkeks.
RUN usermod -l robot -d /home/robot -m node && groupmod -n robot node
COPY supervisord.conf /etc/supervisor/supervisord.conf
# Политика Claude Code: принадлежит root, робот её изменить не может. Разрешена только одна модель.
COPY managed-settings.json /etc/claude-code/managed-settings.json
COPY entrypoint.sh /entrypoint.sh
ENV LANG=ru_RU.UTF-8 HOME=/home/robot DISABLE_AUTOUPDATER=1 PIP_BREAK_SYSTEM_PACKAGES=1 \
    NPM_CONFIG_PREFIX=/home/robot/.local PATH=/home/robot/.local/bin:/home/robot/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER robot
WORKDIR /home/robot
ENTRYPOINT ["/entrypoint.sh"]
