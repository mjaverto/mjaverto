#!/bin/zsh
# Installs the weekly profile-README job as a launchd agent (com.mjaverto.profile-readme).
# Runs Mondays 07:17 local: scripts/refresh.sh inside its own clone (~/.local/share/profile-readme).
# Log: ~/Library/Logs/profile-readme.log
# Usage: scripts/install-launchd.sh             install or reload
#        scripts/install-launchd.sh --uninstall remove the job (keeps clone and log)
#        scripts/install-launchd.sh --print     print the plist, touch nothing
set -euo pipefail
# ponytail: HOME limited to [A-Za-z0-9._/-], ceiling: spaces, & and < in HOME, upgrade: XML-escape and quote
home_re='^[A-Za-z0-9._/-]+$'
[[ $HOME =~ $home_re ]] || { echo "unsupported HOME path: $HOME" >&2; exit 1; }
self=$0
usage() { echo "usage: $self [--uninstall|--print]" >&2; }
(( $# <= 1 )) || { usage; exit 2; }
label=com.mjaverto.profile-readme
plist=$HOME/Library/LaunchAgents/$label.plist
clone=$HOME/.local/share/profile-readme
log=$HOME/Library/Logs/profile-readme.log
domain=gui/$(id -u)

plist_xml() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>date &amp;&amp; $clone/scripts/refresh.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>17</integer>
  </dict>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
}

case "${1-install}" in
  --print) plist_xml ;;
  --uninstall)
    launchctl bootout $domain/$label 2>/dev/null || true
    rm -f $plist ;;
  install)
    [ -d $clone/.git ] || git clone -q https://github.com/mjaverto/mjaverto.git $clone
    [ -x "$clone/scripts/refresh.sh" ] || { echo "$clone/scripts/refresh.sh missing or not executable (merge to main first)" >&2; exit 1; }
    plist_xml > $plist
    plutil -lint $plist
    launchctl bootout $domain/$label 2>/dev/null || true
    launchctl bootstrap $domain $plist
    echo "installed; run now with: launchctl kickstart -k $domain/$label" ;;
  *) usage; exit 2 ;;
esac
