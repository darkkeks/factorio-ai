#!/bin/sh
mkdir -p "$HOME/services" "$HOME/logs" "$HOME/.supervisor" "$HOME/.local/bin"
exec supervisord -c /etc/supervisor/supervisord.conf
