#!/usr/bin/env bash
# Ubuntu 24.04 host with verified spare memory. clamd never listens on a public interface.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root on the scanner host'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y clamav-daemon clamav-freshclam python3
systemctl stop clamav-daemon.socket clamav-daemon.service clamav-freshclam.service
systemctl disable clamav-daemon.socket
cat > /etc/clamav/clamd.conf <<'EOF'
Foreground yes
User clamav
LocalSocket /run/clamav/clamd.ctl
LocalSocketMode 660
TCPSocket 3310
TCPAddr 127.0.0.1
DatabaseDirectory /var/lib/clamav
LogTime yes
MaxThreads 1
MaxQueue 4
ReadTimeout 60
CommandReadTimeout 10
SendBufTimeout 500
StreamMaxLength 25M
MaxFileSize 25M
MaxScanSize 100M
MaxRecursion 16
MaxFiles 10000
MaxScanTime 40000
AlertExceedsMax yes
AlertEncrypted yes
ConcurrentDatabaseReload no
SelfCheck 60
EOF
install -m 0644 "$(dirname "$0")/clamav-daemon.service" /etc/systemd/system/clamav-daemon.service
install -m 0755 "$(dirname "$0")/health.py" /usr/local/sbin/absolute-clam-health
cat > /etc/systemd/system/absolute-clam-health.service <<'EOF'
[Unit]
Description=Stop malware scanning when loaded signatures are stale or scanner is unhealthy
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/absolute-clam-health
EOF
cat > /etc/systemd/system/absolute-clam-health.timer <<'EOF'
[Unit]
Description=Check ClamAV availability and signature freshness every minute
[Timer]
OnBootSec=120
OnUnitActiveSec=60
[Install]
WantedBy=timers.target
EOF
mkdir -p /etc/systemd/system/clamav-freshclam.service.d
cat > /etc/systemd/system/clamav-freshclam.service.d/absolute.conf <<'EOF'
[Service]
MemoryMax=1G
CPUQuota=50%
EOF
# Freshclam is the distribution-managed updater; keep its signature verification enabled.
systemd-run --wait --collect --property=MemoryMax=1G --property=CPUQuota=50% /usr/bin/freshclam
systemctl daemon-reload
systemctl enable --now clamav-freshclam.service clamav-daemon.service absolute-clam-health.timer

# The distro service enables its socket through Also=. Keep socket activation
# disabled so the freshness watchdog owns whether the daemon can run.
systemctl disable --now clamav-daemon.socket
systemctl mask clamav-daemon.socket
